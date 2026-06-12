/**
 * Periodic pull loop against a GitHub-style JSON REST API.
 *
 * Why this is here:
 *   - The executor's `httpFetch` is UTF-8-only, so the binary
 *     Git smart-protocol cannot survive the round-trip.
 *   - GitHub's REST API exposes refs / commits / trees / blobs as
 *     JSON with blob content base64-encoded — every byte stays
 *     valid UTF-8 on the wire. This module uses that path.
 *
 * The loop is a chained `setTimeout` (not `setInterval`) so a slow
 * pull can never overlap itself, and `stop()` is unambiguous.
 *
 * Pulls collapse into a single local commit per tick: any link added
 * remotely since the last pull becomes an addition, any link removed
 * remotely becomes a removal, and `operations.commit` produces one
 * local commit with the resulting diff. Local SHAs are independent
 * from remote SHAs; UIs that need to see specific remote-side state
 * can use `git-state-at(<remote-sha>)` once we expose remote SHAs.
 */

import * as ops from "./operations.js";
import * as store from "./store.js";
import type { GitFs } from "./fs-adapter.js";
import { deserializeLink, linkHashFromPath } from "./encoding.js";
import type { LinkExpression, PerspectiveDiff } from "./types.js";
import type { GitHubProvider } from "./providers/github.js";

// ---------------------------------------------------------------------------
// Tracking persisted alongside the cache
// ---------------------------------------------------------------------------

const REMOTE_SHA_KEY = "cache/remote-sha";
const REMOTE_ETAG_KEY = "cache/remote-etag";

export function getRemoteSha(): string | null {
    return store.getStorageRaw(REMOTE_SHA_KEY);
}

export function setRemoteSha(sha: string): void {
    store.setStorageRaw(REMOTE_SHA_KEY, sha);
}

export function getRemoteEtag(): string | null {
    return store.getStorageRaw(REMOTE_ETAG_KEY);
}

export function setRemoteEtag(etag: string): void {
    store.setStorageRaw(REMOTE_ETAG_KEY, etag);
}

// ---------------------------------------------------------------------------
// Pull driver
// ---------------------------------------------------------------------------

export interface RemoteSyncOpts {
    provider: GitHubProvider;
    branch: string;
    intervalMs: number;
    fs: GitFs;
    agentDid: string;
}

export interface RemoteSyncHandle {
    stop(): void;
    pullOnce(): Promise<PerspectiveDiff>;
}

const EMPTY_DIFF: PerspectiveDiff = { additions: [], removals: [] };

/**
 * Run a single pull against the configured remote and apply the diff
 * locally. Returns the diff actually applied (empty if remote
 * unchanged or no link-set delta).
 */
export async function pullOnce(opts: RemoteSyncOpts): Promise<PerspectiveDiff> {
    const lastEtag = getRemoteEtag() ?? undefined;
    const refResp = await opts.provider.fetchRef(opts.branch, lastEtag);

    if (refResp.notModified) {
        return EMPTY_DIFF;
    }
    if (!refResp.sha) {
        return EMPTY_DIFF;
    }

    const remoteSha = refResp.sha;
    if (remoteSha === getRemoteSha()) {
        if (refResp.etag) setRemoteEtag(refResp.etag);
        return EMPTY_DIFF;
    }

    const commit = await opts.provider.fetchCommit(remoteSha);
    const tree = await opts.provider.fetchTreeRecursive(commit.treeSha);

    // Build the set of link hashes the remote currently has, by
    // scanning the tree for `links/<hash>.json` entries.
    const remoteHashes = new Set<string>();
    const fetchableByHash = new Map<string, { blobSha: string }>();
    for (const entry of tree.entries) {
        if (entry.type !== "blob") continue;
        const hash = linkHashFromPath(entry.path);
        if (!hash) continue;
        remoteHashes.add(hash);
        fetchableByHash.set(hash, { blobSha: entry.sha });
    }

    // Local set comes from the in-memory cache (the source of truth
    // until the host's File I/O extension is installed).
    const localHashes = new Set<string>();
    for (const link of store.allLinks().links) {
        localHashes.add(store.hashLink(link));
    }

    const additionHashes: string[] = [];
    const removalHashes: string[] = [];
    for (const h of remoteHashes) {
        if (!localHashes.has(h)) additionHashes.push(h);
    }
    for (const h of localHashes) {
        if (!remoteHashes.has(h)) removalHashes.push(h);
    }

    // Fetch each newly-needed blob in parallel; parse as LinkExpression.
    const additions: LinkExpression[] = [];
    if (additionHashes.length > 0) {
        const blobResults = await Promise.all(
            additionHashes.map(async (h) => {
                const target = fetchableByHash.get(h);
                if (!target) return null;
                try {
                    const blob = await opts.provider.fetchBlob(target.blobSha);
                    return deserializeLink(blob.content);
                } catch (_err) {
                    return null;
                }
            }),
        );
        for (const link of blobResults) {
            if (link) additions.push(link);
        }
    }

    const removals: LinkExpression[] = [];
    for (const h of removalHashes) {
        const link = store.getLink(h);
        if (link) removals.push(link);
    }

    if (additions.length === 0 && removals.length === 0) {
        // Remote moved but no link-set change (e.g. an empty commit on
        // the remote, or a rename we collapse out). Still record the
        // new tracking values.
        setRemoteSha(remoteSha);
        if (refResp.etag) setRemoteEtag(refResp.etag);
        return EMPTY_DIFF;
    }

    const diff: PerspectiveDiff = { additions, removals };
    await ops.commit({
        fs: opts.fs,
        diff,
        authorDid: opts.agentDid,
    });

    setRemoteSha(remoteSha);
    if (refResp.etag) setRemoteEtag(refResp.etag);

    return diff;
}

/**
 * Start a background loop that calls {@link pullOnce} every
 * `intervalMs` milliseconds. Returns a handle with `stop()` and a
 * direct `pullOnce()` so the `pull-now` interaction can trigger an
 * immediate pull without waiting for the next tick.
 *
 * The loop is fault-tolerant: errors are logged and swallowed so a
 * transient 429 or network blip does not break the chain.
 */
export function startRemoteSync(opts: RemoteSyncOpts): RemoteSyncHandle {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const scheduleNext = () => {
        if (stopped) return;
        timer = setTimeout(tick, opts.intervalMs);
    };

    const tick = async () => {
        if (stopped) return;
        try {
            await pullOnce(opts);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            try {
                console.warn(`[git-link-language] pull failed: ${message}`);
            } catch (_e) {
                // Swallow even the warn — we never want the tick to crash
            }
        }
        scheduleNext();
    };

    // First tick is scheduled rather than immediate so that boot
    // sequencing (cache population, etc.) finishes before the first
    // network call.
    scheduleNext();

    return {
        stop() {
            stopped = true;
            if (timer !== null) {
                clearTimeout(timer);
                timer = null;
            }
        },
        pullOnce: () => pullOnce(opts),
    };
}
