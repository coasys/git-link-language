/**
 * Language operations exposed via the `commit` and `sync` capabilities.
 *
 *   commit(diff)        — Apply a PerspectiveDiff: write/delete link files in
 *                         the working tree, stage them, create a Git commit,
 *                         update the cache, emit the diff.
 *   sync()              — Detect HEAD movement since the last observed state
 *                         (the user may have applied commits externally) and
 *                         emit the resulting PerspectiveDiff.
 *   render()            — Return the link-set as it currently is in the cache.
 *   currentRevision()   — Return the current HEAD SHA, or empty string.
 */

import * as gitops from "./git.js";
import type { GitFs } from "./fs-adapter.js";
import * as store from "./store.js";
import { getRuntime } from "./adapters.js";
import type {
    LinkExpression,
    Perspective,
    PerspectiveDiff,
    SHA,
} from "./types.js";
import { deserializeLink, serializeLink } from "./encoding.js";

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

export interface BootOpts {
    fs: GitFs;
    defaultBranch: string;
}

/**
 * Run once at language init: ensure the Git repo exists and the
 * cache is populated from the current HEAD.
 */
export async function boot(opts: BootOpts): Promise<void> {
    await gitops.ensureRepoInit(opts.fs, opts.defaultBranch);
    const head = await gitops.currentHead(opts.fs);
    if (head === null) {
        // Empty repo; nothing to populate
        return;
    }
    await rebuildCacheFromCommit(opts.fs, head);
    store.setRevision(head);
}

/**
 * Walk the link files at the given commit and re-populate the cache.
 * Used at boot, and after a destructive sync.
 */
async function rebuildCacheFromCommit(fs: GitFs, sha: SHA): Promise<void> {
    store.clearCache();
    const hashes = await gitops.listLinkHashesAt(fs, sha);
    for (const h of hashes) {
        const raw = await gitops.readLinkAt(fs, sha, h);
        if (!raw) continue;
        try {
            const link = deserializeLink(raw);
            store.putLinkWithHash(link, h);
        } catch (_err) {
            // Skip malformed link file
        }
    }
}

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

export interface CommitOpts {
    fs: GitFs;
    diff: PerspectiveDiff;
    authorDid: string;
}

export async function commit(opts: CommitOpts): Promise<string> {
    const { fs, diff, authorDid } = opts;

    if (diff.additions.length === 0 && diff.removals.length === 0) {
        // No-op commit — return current HEAD if available
        const head = await gitops.currentHead(fs);
        return head ?? "";
    }

    // 1. Hash links and update both the working tree and the cache
    const addHashes: string[] = [];
    for (const link of diff.additions) {
        const h = store.hashLink(link);
        await gitops.writeLinkFile(fs, h, serializeLink(link));
        store.putLinkWithHash(link, h);
        addHashes.push(h);
    }

    const removeHashes: string[] = [];
    for (const link of diff.removals) {
        const h = store.hashLink(link);
        await gitops.deleteLinkFile(fs, h);
        store.removeLinkByHash(h);
        removeHashes.push(h);
    }

    // 2. Git commit
    const sha = await gitops.commit(fs, {
        additions: addHashes,
        removals: removeHashes,
        author: gitops.authorFromDid(authorDid),
    });

    // 3. Track the new HEAD as last-synced
    store.setRevision(sha);

    // 4. Emit the diff to subscribers
    getRuntime().emitPerspectiveDiff(diff);

    return sha;
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

/**
 * Detect any HEAD movement since the last observed state and emit
 * the resulting diff. Useful when the user (or another process)
 * applies commits to the underlying repo externally — e.g. via the
 * Git CLI — and then calls sync() so AD4M picks the changes up.
 *
 * Note: this does NOT fetch from a remote. v1 cannot perform binary
 * HTTP, so automated remote sync is gated on a future host
 * enhancement. See spec §11.2.
 */
export interface SyncOpts {
    fs: GitFs;
}

export async function sync(opts: SyncOpts): Promise<PerspectiveDiff> {
    const head = await gitops.currentHead(opts.fs);
    if (head === null) {
        return { additions: [], removals: [] };
    }
    const lastSynced = store.getRevision();
    if (lastSynced === head) {
        return { additions: [], removals: [] };
    }

    const { additions: addHashes, removals: removeHashes } =
        await gitops.diffLinks(opts.fs, lastSynced, head);

    const additions: LinkExpression[] = [];
    for (const h of addHashes) {
        const raw = await gitops.readLinkAt(opts.fs, head, h);
        if (!raw) continue;
        try {
            additions.push(deserializeLink(raw));
        } catch (_err) {
            // Skip malformed link file
        }
    }

    // For removals, read from the previous commit's tree so we have
    // the link content to surface to subscribers.
    const removals: LinkExpression[] = [];
    if (lastSynced) {
        for (const h of removeHashes) {
            const raw = await gitops.readLinkAt(opts.fs, lastSynced, h);
            if (!raw) continue;
            try {
                removals.push(deserializeLink(raw));
            } catch (_err) {
                // Skip
            }
        }
    }

    const diff: PerspectiveDiff = { additions, removals };

    // Update the cache: apply additions, drop removals
    for (const link of additions) {
        store.putLinkWithHash(link, store.hashLink(link));
    }
    for (const h of removeHashes) {
        store.removeLinkByHash(h);
    }

    store.setRevision(head);
    getRuntime().emitPerspectiveDiff(diff);

    return diff;
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

export function render(): Perspective {
    return store.allLinks();
}

// ---------------------------------------------------------------------------
// currentRevision
// ---------------------------------------------------------------------------

export async function currentRevision(fs: GitFs): Promise<string> {
    const head = await gitops.currentHead(fs);
    return head ?? "";
}
