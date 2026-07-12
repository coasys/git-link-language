/**
 * In-memory fake of a Git provider's remote repository, exposing exactly
 * the read surface `src/remote-sync.ts` consumes (`fetchRef`,
 * `fetchCommit`, `fetchTreeRecursive`, `fetchBlob`). This lets tests
 * drive multi-commit remote histories — the ancestry walk and divergent
 * merge cannot be exercised against a single-snapshot mock.
 *
 * The fake is a real content-addressed store: blobs, trees (link-hash →
 * blob), and commits (parents + tree + author) all get deterministic
 * SHAs, so mirror-determinism assertions hold.
 *
 * It is duck-typed to `GitHubProvider`; `remote-sync.ts` only calls the
 * four read methods, so a structural stand-in is sufficient and avoids a
 * network dependency.
 */

import type {
    BlobResponse,
    CommitResponse,
    GitHubProvider,
    RefResponse,
    TreeResponse,
} from "../src/providers/github.js";
import type { LinkExpression } from "../src/types.js";
import { serializeLink } from "../src/encoding.js";

// A small deterministic content hash for the fake object store.
function contentSha(prefix: string, data: string): string {
    let h1 = 0x811c9dc5;
    for (let i = 0; i < data.length; i++) {
        h1 ^= data.charCodeAt(i);
        h1 = Math.imul(h1, 0x01000193);
    }
    let h2 = 0;
    for (let i = 0; i < data.length; i++) {
        h2 = (Math.imul(h2, 31) + data.charCodeAt(i)) | 0;
    }
    const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
    return `${prefix}${hex(h1)}${hex(h2)}${hex(data.length)}`;
}

interface FakeCommit {
    sha: string;
    treeSha: string;
    parents: string[];
    message: string;
    author: { name: string; email: string; timestamp: number };
}

export class FakeRemote {
    private blobs = new Map<string, string>(); // blobSha -> serialised link
    private trees = new Map<string, Map<string, string>>(); // treeSha -> (linkHash -> blobSha)
    private commits = new Map<string, FakeCommit>(); // commitSha -> commit
    private headSha: string | null = null;
    private etagCounter = 0;
    private etag = "";

    /** The branch this fake serves (single-branch model). */
    constructor(public readonly branch = "main") {}

    get head(): string | null {
        return this.headSha;
    }

    /**
     * Commit a new state: `linkSet` is the FULL link-set (hash ->
     * LinkExpression) that the new commit's tree should contain. Parents
     * default to the current head (linear advance) unless given
     * explicitly (for constructing divergence server-side). Returns the
     * new commit SHA and advances the branch head.
     */
    commit(
        linkSet: Map<string, LinkExpression>,
        opts?: {
            parents?: string[];
            author?: string;
            message?: string;
            timestamp?: number;
            advanceHead?: boolean;
        },
    ): string {
        const treeEntries = new Map<string, string>();
        for (const [hash, link] of linkSet) {
            const serialised = serializeLink(link);
            const blobSha = contentSha("blob", serialised);
            this.blobs.set(blobSha, serialised);
            treeEntries.set(hash, blobSha);
        }
        const treeKey = [...treeEntries.entries()]
            .sort()
            .map(([h, b]) => `${h}:${b}`)
            .join(",");
        const treeSha = contentSha("tree", treeKey);
        this.trees.set(treeSha, treeEntries);

        const parents =
            opts?.parents ?? (this.headSha ? [this.headSha] : []);
        const author = opts?.author ?? "did:key:zRemote";
        const timestamp = opts?.timestamp ?? 1_700_000_000;
        const message = opts?.message ?? "remote commit";
        const commitKey = `${treeSha}|${parents.join(",")}|${author}|${timestamp}|${message}`;
        const sha = contentSha("cmmt", commitKey);
        this.commits.set(sha, {
            sha,
            treeSha,
            parents,
            message,
            author: { name: author, email: `${author}@ad4m`, timestamp },
        });
        if (opts?.advanceHead !== false) {
            this.headSha = sha;
            this.etag = `W/"e${++this.etagCounter}"`;
        }
        return sha;
    }

    /** Force the branch head (used to publish a server-side merge). */
    setHead(sha: string): void {
        if (!this.commits.has(sha)) {
            throw new Error(`FakeRemote.setHead: unknown commit ${sha}`);
        }
        this.headSha = sha;
        this.etag = `W/"e${++this.etagCounter}"`;
    }

    /**
     * A `GitHubProvider`-shaped view over this remote. `remote-sync.ts`
     * only calls the four read methods.
     */
    asProvider(): GitHubProvider {
        const self = this;
        const provider = {
            async fetchRef(branch: string, etag?: string): Promise<RefResponse> {
                if (branch !== self.branch || self.headSha === null) {
                    return { notModified: false, sha: self.headSha ?? undefined, etag: self.etag };
                }
                if (etag && etag === self.etag) {
                    return { notModified: true };
                }
                return { notModified: false, sha: self.headSha, etag: self.etag };
            },
            async fetchCommit(sha: string): Promise<CommitResponse> {
                const c = self.commits.get(sha);
                if (!c) throw new Error(`FakeRemote.fetchCommit: unknown ${sha}`);
                return {
                    sha: c.sha,
                    treeSha: c.treeSha,
                    parents: [...c.parents],
                    message: c.message,
                    author: { ...c.author },
                };
            },
            async fetchTreeRecursive(sha: string): Promise<TreeResponse> {
                const t = self.trees.get(sha);
                if (!t) throw new Error(`FakeRemote.fetchTree: unknown ${sha}`);
                return {
                    sha,
                    truncated: false,
                    entries: [...t.entries()].map(([hash, blobSha]) => ({
                        path: `links/${hash}.json`,
                        mode: "100644",
                        type: "blob" as const,
                        sha: blobSha,
                    })),
                };
            },
            async fetchBlob(sha: string): Promise<BlobResponse> {
                const content = self.blobs.get(sha);
                if (content === undefined) {
                    throw new Error(`FakeRemote.fetchBlob: unknown ${sha}`);
                }
                return { sha, content };
            },
        };
        return provider as unknown as GitHubProvider;
    }
}
