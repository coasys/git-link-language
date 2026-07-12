/**
 * Wrappers around isomorphic-git, scoped to the operations the link
 * language needs.
 *
 * All Git state lives under `REPO_DIR` in the fs-adapter. The fs
 * adapter delegates to the executor's storage KV, so the "filesystem"
 * isomorphic-git sees is the persistent storage of this Language.
 *
 * Functions return primitive shapes (strings, plain objects, arrays
 * of bytes) so callers don't need an isomorphic-git type dependency.
 */

import * as git from "isomorphic-git";

import type { GitFs } from "./fs-adapter.js";
import type { CommitRecord, SHA } from "./types.js";
import {
    bytesToUtf8,
    linkFilePath,
    linkHashFromPath,
    utf8ToBytes,
} from "./encoding.js";

export const REPO_DIR = "/repo";
const LINKS_DIR = "links";

// A file-mode constant for regular files inside a Git tree.
const BLOB_MODE = "100644";
// A file-mode constant for subtrees.
const TREE_MODE = "040000";

// ---------------------------------------------------------------------------
// Repo init
// ---------------------------------------------------------------------------

/**
 * Initialise the repo if `.git/HEAD` is absent. Idempotent.
 * Returns true if initialisation actually ran.
 */
export async function ensureRepoInit(
    fs: GitFs,
    defaultBranch: string,
): Promise<boolean> {
    try {
        await fs.stat(`${REPO_DIR}/.git/HEAD`);
        return false;
    } catch (_err) {
        // Not initialised yet
    }
    await git.init({
        fs,
        dir: REPO_DIR,
        defaultBranch,
    });
    return true;
}

// ---------------------------------------------------------------------------
// Author / committer
// ---------------------------------------------------------------------------

export interface GitAuthor {
    name: string;
    email: string;
    timestamp?: number;
}

/**
 * Build a Git author record from a DID. The email field is
 * synthesised — Git requires one and the executor sandbox has no
 * access to the agent's real email, so we encode the DID into the
 * local-part for traceability.
 */
export function authorFromDid(did: string): GitAuthor {
    return {
        name: did,
        email: `${did}@ad4m`,
    };
}

// ---------------------------------------------------------------------------
// Writing links to the working tree
// ---------------------------------------------------------------------------

export async function writeLinkFile(
    fs: GitFs,
    linkHash: string,
    serialisedLink: string,
): Promise<void> {
    await fs.writeFile(`${REPO_DIR}/${linkFilePath(linkHash)}`, serialisedLink);
}

export async function deleteLinkFile(
    fs: GitFs,
    linkHash: string,
): Promise<void> {
    try {
        await fs.unlink(`${REPO_DIR}/${linkFilePath(linkHash)}`);
    } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== "ENOENT") throw err;
    }
}

/**
 * Read a link file from the current working tree. Returns null if the
 * file does not exist.
 */
export async function readLinkFile(
    fs: GitFs,
    linkHash: string,
): Promise<string | null> {
    try {
        const bytes = await fs.readFile(
            `${REPO_DIR}/${linkFilePath(linkHash)}`,
            { encoding: "utf8" },
        );
        return typeof bytes === "string" ? bytes : bytesToUtf8(bytes);
    } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "ENOENT") return null;
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export interface CommitOptions {
    additions: string[];         // link hashes added
    removals: string[];          // link hashes removed
    author: GitAuthor;
    message?: string;
}

/**
 * Stage the named additions/removals and commit. Returns the new
 * HEAD SHA.
 */
export async function commit(
    fs: GitFs,
    opts: CommitOptions,
): Promise<SHA> {
    for (const h of opts.additions) {
        await git.add({
            fs,
            dir: REPO_DIR,
            filepath: linkFilePath(h),
        });
    }
    for (const h of opts.removals) {
        try {
            await git.remove({
                fs,
                dir: REPO_DIR,
                filepath: linkFilePath(h),
            });
        } catch (err) {
            // Removing a file that was never staged is benign
            const message = (err as Error).message ?? "";
            if (!/not.*staged|not found in the index/i.test(message)) throw err;
        }
    }
    // Pin the author/committer to a UTC timestamp so the commit OID is
    // reproducible off-box. isomorphic-git otherwise fills the timezone from
    // the local machine, which (a) makes the OID depend on where the executor
    // runs and (b) cannot be reconstructed from the UTC ISO date the push path
    // POSTs — breaking the `returnedSha === localOid` invariant that lets a
    // commit be mirrored to a remote. Author == committer, matching how the
    // pull/merge paths reconstruct commits (see remote-sync.ts).
    const identity = {
        name: opts.author.name,
        email: opts.author.email,
        timestamp: opts.author.timestamp ?? Math.floor(Date.now() / 1000),
        timezoneOffset: 0,
    };
    const sha = await git.commit({
        fs,
        dir: REPO_DIR,
        author: identity,
        committer: identity,
        message:
            opts.message ??
            `diff: +${opts.additions.length} -${opts.removals.length}`,
    });
    return sha;
}

// ---------------------------------------------------------------------------
// HEAD / refs
// ---------------------------------------------------------------------------

export async function currentHead(fs: GitFs): Promise<SHA | null> {
    try {
        return await git.resolveRef({
            fs,
            dir: REPO_DIR,
            ref: "HEAD",
        });
    } catch (err) {
        const message = (err as Error).message ?? "";
        if (/could not find|NotFoundError/i.test(message)) return null;
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Tree walks
// ---------------------------------------------------------------------------

/**
 * Return the set of link hashes present in the `links/` tree at the
 * given commit SHA.
 */
export async function listLinkHashesAt(
    fs: GitFs,
    sha: SHA,
): Promise<Set<string>> {
    const hashes = new Set<string>();
    let entries;
    try {
        const result = await git.readTree({
            fs,
            dir: REPO_DIR,
            oid: sha,
            filepath: LINKS_DIR,
        });
        entries = result.tree;
    } catch (err) {
        const message = (err as Error).message ?? "";
        if (/Could not find|NotFoundError/i.test(message)) {
            return hashes;
        }
        throw err;
    }
    for (const entry of entries) {
        const h = linkHashFromPath(`${LINKS_DIR}/${entry.path}`);
        if (h) hashes.add(h);
    }
    return hashes;
}

/**
 * Read the contents of a single link file at the given commit SHA,
 * as a UTF-8 string. Returns null if the file does not exist at
 * that commit.
 */
export async function readLinkAt(
    fs: GitFs,
    sha: SHA,
    linkHash: string,
): Promise<string | null> {
    try {
        const { blob } = await git.readBlob({
            fs,
            dir: REPO_DIR,
            oid: sha,
            filepath: linkFilePath(linkHash),
        });
        return bytesToUtf8(blob);
    } catch (err) {
        const message = (err as Error).message ?? "";
        if (/Could not find|NotFoundError/i.test(message)) return null;
        throw err;
    }
}

/**
 * Compute the link-set difference between two commits.
 * `additions` are link hashes present in `toSha` but not in `fromSha`,
 * `removals` are the inverse.
 *
 * If `fromSha` is null (e.g. computing the genesis diff), every link
 * present in `toSha` counts as an addition.
 */
export async function diffLinks(
    fs: GitFs,
    fromSha: SHA | null,
    toSha: SHA,
): Promise<{ additions: string[]; removals: string[] }> {
    const toHashes = await listLinkHashesAt(fs, toSha);
    if (fromSha === null) {
        return { additions: [...toHashes], removals: [] };
    }
    const fromHashes = await listLinkHashesAt(fs, fromSha);
    const additions: string[] = [];
    const removals: string[] = [];
    for (const h of toHashes) {
        if (!fromHashes.has(h)) additions.push(h);
    }
    for (const h of fromHashes) {
        if (!toHashes.has(h)) removals.push(h);
    }
    return { additions, removals };
}

// ---------------------------------------------------------------------------
// Branch op-log (for OR-Set merge)
// ---------------------------------------------------------------------------

/**
 * The net add/remove operations a branch observed on the link-set since a
 * common base, keyed by link hash. Unlike a base-vs-head snapshot diff,
 * this is derived from the branch's *commit operations*, so a link that
 * was added and then removed on the branch is recorded as a **removal**
 * (an observed tombstone) even when the merge base predates the link
 * entirely. That is exactly what an OR-Set needs: a removal is first-class
 * and survives regardless of where the merge base happens to sit.
 */
export interface BranchOps {
    adds: Set<string>;
    removes: Set<string>;
}

/**
 * Collect the set of commit OIDs reachable from `start` (inclusive) by
 * walking parent pointers. Used to compute the ancestor set of the merge
 * base so the branch walk never crosses below it.
 */
async function ancestorsOf(fs: GitFs, start: SHA | null): Promise<Set<SHA>> {
    const out = new Set<SHA>();
    if (start === null) return out;
    const queue: SHA[] = [start];
    while (queue.length > 0) {
        const oid = queue.shift() as SHA;
        if (out.has(oid)) continue;
        out.add(oid);
        const commit = await readCommitObject(fs, oid);
        if (!commit) continue;
        for (const p of commit.parent) {
            if (!out.has(p)) queue.push(p);
        }
    }
    return out;
}

/**
 * Compute a branch's net link-set operations since `base` by replaying the
 * add/remove diff of every commit on the branch that is a descendant of
 * `base`, in causal (oldest → newest) order, with last-op-wins per hash.
 *
 * `base` may be null (no common ancestor — independent roots), in which
 * case the entire history reachable from `head` is replayed.
 *
 * This is the OR-Set-faithful delta: it preserves an add-then-remove as a
 * tombstone, which a base-vs-head snapshot diff would silently drop when
 * the base predates the link.
 */
export async function branchOpsSince(
    fs: GitFs,
    base: SHA | null,
    head: SHA,
): Promise<BranchOps> {
    const baseAncestors = await ancestorsOf(fs, base);

    // 1. Collect the commits strictly above the base (descendants of base,
    //    up to head) by back-walking parents and stopping at base ancestry.
    const collected = new Map<SHA, RawCommitObject>();
    const queue: SHA[] = [head];
    const seen = new Set<SHA>();
    while (queue.length > 0) {
        const oid = queue.shift() as SHA;
        if (seen.has(oid)) continue;
        seen.add(oid);
        if (baseAncestors.has(oid)) continue; // at/below the base — stop
        const commit = await readCommitObject(fs, oid);
        if (!commit) continue;
        collected.set(oid, commit);
        for (const p of commit.parent) {
            if (!seen.has(p)) queue.push(p);
        }
    }

    // 2. Order oldest → newest (topological; parents before children).
    const ordered = topoSortCommits(collected);

    // 3. Replay each commit's diff-vs-first-parent, last-op-wins per hash.
    const adds = new Set<string>();
    const removes = new Set<string>();
    for (const oid of ordered) {
        const commit = collected.get(oid);
        if (!commit) continue;
        const parent = commit.parent.length > 0 ? commit.parent[0] : null;
        const diff = await diffLinks(fs, parent, oid);
        for (const h of diff.additions) {
            adds.add(h);
            removes.delete(h);
        }
        for (const h of diff.removals) {
            removes.add(h);
            adds.delete(h);
        }
    }
    return { adds, removes };
}

/**
 * Topological sort of a commit map (oid → commit) so that every commit
 * appears after its parents that are also present in the map. Ties broken
 * lexicographically for determinism.
 */
function topoSortCommits(commits: Map<SHA, RawCommitObject>): SHA[] {
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
            if (d === 0) {
                let lo = 0;
                let hi = ready.length;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (ready[mid] < child) lo = mid + 1;
                    else hi = mid;
                }
                ready.splice(lo, 0, child);
            }
        }
    }
    return ordered;
}

// ---------------------------------------------------------------------------
// Log / history
// ---------------------------------------------------------------------------

export interface RawCommitEntry {
    oid: SHA;
    commit: {
        message: string;
        tree: SHA;
        parent: SHA[];
        author: { name: string; email: string; timestamp: number };
        committer: { name: string; email: string; timestamp: number };
    };
}

/**
 * Raw commit log starting from a ref or SHA. Returns most-recent
 * first. Limit caps the number of commits returned.
 */
export async function rawLog(
    fs: GitFs,
    ref: string,
    limit?: number,
): Promise<RawCommitEntry[]> {
    try {
        const entries = await git.log({
            fs,
            dir: REPO_DIR,
            ref,
            depth: limit,
        });
        return entries as unknown as RawCommitEntry[];
    } catch (err) {
        const message = (err as Error).message ?? "";
        if (/Could not find|NotFoundError|Reference.*does not exist/i.test(message)) {
            return [];
        }
        throw err;
    }
}

/**
 * Decorate a raw commit entry with the link-hash additions/removals
 * relative to its first parent. For root commits, every link present
 * counts as an addition.
 */
export async function decorateCommit(
    fs: GitFs,
    entry: RawCommitEntry,
): Promise<CommitRecord> {
    const parents = entry.commit.parent;
    const parent = parents.length > 0 ? parents[0] : null;
    const diff = await diffLinks(fs, parent, entry.oid);
    const tsIso = new Date(entry.commit.author.timestamp * 1000).toISOString();
    return {
        sha: entry.oid,
        author: entry.commit.author.name,
        timestamp: tsIso,
        message: entry.commit.message,
        additions: diff.additions,
        removals: diff.removals,
        parents,
    };
}

// ---------------------------------------------------------------------------
// Status (for sync detect)
// ---------------------------------------------------------------------------

export interface RepoStatus {
    head: SHA | null;
    branchExists: boolean;
}

export async function status(
    fs: GitFs,
    branch: string,
): Promise<RepoStatus> {
    let head: SHA | null = null;
    let branchExists = false;
    try {
        head = await git.resolveRef({ fs, dir: REPO_DIR, ref: branch });
        branchExists = true;
    } catch (_err) {
        try {
            head = await git.resolveRef({ fs, dir: REPO_DIR, ref: "HEAD" });
        } catch (_err2) {
            head = null;
        }
    }
    return { head, branchExists };
}

/**
 * Convenience for callers that need to write a UTF-8 string to the
 * working tree without going through {@link writeLinkFile}.
 */
export async function writeText(
    fs: GitFs,
    path: string,
    text: string,
): Promise<void> {
    await fs.writeFile(`${REPO_DIR}/${path}`, utf8ToBytes(text));
}

// ---------------------------------------------------------------------------
// Low-level object plumbing
//
// The merge + remote-mirror paths build commits by writing Git objects
// directly (blobs → tree → commit) rather than staging into the working
// tree. This keeps materialisation of a merged link-set atomic and lets
// us reconstruct a remote commit chain locally as real Git commits (so a
// merge commit can carry a genuine, ancestry-walkable second parent).
// ---------------------------------------------------------------------------

export interface RawCommitObject {
    tree: SHA;
    parent: SHA[];
    author: { name: string; email: string; timestamp: number; timezoneOffset: number };
    committer: { name: string; email: string; timestamp: number; timezoneOffset: number };
    message: string;
}

/**
 * Return the `links/<hash>.json` → blob-OID map at a given commit. This
 * is the content-addressed link set of that commit expressed as Git
 * object IDs, which lets us re-use existing blobs when building a new
 * tree instead of re-writing identical content.
 */
export async function linkBlobOidsAt(
    fs: GitFs,
    sha: SHA,
): Promise<Map<string, SHA>> {
    const out = new Map<string, SHA>();
    let entries;
    try {
        const result = await git.readTree({
            fs,
            dir: REPO_DIR,
            oid: sha,
            filepath: LINKS_DIR,
        });
        entries = result.tree;
    } catch (err) {
        const message = (err as Error).message ?? "";
        if (/Could not find|NotFoundError/i.test(message)) return out;
        throw err;
    }
    for (const entry of entries) {
        const h = linkHashFromPath(`${LINKS_DIR}/${entry.path}`);
        if (h) out.set(h, entry.oid);
    }
    return out;
}

/**
 * Write a link's serialised content as a loose Git blob and return its
 * OID. Idempotent: identical content yields the same OID, so calling
 * this for a link that already exists in the object store is cheap.
 */
export async function writeLinkBlob(
    fs: GitFs,
    serialisedLink: string,
): Promise<SHA> {
    return await git.writeBlob({
        fs,
        dir: REPO_DIR,
        blob: utf8ToBytes(serialisedLink),
    });
}

/**
 * Build the root tree for a commit whose link-set is exactly the given
 * `link-hash → blob-OID` map. Produces `links/<hash>.json` entries under
 * a `links` subtree and returns the root tree OID.
 */
export async function writeRootTreeFromLinkBlobs(
    fs: GitFs,
    linkBlobs: Map<string, SHA>,
): Promise<SHA> {
    const linkEntries = [...linkBlobs.entries()].map(([hash, oid]) => ({
        mode: BLOB_MODE,
        path: `${hash}.json`,
        oid,
        type: "blob" as const,
    }));
    // Empty link-set → empty links subtree is still a valid tree; Git
    // permits an empty tree object, and readTree(filepath) tolerates it.
    const linksTreeOid = await git.writeTree({
        fs,
        dir: REPO_DIR,
        tree: linkEntries,
    });
    return await git.writeTree({
        fs,
        dir: REPO_DIR,
        tree: [
            { mode: TREE_MODE, path: LINKS_DIR, oid: linksTreeOid, type: "tree" },
        ],
    });
}

/**
 * Write a commit object directly from an explicit spec (tree + parents +
 * identities + message) and return its OID. Used to (a) reconstruct a
 * remote commit chain locally and (b) create two-parent merge commits.
 * Does not move any ref.
 */
export async function writeCommitObject(
    fs: GitFs,
    commit: RawCommitObject,
): Promise<SHA> {
    return await git.writeCommit({
        fs,
        dir: REPO_DIR,
        commit,
    });
}

/**
 * Read a commit object's raw fields (tree OID, parents, author,
 * message). Returns null if the object is absent from the local store.
 */
export async function readCommitObject(
    fs: GitFs,
    sha: SHA,
): Promise<RawCommitObject | null> {
    try {
        const { commit } = await git.readCommit({ fs, dir: REPO_DIR, oid: sha });
        return {
            tree: commit.tree,
            parent: commit.parent,
            author: commit.author,
            committer: commit.committer,
            message: commit.message,
        };
    } catch (err) {
        const message = (err as Error).message ?? "";
        if (/Could not find|NotFoundError/i.test(message)) return null;
        throw err;
    }
}

/**
 * True if the object with the given OID exists in the local Git store.
 */
export async function objectExists(fs: GitFs, sha: SHA): Promise<boolean> {
    return (await readCommitObject(fs, sha)) !== null;
}

/**
 * Find the merge base (most recent common ancestor) of two commits.
 * Returns the first base OID, or null if the histories share no common
 * ancestor (independent roots).
 */
export async function mergeBase(
    fs: GitFs,
    a: SHA,
    b: SHA,
): Promise<SHA | null> {
    const bases = await git.findMergeBase({ fs, dir: REPO_DIR, oids: [a, b] });
    return bases.length > 0 ? bases[0] : null;
}

/**
 * Resolve a branch to its current commit OID, or null if the branch does
 * not exist yet.
 */
export async function resolveBranch(
    fs: GitFs,
    branch: string,
): Promise<SHA | null> {
    try {
        return await git.resolveRef({
            fs,
            dir: REPO_DIR,
            ref: `refs/heads/${branch}`,
        });
    } catch (err) {
        const message = (err as Error).message ?? "";
        if (/could not find|NotFoundError|does not exist/i.test(message)) {
            return null;
        }
        throw err;
    }
}

/**
 * Point a branch ref at a commit OID (force-update). Used to advance the
 * local branch to a fast-forwarded or merged head.
 */
export async function setBranch(
    fs: GitFs,
    branch: string,
    sha: SHA,
): Promise<void> {
    await git.writeRef({
        fs,
        dir: REPO_DIR,
        ref: `refs/heads/${branch}`,
        value: sha,
        force: true,
    });
}

/**
 * Sync the working tree + Git index to a branch's current commit. Called
 * after advancing a branch ref via a merge / mirror so that the working
 * tree reflects the merged link-set and subsequent staged commits diff
 * against the right baseline.
 *
 * The branch name (not a raw SHA) is used so HEAD remains a symbolic ref
 * to `refs/heads/<branch>` — a detached checkout would break the next
 * `git.commit`'s parent linkage.
 */
export async function checkoutBranch(
    fs: GitFs,
    branch: string,
): Promise<void> {
    await git.checkout({
        fs,
        dir: REPO_DIR,
        ref: branch,
        force: true,
    });
}
