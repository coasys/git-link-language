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
    const sha = await git.commit({
        fs,
        dir: REPO_DIR,
        author: opts.author,
        committer: opts.author,
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
