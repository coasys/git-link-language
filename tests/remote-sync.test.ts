/**
 * Tests for the JSON-API pull loop.
 *
 * Exercises pullOnce() end-to-end through a mock Transport (so no
 * network), the real GitHubProvider, the fs-adapter, and the
 * operations layer.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { RuntimeAdapter, StorageAdapter, Transport, TransportResponse } from "../src/adapters.js";
import { initRuntime, initStorage, getStorage } from "../src/adapters.js";
import { createFsAdapter, type GitFs } from "../src/fs-adapter.js";
import * as ops from "../src/operations.js";
import * as store from "../src/store.js";
import { GitHubProvider } from "../src/providers/github.js";
import {
    getRemoteSha,
    getRemoteEtag,
    pullOnce,
    startRemoteSync,
} from "../src/remote-sync.js";
import type { LinkExpression, PerspectiveDiff } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

class MockStorage implements StorageAdapter {
    public data = new Map<string, string>();
    get(key: string): string | null { return this.data.get(key) ?? null; }
    put(key: string, value: string): void { this.data.set(key, value); }
    delete(key: string): void { this.data.delete(key); }
    listKeys(prefix?: string): string[] {
        return [...this.data.keys()].filter(k => !prefix || k.startsWith(prefix));
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

class MockTransport implements Transport {
    public calls: MockCall[] = [];
    constructor(public handler: (call: MockCall) => TransportResponse | Promise<TransportResponse>) {}
    async fetch(url: string, method: string, headers: Record<string, string>, body: string) {
        const call = { url, method, headers, body };
        this.calls.push(call);
        return await this.handler(call);
    }
}

function ok(body: object, extraHeaders: Record<string, string> = {}): TransportResponse {
    return { status: 200, headers: extraHeaders, body: JSON.stringify(body) };
}

function notModified(): TransportResponse {
    return { status: 304, headers: {}, body: "" };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_DID = "did:key:zTestAgent";

let fs: GitFs;
let runtime: MockRuntime;

async function setup(): Promise<void> {
    initStorage(new MockStorage());
    runtime = new MockRuntime();
    initRuntime(runtime);
    store.initStore(runtime.hash.bind(runtime));
    fs = createFsAdapter(getStorage());
    await ops.boot({ fs, defaultBranch: "main" });
}

function makeLink(overrides?: Partial<LinkExpression["data"]> & { author?: string; timestamp?: string }): LinkExpression {
    return {
        author: overrides?.author ?? TEST_DID,
        timestamp: overrides?.timestamp ?? "2026-06-12T00:00:00.000Z",
        data: {
            source: overrides?.source ?? "src://A",
            target: overrides?.target ?? "tgt://B",
            predicate: overrides?.predicate ?? "pred://P",
        },
        proof: { signature: "sig", key: "key" },
    };
}

function buildProvider(transport: MockTransport): GitHubProvider {
    return new GitHubProvider(transport, { owner: "o", repo: "r" }, "");
}

// ---------------------------------------------------------------------------
// pullOnce — 304 path
// ---------------------------------------------------------------------------

describe("pullOnce: 304 short-circuit", () => {
    beforeEach(setup);

    it("returns an empty diff and makes no further calls", async () => {
        const transport = new MockTransport(() => notModified());
        const provider = buildProvider(transport);
        const diff = await pullOnce({ provider, branch: "main", intervalMs: 1000, fs, agentDid: TEST_DID });
        assert.deepEqual(diff, { additions: [], removals: [] });
        // Only the ref call — no fetchCommit / fetchTree / fetchBlob
        assert.equal(transport.calls.length, 1);
    });
});

// ---------------------------------------------------------------------------
// pullOnce — unchanged HEAD path
// ---------------------------------------------------------------------------

describe("pullOnce: unchanged HEAD", () => {
    beforeEach(setup);

    it("short-circuits when remote sha matches the tracked sha", async () => {
        // Seed the previously-known remote SHA
        store.setStorageRaw("cache/remote-sha", "same-sha");
        const transport = new MockTransport(() =>
            ok({ object: { sha: "same-sha" } }, { etag: "W/\"fresh\"" }),
        );
        const provider = buildProvider(transport);
        const diff = await pullOnce({ provider, branch: "main", intervalMs: 1000, fs, agentDid: TEST_DID });
        assert.deepEqual(diff, { additions: [], removals: [] });
        // Only the ref call
        assert.equal(transport.calls.length, 1);
        // ETag is refreshed even though no data moved
        assert.equal(getRemoteEtag(), "W/\"fresh\"");
    });
});

// ---------------------------------------------------------------------------
// pullOnce — apply remote tree as additions
// ---------------------------------------------------------------------------

describe("pullOnce: applies remote additions", () => {
    beforeEach(setup);

    it("fetches new blobs, parses links, commits locally, emits diff", async () => {
        const link = makeLink({ source: "remote://A" });
        const linkJson = JSON.stringify(link);
        const linkHash = store.hashLink(link);

        const transport = new MockTransport(({ url }) => {
            if (url.endsWith("/git/refs/heads/main")) {
                return ok({ object: { sha: "commit-1" } }, { etag: "W/\"e1\"" });
            }
            if (url.includes("/git/commits/commit-1")) {
                return ok({
                    sha: "commit-1",
                    tree: { sha: "tree-1" },
                    parents: [],
                    message: "initial",
                    author: { name: "remote", email: "r@ad4m", date: "2026-06-12T00:00:00Z" },
                });
            }
            if (url.includes("/git/trees/tree-1")) {
                return ok({
                    sha: "tree-1",
                    tree: [
                        { path: `links/${linkHash}.json`, type: "blob", mode: "100644", sha: "blob-1" },
                    ],
                });
            }
            if (url.includes("/git/blobs/blob-1")) {
                return ok({ sha: "blob-1", content: btoa(linkJson), encoding: "base64" });
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const provider = buildProvider(transport);
        const diff = await pullOnce({ provider, branch: "main", intervalMs: 1000, fs, agentDid: TEST_DID });

        assert.equal(diff.additions.length, 1);
        assert.equal(diff.additions[0].data.source, "remote://A");
        assert.equal(diff.removals.length, 0);

        // Tracked state
        assert.equal(getRemoteSha(), "commit-1");
        assert.equal(getRemoteEtag(), "W/\"e1\"");

        // Local cache reflects the addition
        assert.equal(store.allLinks().links.length, 1);

        // A PerspectiveDiff was emitted (via ops.commit → runtime)
        assert.ok(runtime.emittedDiffs.length >= 1);
    });
});

// ---------------------------------------------------------------------------
// pullOnce — removals when remote drops a link
// ---------------------------------------------------------------------------

describe("pullOnce: applies remote removals", () => {
    beforeEach(setup);

    it("removes links present locally but absent from the remote tree", async () => {
        const link = makeLink({ source: "to-be-removed" });
        await ops.commit({
            fs,
            diff: { additions: [link], removals: [] },
            authorDid: TEST_DID,
        });
        const linkHash = store.hashLink(link);
        assert.equal(store.allLinks().links.length, 1);

        const transport = new MockTransport(({ url }) => {
            if (url.endsWith("/git/refs/heads/main")) {
                return ok({ object: { sha: "commit-2" } });
            }
            if (url.includes("/git/commits/commit-2")) {
                return ok({
                    sha: "commit-2",
                    tree: { sha: "tree-2" },
                    parents: [],
                    message: "drop",
                    author: { name: "r", email: "r@ad4m", date: "2026-06-12T00:00:00Z" },
                });
            }
            if (url.includes("/git/trees/tree-2")) {
                // Empty tree → all local links should be removed
                return ok({ sha: "tree-2", tree: [] });
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const provider = buildProvider(transport);
        const diff = await pullOnce({ provider, branch: "main", intervalMs: 1000, fs, agentDid: TEST_DID });

        assert.equal(diff.additions.length, 0);
        assert.equal(diff.removals.length, 1);
        assert.equal(diff.removals[0].data.source, "to-be-removed");
        assert.equal(store.allLinks().links.length, 0);
        void linkHash;
    });
});

// ---------------------------------------------------------------------------
// pullOnce — no link-set change
// ---------------------------------------------------------------------------

describe("pullOnce: no link-set change", () => {
    beforeEach(setup);

    it("updates tracking but does not produce a commit when the tree matches", async () => {
        const link = makeLink({ source: "stable" });
        await ops.commit({
            fs,
            diff: { additions: [link], removals: [] },
            authorDid: TEST_DID,
        });
        const linkHash = store.hashLink(link);

        const transport = new MockTransport(({ url }) => {
            if (url.endsWith("/git/refs/heads/main")) {
                return ok({ object: { sha: "commit-3" } }, { etag: "W/\"e3\"" });
            }
            if (url.includes("/git/commits/commit-3")) {
                return ok({
                    sha: "commit-3",
                    tree: { sha: "tree-3" },
                    parents: [],
                    message: "no-op",
                    author: { name: "r", email: "r@ad4m", date: "2026-06-12T00:00:00Z" },
                });
            }
            if (url.includes("/git/trees/tree-3")) {
                return ok({
                    sha: "tree-3",
                    tree: [
                        { path: `links/${linkHash}.json`, type: "blob", mode: "100644", sha: "blob-3" },
                    ],
                });
            }
            throw new Error(`Unexpected URL: ${url}`);
        });

        const emittedBefore = runtime.emittedDiffs.length;
        const provider = buildProvider(transport);
        const diff = await pullOnce({ provider, branch: "main", intervalMs: 1000, fs, agentDid: TEST_DID });

        assert.deepEqual(diff, { additions: [], removals: [] });
        // Tracking updated even though diff is empty
        assert.equal(getRemoteSha(), "commit-3");
        assert.equal(getRemoteEtag(), "W/\"e3\"");
        // No new emission
        assert.equal(runtime.emittedDiffs.length, emittedBefore);
    });
});

// ---------------------------------------------------------------------------
// startRemoteSync — lifecycle
// ---------------------------------------------------------------------------

describe("startRemoteSync: lifecycle", () => {
    beforeEach(setup);

    it("stop() prevents subsequent ticks", async () => {
        const transport = new MockTransport(() => notModified());
        const provider = buildProvider(transport);
        const handle = startRemoteSync({
            provider,
            branch: "main",
            intervalMs: 10,
            fs,
            agentDid: TEST_DID,
        });
        handle.stop();
        // Wait long enough that a tick would have fired if not stopped
        await new Promise((r) => setTimeout(r, 50));
        // No calls because stop() ran before the first tick fired
        assert.equal(transport.calls.length, 0);
    });

    it("pullOnce() on the handle triggers an immediate pull", async () => {
        const transport = new MockTransport(() => notModified());
        const provider = buildProvider(transport);
        const handle = startRemoteSync({
            provider,
            branch: "main",
            intervalMs: 60_000,
            fs,
            agentDid: TEST_DID,
        });
        try {
            const diff = await handle.pullOnce();
            assert.deepEqual(diff, { additions: [], removals: [] });
            assert.equal(transport.calls.length, 1);
        } finally {
            handle.stop();
        }
    });
});
