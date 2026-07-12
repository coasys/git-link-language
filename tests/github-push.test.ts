/**
 * Tests for the GitHub push path.
 *
 * Two layers:
 *   1. GitHubProvider write methods against a request-recording mock
 *      Transport — asserting endpoints, methods, and JSON bodies.
 *   2. pushOnce() end-to-end. The mock Transport is backed by an
 *      independent, real isomorphic-git repo ("the remote"): each POSTed
 *      object is written into it, so the SHA it returns is the genuine Git
 *      OID for that content. That makes `returnedSha === localOid` a real
 *      content-addressing property (not a hardcoded echo), lets us assert
 *      the topological POST order (blobs → tree → commit, parents first),
 *      and drives the 422 → pull + retry path with a real divergent remote.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type {
    RuntimeAdapter,
    StorageAdapter,
    Transport,
    TransportResponse,
} from "../src/adapters.js";
import { initRuntime, initStorage, getStorage } from "../src/adapters.js";
import { createFsAdapter, type GitFs } from "../src/fs-adapter.js";
import * as ops from "../src/operations.js";
import * as gitops from "../src/git.js";
import * as store from "../src/store.js";
import { GitHubProvider } from "../src/providers/github.js";
import {
    getRemoteSha,
    pullOnce,
    pushOnce,
    setRemoteSha,
} from "../src/remote-sync.js";
import type { LinkExpression, PerspectiveDiff } from "../src/types.js";

// ---------------------------------------------------------------------------
// Shared mocks (storage + runtime + a deterministic link hash)
// ---------------------------------------------------------------------------

class MockStorage implements StorageAdapter {
    public data = new Map<string, string>();
    get(key: string): string | null {
        return this.data.get(key) ?? null;
    }
    put(key: string, value: string): void {
        this.data.set(key, value);
    }
    delete(key: string): void {
        this.data.delete(key);
    }
    listKeys(prefix?: string): string[] {
        return [...this.data.keys()].filter((k) => !prefix || k.startsWith(prefix));
    }
}

class MockRuntime implements RuntimeAdapter {
    public emittedDiffs: PerspectiveDiff[] = [];
    hash(data: string): string {
        let h = 0;
        for (let i = 0; i < data.length; i++) {
            h = ((h << 5) - h + data.charCodeAt(i)) | 0;
        }
        return `Qm${Math.abs(h).toString(16)}`;
    }
    emitSignal(_data: string): void {}
    emitPerspectiveDiff(diff: unknown): void {
        this.emittedDiffs.push(diff as PerspectiveDiff);
    }
}

interface MockCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
}

class RecordingTransport implements Transport {
    public calls: MockCall[] = [];
    constructor(
        public handler: (
            call: MockCall,
        ) => TransportResponse | Promise<TransportResponse>,
    ) {}
    async fetch(
        url: string,
        method: string,
        headers: Record<string, string>,
        body: string,
    ): Promise<TransportResponse> {
        const call = { url, method, headers, body };
        this.calls.push(call);
        return await this.handler(call);
    }
}

function json(body: object, code = 200): TransportResponse {
    return { status: code, headers: {}, body: JSON.stringify(body) };
}

const TEST_DID = "did:key:zPushAgent";

function makeLink(source: string): LinkExpression {
    return {
        author: TEST_DID,
        timestamp: "2026-06-12T00:00:00.000Z",
        data: { source, target: "tgt://B", predicate: "pred://P" },
        proof: { signature: "sig", key: "key" },
    };
}

// ---------------------------------------------------------------------------
// Local repo fixture (the pushing replica)
// ---------------------------------------------------------------------------

let fs: GitFs;
let runtime: MockRuntime;

async function setupLocal(): Promise<void> {
    initStorage(new MockStorage());
    runtime = new MockRuntime();
    initRuntime(runtime);
    store.initStore(runtime.hash.bind(runtime));
    fs = createFsAdapter(getStorage());
    await ops.boot({ fs, defaultBranch: "main" });
}

async function commitLocal(diff: PerspectiveDiff): Promise<string> {
    return await ops.commit({ fs, diff, authorDid: TEST_DID });
}

// ---------------------------------------------------------------------------
// A content-addressed "remote": an independent real Git repo that each
// POST writes into, so its returned SHAs are genuine Git OIDs. Ref updates
// are checked for fast-forward against the local object graph it has
// accumulated.
// ---------------------------------------------------------------------------

class GitHubWriteFake {
    readonly transport: RecordingTransport;
    private readonly remoteFs: GitFs;
    private refSha: string | null;
    // Force a non-fast-forward rejection on the next N updateRef PATCH calls.
    private rejectNextRefUpdates = 0;

    constructor(initialRefSha: string | null = null) {
        this.remoteFs = createFsAdapter(new MockStorage());
        this.refSha = initialRefSha;
        this.transport = new RecordingTransport((call) => this.handle(call));
    }

    get head(): string | null {
        return this.refSha;
    }

    /** Seed the remote's object store + ref from an existing repo commit. */
    async seedFrom(sourceFs: GitFs, headSha: string): Promise<void> {
        await gitops.ensureRepoInit(this.remoteFs, "main");
        await copyCommitChain(sourceFs, this.remoteFs, headSha);
        await gitops.setBranch(this.remoteFs, "main", headSha);
        this.refSha = headSha;
    }

    failNextRefUpdate(times = 1): void {
        this.rejectNextRefUpdates = times;
    }

    private async handle(call: MockCall): Promise<TransportResponse> {
        const { url, method } = call;
        await gitops.ensureRepoInit(this.remoteFs, "main");

        // --- reads (used by pullOnce during the 422 retry path) ---
        if (method === "GET" && url.includes("/git/refs/heads/")) {
            if (!this.refSha) {
                return { status: 404, headers: {}, body: "{}" };
            }
            return json({ object: { sha: this.refSha } });
        }
        if (method === "GET" && url.includes("/git/commits/")) {
            const sha = url.split("/git/commits/")[1];
            const c = await gitops.readCommitObject(this.remoteFs, sha);
            if (!c) return { status: 404, headers: {}, body: "{}" };
            return json({
                sha,
                tree: { sha: c.tree },
                parents: c.parent.map((p) => ({ sha: p })),
                message: c.message,
                author: {
                    name: c.author.name,
                    email: c.author.email,
                    date: new Date(c.author.timestamp * 1000).toISOString(),
                },
            });
        }
        if (method === "GET" && url.includes("/git/trees/")) {
            const sha = url.split("/git/trees/")[1].replace(/\?.*$/, "");
            const blobs = await gitops.linkBlobOidsAt(this.remoteFs, sha);
            return json({
                sha,
                truncated: false,
                tree: [...blobs.entries()].map(([hash, oid]) => ({
                    path: `links/${hash}.json`,
                    mode: "100644",
                    type: "blob",
                    sha: oid,
                })),
            });
        }
        if (method === "GET" && url.includes("/git/blobs/")) {
            const sha = url.split("/git/blobs/")[1];
            const content = await readBlobByOid(this.remoteFs, sha);
            if (content === null) return { status: 404, headers: {}, body: "{}" };
            return json({ sha, content: btoa(content), encoding: "base64" });
        }

        // --- writes ---
        if (method === "POST" && url.endsWith("/git/blobs")) {
            const { content } = JSON.parse(call.body);
            const oid = await gitops.writeLinkBlob(this.remoteFs, content);
            return json({ sha: oid });
        }
        if (method === "POST" && url.endsWith("/git/trees")) {
            const { tree } = JSON.parse(call.body) as {
                tree: Array<{ path: string; sha: string }>;
            };
            const linkBlobs = new Map<string, string>();
            for (const entry of tree) {
                const hash = entry.path.replace(/^links\//, "").replace(/\.json$/, "");
                linkBlobs.set(hash, entry.sha);
            }
            const oid = await gitops.writeRootTreeFromLinkBlobs(
                this.remoteFs,
                linkBlobs,
            );
            return json({ sha: oid });
        }
        if (method === "POST" && url.endsWith("/git/commits")) {
            const parsed = JSON.parse(call.body) as {
                tree: string;
                parents: string[];
                message: string;
                author: { name: string; email: string; date: string };
                committer?: { name: string; email: string; date: string };
            };
            // Faithfully reconstruct the commit from the posted identities —
            // committer defaults to author, exactly as GitHub does — so the
            // OID this "remote" returns is the genuine content hash.
            const committer = parsed.committer ?? parsed.author;
            const toIdentity = (id: {
                name: string;
                email: string;
                date: string;
            }) => ({
                name: id.name,
                email: id.email,
                timestamp: Math.floor(new Date(id.date).getTime() / 1000),
                timezoneOffset: 0,
            });
            const oid = await gitops.writeCommitObject(this.remoteFs, {
                tree: parsed.tree,
                parent: parsed.parents,
                author: toIdentity(parsed.author),
                committer: toIdentity(committer),
                message: parsed.message,
            });
            return json({ sha: oid });
        }
        if (method === "PATCH" && url.includes("/git/refs/heads/")) {
            if (this.rejectNextRefUpdates > 0) {
                this.rejectNextRefUpdates -= 1;
                return { status: 422, headers: {}, body: "{}" };
            }
            const { sha } = JSON.parse(call.body);
            this.refSha = sha;
            await gitops.setBranch(this.remoteFs, "main", sha);
            return json({ ref: "refs/heads/main", object: { sha } });
        }
        if (method === "POST" && url.endsWith("/git/refs")) {
            const { sha } = JSON.parse(call.body);
            this.refSha = sha;
            await gitops.setBranch(this.remoteFs, "main", sha);
            return json({ ref: "refs/heads/main", object: { sha } });
        }

        throw new Error(`GitHubWriteFake: unhandled ${method} ${url}`);
    }
}

async function readBlobByOid(fs: GitFs, oid: string): Promise<string | null> {
    // Search a small repo's HEAD tree for a blob with this oid.
    const head = await gitops.currentHead(fs);
    if (!head) return null;
    const blobs = await gitops.linkBlobOidsAt(fs, head);
    for (const [hash, blobOid] of blobs) {
        if (blobOid === oid) return await gitops.readLinkAt(fs, head, hash);
    }
    return null;
}

async function copyCommitChain(
    src: GitFs,
    dst: GitFs,
    headSha: string,
): Promise<void> {
    // Replay commits oldest → newest into dst so their OIDs reproduce.
    const order: string[] = [];
    const seen = new Set<string>();
    const stack = [headSha];
    const commits = new Map<string, gitops.RawCommitObject>();
    while (stack.length) {
        const sha = stack.pop() as string;
        if (seen.has(sha)) continue;
        seen.add(sha);
        const c = await gitops.readCommitObject(src, sha);
        if (!c) continue;
        commits.set(sha, c);
        for (const p of c.parent) stack.push(p);
    }
    // naive topo: repeatedly emit commits whose parents are all emitted
    const emitted = new Set<string>();
    while (order.length < commits.size) {
        for (const [sha, c] of commits) {
            if (emitted.has(sha)) continue;
            if (c.parent.every((p) => emitted.has(p) || !commits.has(p))) {
                order.push(sha);
                emitted.add(sha);
            }
        }
    }
    for (const sha of order) {
        const c = commits.get(sha)!;
        const linkBlobs = await gitops.linkBlobOidsAt(src, sha);
        const copied = new Map<string, string>();
        for (const [hash] of linkBlobs) {
            const content = await gitops.readLinkAt(src, sha, hash);
            if (content === null) continue;
            copied.set(hash, await gitops.writeLinkBlob(dst, content));
        }
        await gitops.writeRootTreeFromLinkBlobs(dst, copied);
        await gitops.writeCommitObject(dst, c);
    }
}

function provider(t: Transport): GitHubProvider {
    return new GitHubProvider(t, { owner: "o", repo: "r" }, "ghp_TOK");
}

// ===========================================================================
// Layer 1 — write-method payloads / endpoints
// ===========================================================================

describe("GitHubProvider.createBlob", () => {
    it("POSTs {content, encoding:'utf-8'} to /git/blobs and returns the sha", async () => {
        const t = new RecordingTransport(() => json({ sha: "blobsha" }));
        const result = await provider(t).createBlob('{"a":1}');
        assert.equal(result.sha, "blobsha");
        const call = t.calls[0];
        assert.equal(call.method, "POST");
        assert.equal(call.url, "https://api.github.com/repos/o/r/git/blobs");
        assert.deepEqual(JSON.parse(call.body), {
            content: '{"a":1}',
            encoding: "utf-8",
        });
        assert.equal(call.headers["Authorization"], "token ghp_TOK");
    });

    it("throws on a non-2xx response", async () => {
        const t = new RecordingTransport(() => json({ message: "bad" }, 500));
        await assert.rejects(() => provider(t).createBlob("x"), /HTTP 500/);
    });
});

describe("GitHubProvider.createTree", () => {
    it("POSTs {tree:[{path,mode,type,sha}]} to /git/trees", async () => {
        const t = new RecordingTransport(() => json({ sha: "treesha" }));
        const result = await provider(t).createTree([
            { path: "links/Qm.json", mode: "100644", type: "blob", sha: "b1" },
        ]);
        assert.equal(result.sha, "treesha");
        const call = t.calls[0];
        assert.equal(call.url, "https://api.github.com/repos/o/r/git/trees");
        assert.deepEqual(JSON.parse(call.body), {
            tree: [{ path: "links/Qm.json", mode: "100644", type: "blob", sha: "b1" }],
        });
    });
});

describe("GitHubProvider.createCommit", () => {
    it("POSTs {message,tree,parents,author,committer} to /git/commits, defaulting committer to author", async () => {
        const t = new RecordingTransport(() => json({ sha: "commitsha" }));
        const result = await provider(t).createCommit({
            tree: "t1",
            parents: ["p1"],
            message: "diff: +1 -0",
            author: { name: "did:key:z", email: "z@ad4m", date: "2026-06-12T00:00:00Z" },
        });
        assert.equal(result.sha, "commitsha");
        const call = t.calls[0];
        assert.equal(call.url, "https://api.github.com/repos/o/r/git/commits");
        // committer defaults to author so GitHub reconstructs a byte-identical
        // object (it would otherwise stamp server time and change the SHA).
        assert.deepEqual(JSON.parse(call.body), {
            message: "diff: +1 -0",
            tree: "t1",
            parents: ["p1"],
            author: { name: "did:key:z", email: "z@ad4m", date: "2026-06-12T00:00:00Z" },
            committer: { name: "did:key:z", email: "z@ad4m", date: "2026-06-12T00:00:00Z" },
        });
    });

    it("sends an explicit committer distinct from the author when supplied", async () => {
        const t = new RecordingTransport(() => json({ sha: "commitsha" }));
        await provider(t).createCommit({
            tree: "t1",
            parents: [],
            message: "m",
            author: { name: "A", email: "a@ad4m", date: "2026-06-12T00:00:00Z" },
            committer: { name: "C", email: "c@ad4m", date: "2026-06-13T00:00:00Z" },
        });
        assert.deepEqual(JSON.parse(t.calls[0].body), {
            message: "m",
            tree: "t1",
            parents: [],
            author: { name: "A", email: "a@ad4m", date: "2026-06-12T00:00:00Z" },
            committer: { name: "C", email: "c@ad4m", date: "2026-06-13T00:00:00Z" },
        });
    });
});

describe("GitHubProvider.updateRef", () => {
    it("PATCHes the ref and resolves ok on 2xx", async () => {
        const t = new RecordingTransport(() => json({ ref: "refs/heads/main" }));
        const r = await provider(t).updateRef("main", "newsha");
        assert.deepEqual(r, { ok: true });
        assert.equal(t.calls[0].method, "PATCH");
        assert.equal(
            t.calls[0].url,
            "https://api.github.com/repos/o/r/git/refs/heads/main",
        );
        assert.deepEqual(JSON.parse(t.calls[0].body), { sha: "newsha", force: false });
    });

    it("resolves {ok:false, notFastForward:true} on 422", async () => {
        const t = new RecordingTransport(() => json({ message: "not ff" }, 422));
        const r = await provider(t).updateRef("main", "newsha");
        assert.deepEqual(r, { ok: false, notFastForward: true });
    });

    it("creates the ref via POST when PATCH 404s", async () => {
        const t = new RecordingTransport((call) =>
            call.method === "PATCH"
                ? json({ message: "not found" }, 404)
                : json({ ref: "refs/heads/main" }),
        );
        const r = await provider(t).updateRef("main", "newsha");
        assert.deepEqual(r, { ok: true });
        assert.equal(t.calls.length, 2);
        assert.equal(t.calls[1].method, "POST");
        assert.equal(t.calls[1].url, "https://api.github.com/repos/o/r/git/refs");
        assert.deepEqual(JSON.parse(t.calls[1].body), {
            ref: "refs/heads/main",
            sha: "newsha",
        });
    });
});

// ===========================================================================
// Layer 2 — pushOnce end-to-end
// ===========================================================================

describe("pushOnce: first push of a fresh local history", () => {
    beforeEach(setupLocal);

    it("POSTs objects bottom-up and moves the ref to the local head", async () => {
        await commitLocal({ additions: [makeLink("a://1")], removals: [] });
        const head2 = await commitLocal({ additions: [makeLink("a://2")], removals: [] });
        const localHead = await gitops.currentHead(fs);
        assert.equal(localHead, head2);

        const remote = new GitHubWriteFake(null);
        const result = await pushOnce({
            provider: provider(remote.transport),
            branch: "main",
            intervalMs: 0,
            fs,
            agentDid: TEST_DID,
        });

        assert.equal(result.ok, true);
        assert.equal(result.pushed, 2, "both local commits pushed");
        // The remote ref now equals the local head — a real content-addressed
        // match (the fake reproduced every OID from the posted bytes).
        assert.equal(remote.head, localHead);
        assert.equal(getRemoteSha(), localHead);
    });

    it("POSTs in topological order: each commit's blobs+tree precede it, parents before children", async () => {
        const c1 = await commitLocal({ additions: [makeLink("a://1")], removals: [] });
        const c2 = await commitLocal({ additions: [makeLink("a://2")], removals: [] });

        const remote = new GitHubWriteFake(null);
        await pushOnce({
            provider: provider(remote.transport),
            branch: "main",
            intervalMs: 0,
            fs,
            agentDid: TEST_DID,
        });

        const seq = remote.transport.calls.map((c) => `${c.method} ${endpoint(c.url)}`);

        // Commit POSTs happen in parent-before-child order.
        const commitPosts = remote.transport.calls
            .filter((c) => c.method === "POST" && c.url.endsWith("/git/commits"))
            .map((c) => JSON.parse(c.body) as { parents: string[] });
        assert.equal(commitPosts.length, 2);
        // First commit posted is the root (no parents); second names c1 parent.
        assert.deepEqual(commitPosts[0].parents, []);
        assert.deepEqual(commitPosts[1].parents, [c1]);

        // For each commit POST, a tree POST precedes it, and at least one blob
        // POST precedes that tree.
        const firstTree = seq.indexOf("POST trees");
        const firstCommit = seq.indexOf("POST commits");
        const firstBlob = seq.indexOf("POST blobs");
        assert.ok(firstBlob >= 0 && firstTree > firstBlob && firstCommit > firstTree,
            `expected blobs<trees<commits order, got: ${seq.join(", ")}`);

        // The ref move is last.
        assert.ok(
            seq[seq.length - 1] === "PATCH refs" || seq[seq.length - 1] === "POST refs",
            `ref update should be last, got ${seq[seq.length - 1]}`,
        );
        void c2;
    });
});

describe("pushOnce: incremental push only sends new commits", () => {
    beforeEach(setupLocal);

    it("skips commits already on the remote (mirror boundary)", async () => {
        const c1 = await commitLocal({ additions: [makeLink("a://1")], removals: [] });
        // Seed a remote that already has c1, and record it as mirrored.
        const remote = new GitHubWriteFake(null);
        await remote.seedFrom(fs, c1);
        setRemoteSha(c1);
        store.setStorageRaw(`cache/mirror/${c1}`, c1); // remote sha → local twin (== itself)

        const c2 = await commitLocal({ additions: [makeLink("a://2")], removals: [] });
        const result = await pushOnce({
            provider: provider(remote.transport),
            branch: "main",
            intervalMs: 0,
            fs,
            agentDid: TEST_DID,
        });

        assert.equal(result.ok, true);
        assert.equal(result.pushed, 1, "only the new commit c2 is pushed");
        assert.equal(remote.head, c2);
        // Exactly one commit POST (for c2), not two.
        const commitPosts = remote.transport.calls.filter(
            (c) => c.method === "POST" && c.url.endsWith("/git/commits"),
        );
        assert.equal(commitPosts.length, 1);
    });
});

describe("pushOnce: non-fast-forward triggers pull + retry", () => {
    beforeEach(setupLocal);

    it("pulls, converges, then re-pushes once and succeeds", async () => {
        const c1 = await commitLocal({ additions: [makeLink("shared://1")], removals: [] });

        // Remote already advanced past c1 with its own commit the local doesn't
        // have yet. Build it in the remote's store and point the ref at it.
        const remote = new GitHubWriteFake(null);
        await remote.seedFrom(fs, c1);
        setRemoteSha(c1);
        store.setStorageRaw(`cache/mirror/${c1}`, c1);

        // Local makes its own new commit → divergence from the remote's next.
        await commitLocal({ additions: [makeLink("local://2")], removals: [] });

        // Force the FIRST ref update to be rejected as non-fast-forward. The
        // push path then pulls (no-op here, remote == c1 tracked) and retries;
        // on retry the ref update is accepted.
        remote.failNextRefUpdate(1);

        const result = await pushOnce({
            provider: provider(remote.transport),
            branch: "main",
            intervalMs: 0,
            fs,
            agentDid: TEST_DID,
        });

        // The retry path ran (two ref-update attempts) and ultimately succeeded.
        const refAttempts = remote.transport.calls.filter(
            (c) =>
                (c.method === "PATCH" && c.url.includes("/git/refs/heads/")) ||
                (c.method === "POST" && c.url.endsWith("/git/refs")),
        );
        assert.ok(refAttempts.length >= 2, "expected a retried ref update");
        assert.equal(result.ok, true);
        assert.equal(remote.head, await gitops.currentHead(fs));
    });
});

describe("pushOnce: SHA mismatch is a hard error", () => {
    beforeEach(setupLocal);

    it("throws when the remote returns a different blob sha than the local OID", async () => {
        await commitLocal({ additions: [makeLink("a://1")], removals: [] });
        // A liar remote that returns a bogus blob sha.
        const t = new RecordingTransport((call) => {
            if (call.method === "POST" && call.url.endsWith("/git/blobs")) {
                return json({ sha: "0000000000000000000000000000000000000000" });
            }
            return json({ sha: "whatever" });
        });
        await assert.rejects(
            () =>
                pushOnce({
                    provider: provider(t),
                    branch: "main",
                    intervalMs: 0,
                    fs,
                    agentDid: TEST_DID,
                }),
            /remote blob SHA .* != local OID/,
        );
    });
});

describe("pushOnce: canPush=false skips push entirely", () => {
    beforeEach(setupLocal);

    it("issues no HTTP calls and reports unsupported", async () => {
        await commitLocal({ additions: [makeLink("a://1")], removals: [] });
        let calls = 0;
        const readonlyProvider = {
            canPush: false,
            fetchRef: () => Promise.reject(new Error("no")),
            fetchCommit: () => Promise.reject(new Error("no")),
            fetchTreeRecursive: () => Promise.reject(new Error("no")),
            fetchBlob: () => Promise.reject(new Error("no")),
            createBlob: () => {
                calls++;
                return Promise.reject(new Error("no"));
            },
            createTree: () => {
                calls++;
                return Promise.reject(new Error("no"));
            },
            createCommit: () => {
                calls++;
                return Promise.reject(new Error("no"));
            },
            updateRef: () => {
                calls++;
                return Promise.reject(new Error("no"));
            },
        };
        const result = await pushOnce({
            provider: readonlyProvider,
            branch: "main",
            intervalMs: 0,
            fs,
            agentDid: TEST_DID,
        });
        assert.deepEqual(result, { ok: false, pushed: 0, unsupported: true });
        assert.equal(calls, 0, "no write methods invoked");
    });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function endpoint(url: string): string {
    const m = url.match(/\/git\/(blobs|trees|commits|refs)/);
    return m ? m[1] : url;
}
