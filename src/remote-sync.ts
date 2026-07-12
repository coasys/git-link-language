/**
 * Remote convergence against a Git provider's JSON REST API.
 *
 * ## Why JSON REST, not the smart protocol
 *
 * The executor's `httpFetch` UTF-8-decodes response bodies, which
 * corrupts binary Git pack files, so the smart protocol is unreachable.
 * Provider REST APIs (GitHub's `/git/{refs,commits,trees,blobs}`) expose
 * everything as JSON with blob content base64-encoded, which round-trips
 * cleanly. See `src/providers/github.ts`.
 *
 * ## What this module does (the diff-DAG contract)
 *
 * The AD4M-facing source of truth is the local **commit DAG** — link
 * *diffs* as causal DAG nodes, one commit per diff (Role A). Convergence
 * is therefore a DAG operation, not a snapshot operation:
 *
 *   1. **Ancestry walk.** From the remote head we walk parent pointers
 *      back to the last remote commit we already mirrored, accumulating
 *      the ordered list of commits the local replica is missing. Each
 *      intermediate commit's own add/remove diff is applied — a
 *      multi-commit remote advance is NOT collapsed into a snapshot of
 *      the head tree (that was the old fake).
 *
 *   2. **Local mirror.** Each missing remote commit is reconstructed as a
 *      real local Git commit (same link-set, preserving the remote
 *      author / message / timestamp). This gives the incoming history a
 *      genuine, ancestry-walkable presence in the local object store so
 *      it can serve as a merge parent.
 *
 *   3. **Fast-forward or merge.** If the local branch has not advanced
 *      past the point the remote forked from, we fast-forward. If BOTH
 *      sides advanced from a shared base (divergence), we OR-Set-merge
 *      the two branches (`src/merge.ts`) keyed by link hash, materialise
 *      the folded link-set, and write a genuine **two-parent merge
 *      commit**. `MERGE_POLICY` resolves concurrent add-vs-remove of the
 *      same link hash.
 *
 * The emitted `PerspectiveDiff` is the delta between the local link-set
 * before and after convergence, so subscribers see exactly the net
 * change.
 */

import * as gitops from "./git.js";
import * as store from "./store.js";
import type { GitFs } from "./fs-adapter.js";
import { deserializeLink, linkHashFromPath, serializeLink } from "./encoding.js";
import type { LinkExpression, PerspectiveDiff, SHA } from "./types.js";
import type { CommitResponse, GitProvider } from "./providers/types.js";
import { getRuntime } from "./adapters.js";
import {
    orSetMerge,
    parseMergePolicy,
    type MergePolicy,
} from "./merge.js";

// ---------------------------------------------------------------------------
// Tracking persisted alongside the cache
// ---------------------------------------------------------------------------

const REMOTE_SHA_KEY = "cache/remote-sha";
const REMOTE_ETAG_KEY = "cache/remote-etag";
// Maps a remote commit SHA to the OID of its locally-mirrored twin so
// repeated pulls resume the ancestry walk instead of re-mirroring.
const MIRROR_PREFIX = "cache/mirror/";

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

function getMirror(remoteSha: string): SHA | null {
    return store.getStorageRaw(`${MIRROR_PREFIX}${remoteSha}`);
}

function setMirror(remoteSha: string, localOid: SHA): void {
    store.setStorageRaw(`${MIRROR_PREFIX}${remoteSha}`, localOid);
}

// ---------------------------------------------------------------------------
// Pull driver
// ---------------------------------------------------------------------------

export interface RemoteSyncOpts {
    provider: GitProvider;
    branch: string;
    intervalMs: number;
    fs: GitFs;
    agentDid: string;
    mergePolicy?: MergePolicy;
}

export interface RemoteSyncHandle {
    stop(): void;
    pullOnce(): Promise<PerspectiveDiff>;
}

const EMPTY_DIFF: PerspectiveDiff = { additions: [], removals: [] };

/**
 * Snapshot the current local link-set as a map of hash → LinkExpression,
 * read from the current HEAD's tree (the authoritative fold of the DAG),
 * falling back to an empty set on an unborn branch.
 */
async function localLinkSet(
    fs: GitFs,
): Promise<Map<string, LinkExpression>> {
    const out = new Map<string, LinkExpression>();
    const head = await gitops.currentHead(fs);
    if (head === null) return out;
    const hashes = await gitops.listLinkHashesAt(fs, head);
    for (const h of hashes) {
        const raw = await gitops.readLinkAt(fs, head, h);
        if (!raw) continue;
        try {
            out.set(h, deserializeLink(raw));
        } catch (_err) {
            // Skip a malformed link file rather than abort convergence.
        }
    }
    return out;
}

/**
 * Diff two link-set snapshots into a PerspectiveDiff (before → after).
 */
function diffLinkSets(
    before: Map<string, LinkExpression>,
    after: Map<string, LinkExpression>,
): PerspectiveDiff {
    const additions: LinkExpression[] = [];
    const removals: LinkExpression[] = [];
    for (const [h, link] of after) {
        if (!before.has(h)) additions.push(link);
    }
    for (const [h, link] of before) {
        if (!after.has(h)) removals.push(link);
    }
    return { additions, removals };
}

/**
 * Walk the remote commit chain from `headSha` backwards along first-parent
 * (and, defensively, all-parent) pointers, stopping at the first commit we
 * have already mirrored (or at roots). Returns the missing commits ordered
 * oldest → newest so they can be replayed in causal order.
 *
 * `fetchCommit` is memoised across the walk so a diamond history does not
 * re-request a commit.
 */
async function collectMissingRemoteCommits(
    provider: GitProvider,
    headSha: string,
): Promise<CommitResponse[]> {
    const commitCache = new Map<string, CommitResponse>();
    const fetchCommit = async (sha: string): Promise<CommitResponse> => {
        const cached = commitCache.get(sha);
        if (cached) return cached;
        const c = await provider.fetchCommit(sha);
        commitCache.set(sha, c);
        return c;
    };

    // Breadth-first back-walk, collecting commits with no local mirror.
    const missing: CommitResponse[] = [];
    const seen = new Set<string>();
    const queue: string[] = [headSha];
    while (queue.length > 0) {
        const sha = queue.shift() as string;
        if (seen.has(sha)) continue;
        seen.add(sha);
        // Boundary: this commit is already mirrored locally — do not walk
        // past it, and do not re-collect it.
        if (getMirror(sha)) continue;
        const commit = await fetchCommit(sha);
        missing.push(commit);
        for (const parent of commit.parents) {
            if (!seen.has(parent)) queue.push(parent);
        }
    }

    // Order oldest → newest: a commit must be mirrored only after all its
    // parents are mirrored. Topological sort over the collected set.
    return topoOrder(missing);
}

/**
 * Kahn topological sort of a set of commits so that every commit appears
 * after all of its parents that are also in the set. Parents not in the
 * set (already mirrored, or roots) are treated as satisfied.
 */
function topoOrder(commits: CommitResponse[]): CommitResponse[] {
    const bySha = new Map<string, CommitResponse>();
    for (const c of commits) bySha.set(c.sha, c);

    const indegree = new Map<string, number>();
    const children = new Map<string, string[]>();
    for (const c of commits) {
        indegree.set(c.sha, 0);
    }
    for (const c of commits) {
        for (const p of c.parents) {
            if (!bySha.has(p)) continue; // parent already satisfied
            indegree.set(c.sha, (indegree.get(c.sha) ?? 0) + 1);
            const arr = children.get(p) ?? [];
            arr.push(c.sha);
            children.set(p, arr);
        }
    }

    // Deterministic ordering: seed the ready set sorted by sha, and always
    // pop the lexicographically-smallest ready commit.
    const ready = [...indegree.entries()]
        .filter(([, d]) => d === 0)
        .map(([sha]) => sha)
        .sort();
    const ordered: CommitResponse[] = [];
    while (ready.length > 0) {
        const sha = ready.shift() as string;
        const commit = bySha.get(sha);
        if (commit) ordered.push(commit);
        for (const child of (children.get(sha) ?? []).sort()) {
            const d = (indegree.get(child) ?? 0) - 1;
            indegree.set(child, d);
            if (d === 0) {
                // Insert keeping the ready list sorted.
                const idx = lowerBound(ready, child);
                ready.splice(idx, 0, child);
            }
        }
    }
    return ordered;
}

function lowerBound(sorted: string[], value: string): number {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid] < value) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/**
 * Fetch the full link-set of a remote commit as `hash → serialised link`,
 * scanning the recursive tree for `links/<hash>.json` blobs and fetching
 * each blob's content. Blob fetches are memoised by blob SHA across the
 * whole pull so shared blobs are fetched once.
 */
async function fetchRemoteLinkSet(
    provider: GitProvider,
    commit: CommitResponse,
    blobCache: Map<string, string>,
): Promise<Map<string, string>> {
    const tree = await provider.fetchTreeRecursive(commit.treeSha);
    const out = new Map<string, string>();
    const pending: Array<Promise<void>> = [];
    for (const entry of tree.entries) {
        if (entry.type !== "blob") continue;
        const hash = linkHashFromPath(entry.path);
        if (!hash) continue;
        const cached = blobCache.get(entry.sha);
        if (cached !== undefined) {
            out.set(hash, cached);
            continue;
        }
        pending.push(
            (async () => {
                const blob = await provider.fetchBlob(entry.sha);
                blobCache.set(entry.sha, blob.content);
                out.set(hash, blob.content);
            })(),
        );
    }
    await Promise.all(pending);
    return out;
}

/**
 * Reconstruct one remote commit as a local Git commit twin: write each
 * link blob, build the tree, and write a commit whose parents are the
 * local mirrors of the remote parents. Records the remote→local mapping.
 * Returns the local mirror OID.
 */
async function mirrorRemoteCommit(
    fs: GitFs,
    commit: CommitResponse,
    remoteLinkSet: Map<string, string>,
): Promise<SHA> {
    // Blobs for the commit's link-set.
    const linkBlobs = new Map<string, SHA>();
    for (const [hash, content] of remoteLinkSet) {
        linkBlobs.set(hash, await gitops.writeLinkBlob(fs, content));
    }
    const treeOid = await gitops.writeRootTreeFromLinkBlobs(fs, linkBlobs);

    // Parents: the local mirrors of the remote parents. A remote parent
    // with no local mirror (already-converged boundary) is dropped — it
    // is represented in the ancestry of whichever commit consumed it.
    const parentOids: SHA[] = [];
    for (const p of commit.parents) {
        const mirror = getMirror(p);
        if (mirror) parentOids.push(mirror);
    }

    const identity = {
        name: commit.author.name || "remote",
        email: commit.author.email || "remote@ad4m",
        timestamp: commit.author.timestamp || 0,
        timezoneOffset: 0,
    };
    const localOid = await gitops.writeCommitObject(fs, {
        tree: treeOid,
        parent: parentOids,
        author: identity,
        committer: identity,
        message: commit.message || "remote commit",
    });
    setMirror(commit.sha, localOid);
    return localOid;
}

/**
 * Run a single convergence pass against the remote and apply the result
 * locally. Returns the net PerspectiveDiff applied (empty if the remote
 * is unchanged or already converged).
 */
export async function pullOnce(opts: RemoteSyncOpts): Promise<PerspectiveDiff> {
    const { fs, provider, branch } = opts;
    const policy = opts.mergePolicy ?? "add-wins";

    const lastEtag = getRemoteEtag() ?? undefined;
    const refResp = await provider.fetchRef(branch, lastEtag);

    if (refResp.notModified) return EMPTY_DIFF;
    if (!refResp.sha) return EMPTY_DIFF;

    const remoteHeadSha = refResp.sha;
    if (remoteHeadSha === getRemoteSha()) {
        // Ref unchanged since last successful pull — refresh the ETag and
        // stop. (The mirror boundary already covers this head.)
        if (refResp.etag) setRemoteEtag(refResp.etag);
        return EMPTY_DIFF;
    }

    // -- 1. Walk ancestry: which remote commits are we missing? ----------
    const missing = await collectMissingRemoteCommits(provider, remoteHeadSha);
    if (missing.length === 0) {
        // Nothing new to mirror (head already mirrored under a different
        // ref position). Record tracking and return.
        setRemoteSha(remoteHeadSha);
        if (refResp.etag) setRemoteEtag(refResp.etag);
        return EMPTY_DIFF;
    }

    // -- 2. Mirror each missing commit locally (oldest → newest) ---------
    const blobCache = new Map<string, string>();
    let lastMirrored: SHA | null = null;
    for (const commit of missing) {
        const remoteLinkSet = await fetchRemoteLinkSet(
            provider,
            commit,
            blobCache,
        );
        lastMirrored = await mirrorRemoteCommit(fs, commit, remoteLinkSet);
    }
    const remoteHeadMirror = getMirror(remoteHeadSha) ?? lastMirrored;
    if (!remoteHeadMirror) {
        // Defensive: should never happen once `missing` is non-empty.
        setRemoteSha(remoteHeadSha);
        if (refResp.etag) setRemoteEtag(refResp.etag);
        return EMPTY_DIFF;
    }

    // -- 3. Fast-forward or merge ----------------------------------------
    const before = await localLinkSet(fs);
    const localHead = await gitops.currentHead(fs);

    if (localHead === null) {
        // Unborn local branch → adopt the mirrored remote head directly.
        await gitops.setBranch(fs, branch, remoteHeadMirror);
        await gitops.checkoutBranch(fs, branch);
    } else {
        const base = await gitops.mergeBase(fs, localHead, remoteHeadMirror);
        if (base === remoteHeadMirror) {
            // Local already contains the remote head — nothing to do.
            setRemoteSha(remoteHeadSha);
            if (refResp.etag) setRemoteEtag(refResp.etag);
            return EMPTY_DIFF;
        }
        if (base === localHead) {
            // Fast-forward: local has not diverged from the remote fork
            // point. Adopt the mirrored remote head wholesale.
            await gitops.setBranch(fs, branch, remoteHeadMirror);
            await gitops.checkoutBranch(fs, branch);
        } else {
            // Genuine divergence — OR-Set merge of the two branches.
            await mergeDivergent(fs, {
                branch,
                localHead,
                remoteHeadMirror,
                base,
                policy,
                agentDid: opts.agentDid,
            });
        }
    }

    // -- 4. Rebuild the cache + emit the net diff ------------------------
    await rebuildCacheFromHead(fs);
    const after = await localLinkSet(fs);
    const diff = diffLinkSets(before, after);

    setRemoteSha(remoteHeadSha);
    if (refResp.etag) setRemoteEtag(refResp.etag);

    if (diff.additions.length > 0 || diff.removals.length > 0) {
        getRuntime().emitPerspectiveDiff(diff);
    }
    return diff;
}

interface MergeDivergentOpts {
    branch: string;
    localHead: SHA;
    remoteHeadMirror: SHA;
    base: SHA | null;
    policy: MergePolicy;
    agentDid: string;
}

/**
 * OR-Set-merge two divergent branches and write a two-parent merge commit
 * on `branch`.
 */
async function mergeDivergent(
    fs: GitFs,
    opts: MergeDivergentOpts,
): Promise<void> {
    const { branch, localHead, remoteHeadMirror, base, policy } = opts;

    // The link-set materialised at the common base.
    const baseHashes = base
        ? await gitops.listLinkHashesAt(fs, base)
        : new Set<string>();

    // OR-Set-faithful deltas: derive each branch's adds/removes from its
    // *commit op-log* since the base, not from a base-vs-head snapshot. A
    // link that a branch added and then removed is thereby recorded as an
    // observed tombstone even when the base predates the link — which is
    // exactly what lets a concurrent add-vs-remove of the same hash be
    // resolved by `MERGE_POLICY` (a snapshot diff would silently lose the
    // removal and resurrect the link regardless of policy).
    const localDelta = await gitops.branchOpsSince(fs, base, localHead);
    const remoteDelta = await gitops.branchOpsSince(fs, base, remoteHeadMirror);

    const { merged } = orSetMerge({
        base: baseHashes,
        local: localDelta,
        remote: remoteDelta,
        policy,
    });

    // Resolve a blob OID for every hash in the merged set. Prefer the
    // local side's blob, then the remote mirror's, then the base's — all
    // three carry byte-identical content for the same hash, so any source
    // is correct; we just need one that exists in the object store.
    const localBlobs = await gitops.linkBlobOidsAt(fs, localHead);
    const remoteBlobs = await gitops.linkBlobOidsAt(fs, remoteHeadMirror);
    const baseBlobs = base
        ? await gitops.linkBlobOidsAt(fs, base)
        : new Map<string, SHA>();

    const mergedBlobs = new Map<string, SHA>();
    for (const h of merged) {
        const oid = localBlobs.get(h) ?? remoteBlobs.get(h) ?? baseBlobs.get(h);
        if (oid) mergedBlobs.set(h, oid);
    }

    const mergeTree = await gitops.writeRootTreeFromLinkBlobs(fs, mergedBlobs);

    const now = Math.floor(Date.now() / 1000);
    const identity = {
        name: gitops.authorFromDid(opts.agentDid).name,
        email: gitops.authorFromDid(opts.agentDid).email,
        timestamp: now,
        timezoneOffset: 0,
    };
    const mergeCommit = await gitops.writeCommitObject(fs, {
        tree: mergeTree,
        // First parent = local head (ours); second = remote mirror.
        parent: [localHead, remoteHeadMirror],
        author: identity,
        committer: identity,
        message: `merge: OR-Set (${policy}) +${merged.size} links`,
    });

    await gitops.setBranch(fs, branch, mergeCommit);
    await gitops.checkoutBranch(fs, branch);
}

/**
 * Rebuild the in-memory link cache + revision pointer from the current
 * HEAD (the fold of the DAG). The cache is a *derived* view; HEAD is the
 * source of truth.
 */
async function rebuildCacheFromHead(fs: GitFs): Promise<void> {
    const head = await gitops.currentHead(fs);
    if (head === null) return;
    store.clearCache();
    const hashes = await gitops.listLinkHashesAt(fs, head);
    for (const h of hashes) {
        const raw = await gitops.readLinkAt(fs, head, h);
        if (!raw) continue;
        try {
            store.putLinkWithHash(deserializeLink(raw), h);
        } catch (_err) {
            // Skip malformed link file.
        }
    }
    store.setRevision(head);
}

// ---------------------------------------------------------------------------
// Push driver (the mirror image of pull)
// ---------------------------------------------------------------------------

/**
 * The result of a push attempt.
 *
 *   - `pushed`      — how many local commits were newly POSTed to the remote
 *                     (0 when the remote was already up to date).
 *   - `ok`          — whether the remote ref now points at the local head.
 *   - `unsupported` — true when the provider cannot push (`canPush=false`);
 *                     the caller treats this as a no-op, not a failure.
 */
export interface PushResult {
    ok: boolean;
    pushed: number;
    unsupported?: boolean;
}

/**
 * Enumerate the local OIDs already known to exist on the remote: the values
 * of the remote→local mirror map (each is a local twin of a remote commit),
 * i.e. the boundary where a local back-walk can stop because the remote
 * already has that commit.
 */
function mirroredLocalOids(): Set<SHA> {
    const out = new Set<SHA>();
    for (const key of store.listStorageKeys(MIRROR_PREFIX)) {
        const oid = store.getStorageRaw(key);
        if (oid) out.add(oid);
    }
    return out;
}

/**
 * Collect the local commits reachable from `head` that the remote does not
 * yet have, ordered oldest → newest (parents before children). The walk
 * stops at any commit already present on the remote (a mirror twin) and at
 * roots.
 */
async function collectUnpushedLocalCommits(
    fs: GitFs,
    head: SHA,
    onRemote: Set<SHA>,
): Promise<SHA[]> {
    const collected = new Map<SHA, gitops.RawCommitObject>();
    const seen = new Set<SHA>();
    const queue: SHA[] = [head];
    while (queue.length > 0) {
        const oid = queue.shift() as SHA;
        if (seen.has(oid)) continue;
        seen.add(oid);
        if (onRemote.has(oid)) continue; // already on the remote — boundary
        const commit = await gitops.readCommitObject(fs, oid);
        if (!commit) continue;
        collected.set(oid, commit);
        for (const p of commit.parent) {
            if (!seen.has(p)) queue.push(p);
        }
    }
    return topoOrderOids(collected);
}

/**
 * Topological sort of a local commit map so each commit appears after its
 * parents present in the map (roots / already-pushed parents are treated as
 * satisfied). Deterministic: ties broken lexicographically.
 */
function topoOrderOids(commits: Map<SHA, gitops.RawCommitObject>): SHA[] {
    const indegree = new Map<SHA, number>();
    const children = new Map<SHA, SHA[]>();
    for (const oid of commits.keys()) indegree.set(oid, 0);
    for (const [oid, commit] of commits) {
        for (const p of commit.parent) {
            if (!commits.has(p)) continue;
            indegree.set(oid, (indegree.get(oid) ?? 0) + 1);
            const arr = children.get(p) ?? [];
            arr.push(oid);
            children.set(p, arr);
        }
    }
    const ready = [...indegree.entries()]
        .filter(([, d]) => d === 0)
        .map(([oid]) => oid)
        .sort();
    const ordered: SHA[] = [];
    while (ready.length > 0) {
        const oid = ready.shift() as SHA;
        ordered.push(oid);
        for (const child of (children.get(oid) ?? []).sort()) {
            const d = (indegree.get(child) ?? 0) - 1;
            indegree.set(child, d);
            if (d === 0) ready.splice(lowerBound(ready, child), 0, child);
        }
    }
    return ordered;
}

/**
 * POST one local commit's objects to the remote in dependency order
 * (blobs → tree → commit) and assert every returned SHA equals the local
 * OID. Because Git object hashing is deterministic over content, a
 * byte-identical POST reproduces the local OID; a mismatch means the remote
 * canonicalised the object differently and is a hard error (never a silent
 * divergence). Returns nothing — success is the SHA-equality assertions.
 */
async function pushLocalCommit(
    fs: GitFs,
    provider: GitProvider,
    oid: SHA,
    commit: gitops.RawCommitObject,
): Promise<void> {
    // 1. Blobs: the serialised content of every link at this commit. POST
    //    each and assert the remote reproduces the local blob OID.
    const linkBlobs = await gitops.linkBlobOidsAt(fs, oid);
    const treeEntries: Array<{
        path: string;
        mode: string;
        type: "blob";
        sha: string;
    }> = [];
    for (const [hash, localBlobOid] of linkBlobs) {
        const raw = await gitops.readLinkAt(fs, oid, hash);
        if (raw === null) {
            throw new Error(
                `push: link ${hash} present in tree of ${oid} but unreadable`,
            );
        }
        // Re-serialise through the same path the local blob was written with
        // so the posted bytes are byte-identical to the local object.
        const content = serializeLink(deserializeLink(raw));
        const { sha } = await provider.createBlob(content);
        assertSha(sha, localBlobOid, "blob", hash);
        treeEntries.push({
            path: `links/${hash}.json`,
            mode: "100644",
            type: "blob",
            sha,
        });
    }

    // 2. Tree: rebuild the root tree from the (remote-confirmed) blob SHAs
    //    and assert it reproduces the local tree OID.
    const { sha: treeSha } = await provider.createTree(treeEntries);
    assertSha(treeSha, commit.tree, "tree", oid);

    // 3. Commit: POST with the remote parent SHAs (== local parent OIDs,
    //    which are already on the remote by topological ordering) and assert
    //    it reproduces the local commit OID. Author *and* committer are sent
    //    from the local object's own fields so the reconstructed commit is
    //    byte-identical. Local commits are pinned to UTC (see git.commit /
    //    the pull+merge paths), so an ISO date with a `Z` suffix reproduces
    //    the exact `<timestamp> +0000` line Git hashed.
    const { sha: commitSha } = await provider.createCommit({
        tree: treeSha,
        parents: commit.parent,
        message: commit.message,
        author: {
            name: commit.author.name,
            email: commit.author.email,
            date: new Date(commit.author.timestamp * 1000).toISOString(),
        },
        committer: {
            name: commit.committer.name,
            email: commit.committer.email,
            date: new Date(commit.committer.timestamp * 1000).toISOString(),
        },
    });
    assertSha(commitSha, oid, "commit", oid);
}

function assertSha(
    returned: string,
    expected: string,
    kind: string,
    context: string,
): void {
    if (returned !== expected) {
        throw new Error(
            `push: remote ${kind} SHA ${returned} != local OID ${expected} ` +
                `(${context}); the remote canonicalised the object differently`,
        );
    }
}

/**
 * Push local commits to the remote — the mirror image of {@link pullOnce}.
 *
 *   1. Compute the boundary the remote already has (mirror twins) and walk
 *      local HEAD back to it, collecting unpushed commits oldest → newest.
 *   2. POST each commit's objects bottom-up (blobs → tree → commit),
 *      asserting SHA-equality, and record each pushed commit as now on the
 *      remote (so subsequent syncs treat it as a boundary).
 *   3. `updateRef(branch, localHead)`. On a non-fast-forward rejection (the
 *      remote moved under us), run {@link pullOnce} to converge, then retry
 *      the push **once**.
 *
 * Fault-tolerant and idempotent: an unsupported provider is a no-op; a
 * fully-mirrored local head advances only the ref (or nothing).
 */
export async function pushOnce(
    opts: RemoteSyncOpts & { _retry?: boolean },
): Promise<PushResult> {
    const { fs, provider, branch } = opts;
    if (!provider.canPush) {
        return { ok: false, pushed: 0, unsupported: true };
    }

    const localHead = await gitops.currentHead(fs);
    if (localHead === null) {
        // Nothing committed locally yet.
        return { ok: true, pushed: 0 };
    }

    // -- 1. Which local commits does the remote lack? --------------------
    const onRemote = mirroredLocalOids();
    // The tracked remote head's mirror is on the remote too; include it.
    const trackedRemote = getRemoteSha();
    if (trackedRemote) {
        const twin = getMirror(trackedRemote);
        if (twin) onRemote.add(twin);
    }
    // If the local head is already known-on-remote, only the ref may need to
    // move (it already does, by definition of tracked sha == head mirror).
    const unpushed = await collectUnpushedLocalCommits(fs, localHead, onRemote);

    // -- 2. POST each missing commit bottom-up --------------------------
    for (const oid of unpushed) {
        const commit = await gitops.readCommitObject(fs, oid);
        if (!commit) continue;
        await pushLocalCommit(fs, provider, oid, commit);
        // Record the commit as present on the remote: its own SHA is the
        // remote SHA (deterministic hashing), so it becomes a boundary and a
        // pull will recognise it as already-mirrored.
        setMirror(oid, oid);
    }

    // -- 3. Move the remote ref -----------------------------------------
    const refResult = await provider.updateRef(branch, localHead);
    if (refResult.ok) {
        setRemoteSha(localHead);
        return { ok: true, pushed: unpushed.length };
    }

    if (refResult.notFastForward && !opts._retry) {
        // The remote advanced under us. Converge it locally, then retry the
        // push once against the new (merged) local head.
        await pullOnce(opts);
        return await pushOnce({ ...opts, _retry: true });
    }

    // Non-fast-forward on the retry, or another ref failure: leave tracking
    // untouched so the next sync re-attempts. Not fatal.
    return { ok: false, pushed: unpushed.length };
}

/**
 * Start a background loop that calls {@link pullOnce} every
 * `intervalMs` milliseconds.
 *
 * Returns `null` when `intervalMs <= 0` — in that mode the Language runs
 * in **on-demand** sync: the timer is disabled, but the standard
 * `perspective-sync.sync()` capability still routes through the provider,
 * so apps can trigger pulls explicitly via the AD4M
 * `perspective.pullLinks` / `perspective.sync()` RPC.
 *
 * The loop is fault-tolerant: errors are logged and swallowed so a
 * transient 429 or network blip cannot break the chain.
 */
export function startRemoteSync(opts: RemoteSyncOpts): RemoteSyncHandle | null {
    if (!Number.isFinite(opts.intervalMs) || opts.intervalMs <= 0) {
        return null;
    }

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
                // Swallow even the warn — we never want the tick to crash.
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

export const parseMergePolicyForConfig = parseMergePolicy;
