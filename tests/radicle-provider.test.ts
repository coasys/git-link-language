/**
 * Tests for the Radicle provider.
 *
 * URL/RID parsing is exercised directly; HTTP reads go through a mock
 * Transport so the suite has no network dependency. Endpoint shapes match
 * the verified `radicle-httpd` API (base `/api/v1`, project doc `head`,
 * `commits/:sha`, `tree/:commit/links`, `blob/:commit/:path`). Writes are
 * asserted to reject with the documented capability-boundary error.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Transport, TransportResponse } from "../src/adapters.js";
import {
    RADICLE_PUSH_UNSUPPORTED,
    RadicleProvider,
    parseRadicleUrl,
} from "../src/providers/radicle.js";

const RID = "rad:z4GypKmh1gkEfmkXtarcYnkvtFUfE";

// ---------------------------------------------------------------------------
// parseRadicleUrl
// ---------------------------------------------------------------------------

describe("parseRadicleUrl", () => {
    it("accepts a bare RID and defaults the httpd origin", () => {
        const ref = parseRadicleUrl(RID);
        assert.deepEqual(ref, {
            baseUrl: "https://seed.radicle.garden",
            rid: RID,
        });
    });

    it("accepts an explorer /nodes/<host>/<rid> URL and derives the origin", () => {
        const ref = parseRadicleUrl(
            `https://app.radicle.xyz/nodes/seed.example.com/${RID}`,
        );
        assert.deepEqual(ref, { baseUrl: "https://seed.example.com", rid: RID });
    });

    it("accepts an API-form URL and keeps its origin", () => {
        const ref = parseRadicleUrl(
            `https://seed.example.com/api/v1/projects/${RID}`,
        );
        assert.deepEqual(ref, { baseUrl: "https://seed.example.com", rid: RID });
    });

    it("accepts a plain https://<host>/<rid> URL", () => {
        const ref = parseRadicleUrl(`http://localhost:8080/${RID}`);
        assert.deepEqual(ref, { baseUrl: "http://localhost:8080", rid: RID });
    });

    it("rejects non-Radicle inputs", () => {
        assert.equal(parseRadicleUrl(""), null);
        assert.equal(parseRadicleUrl("https://github.com/o/r"), null);
        assert.equal(parseRadicleUrl("rad:not-a-valid-multibase-0OIl"), null);
        assert.equal(parseRadicleUrl("just some text"), null);
    });
});

// ---------------------------------------------------------------------------
// Mock transport
// ---------------------------------------------------------------------------

interface MockCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
}

class MockTransport implements Transport {
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

function ok(body: object): TransportResponse {
    return { status: 200, headers: {}, body: JSON.stringify(body) };
}

function status(code: number): TransportResponse {
    return { status: code, headers: {}, body: "" };
}

const API = `https://seed.example.com/api/v1/projects/${encodeURIComponent(RID)}`;

function provider(transport: MockTransport, token = ""): RadicleProvider {
    return new RadicleProvider(
        transport,
        { baseUrl: "https://seed.example.com", rid: RID },
        token,
    );
}

// ---------------------------------------------------------------------------
// canPush
// ---------------------------------------------------------------------------

describe("RadicleProvider.canPush", () => {
    it("is false (radicle-httpd exposes no JSON write API)", () => {
        assert.equal(provider(new MockTransport(() => ok({}))).canPush, false);
    });
});

// ---------------------------------------------------------------------------
// fetchRef — reads the project doc `head`
// ---------------------------------------------------------------------------

describe("RadicleProvider.fetchRef", () => {
    it("returns the project doc head as the branch sha", async () => {
        const transport = new MockTransport(() =>
            ok({ name: "r", defaultBranch: "main", head: "deadbeef", id: RID }),
        );
        const result = await provider(transport).fetchRef("main");
        assert.equal(result.notModified, false);
        assert.equal(result.sha, "deadbeef");
        // Hits the project doc endpoint (no per-branch ref endpoint exists).
        assert.equal(transport.calls[0].url, API);
        assert.equal(transport.calls[0].method, "GET");
    });

    it("sends a Bearer Authorization header when a token is set", async () => {
        const transport = new MockTransport(() => ok({ head: "abc" }));
        await provider(transport, "rad-token").fetchRef("main");
        assert.equal(
            transport.calls[0].headers["Authorization"],
            "Bearer rad-token",
        );
    });

    it("throws when the project doc lacks a head", async () => {
        const transport = new MockTransport(() => ok({ name: "r" }));
        await assert.rejects(() => provider(transport).fetchRef("main"), /head/);
    });
});

// ---------------------------------------------------------------------------
// fetchCommit — maps the { commit: {...} } envelope
// ---------------------------------------------------------------------------

describe("RadicleProvider.fetchCommit", () => {
    it("extracts id, parents, committer identity, and the commit-sha tree handle", async () => {
        const transport = new MockTransport(() =>
            ok({
                commit: {
                    id: "c1",
                    summary: "did-signed diff",
                    description: "",
                    parents: ["p1", "p2"],
                    author: { name: "did:key:zAuthor", email: "a@ad4m" },
                    committer: {
                        name: "did:key:zCommitter",
                        email: "c@ad4m",
                        time: 1_700_000_000,
                    },
                },
            }),
        );
        const commit = await provider(transport).fetchCommit("c1");
        assert.equal(commit.sha, "c1");
        // Trees/blobs are addressed by commit SHA + path, so the tree handle
        // is the commit SHA itself.
        assert.equal(commit.treeSha, "c1");
        assert.deepEqual(commit.parents, ["p1", "p2"]);
        assert.equal(commit.message, "did-signed diff");
        assert.equal(commit.author.name, "did:key:zCommitter");
        assert.equal(commit.author.timestamp, 1_700_000_000);
        assert.equal(
            transport.calls[0].url,
            `${API}/commits/c1`,
        );
    });

    it("joins summary and description into the message", async () => {
        const transport = new MockTransport(() =>
            ok({
                commit: {
                    id: "c2",
                    summary: "title",
                    description: "body line",
                    parents: [],
                    committer: { name: "n", email: "e", time: 1 },
                },
            }),
        );
        const commit = await provider(transport).fetchCommit("c2");
        assert.equal(commit.message, "title\n\nbody line");
    });
});

// ---------------------------------------------------------------------------
// fetchTreeRecursive + fetchBlob — commit+path addressing
// ---------------------------------------------------------------------------

describe("RadicleProvider.fetchTreeRecursive + fetchBlob", () => {
    it("lists links/ at the commit and resolves blob content by recorded path", async () => {
        const linkJson = JSON.stringify({ hello: "world" });
        const transport = new MockTransport(({ url }) => {
            if (url === `${API}/tree/commit-1/links`) {
                return ok({
                    entries: [
                        { path: "links/Qmaaa.json", oid: "blobA", name: "Qmaaa.json", kind: "blob" },
                        { path: "links/Qmbbb.json", oid: "blobB", name: "Qmbbb.json", kind: "blob" },
                        // a nested tree entry is ignored by the flat mapping
                        { path: "links/sub", oid: "treeX", name: "sub", kind: "tree" },
                    ],
                });
            }
            if (url === `${API}/blob/commit-1/links/Qmaaa.json`) {
                return ok({ binary: false, content: linkJson, path: "links/Qmaaa.json" });
            }
            throw new Error(`unexpected url ${url}`);
        });

        const p = provider(transport);
        const tree = await p.fetchTreeRecursive("commit-1");
        // Only the two blob entries survive; the nested tree is dropped.
        assert.equal(tree.entries.length, 2);
        assert.equal(tree.entries[0].path, "links/Qmaaa.json");
        assert.equal(tree.entries[0].sha, "blobA");
        assert.equal(tree.entries[0].type, "blob");

        // fetchBlob resolves the oid recorded during the tree walk back to
        // its commit+path endpoint.
        const blob = await p.fetchBlob("blobA");
        assert.equal(blob.sha, "blobA");
        assert.equal(blob.content, linkJson);
    });

    it("treats a missing links/ directory (404) as an empty tree", async () => {
        const transport = new MockTransport(() => status(404));
        const tree = await provider(transport).fetchTreeRecursive("empty-commit");
        assert.deepEqual(tree.entries, []);
    });

    it("throws on fetchBlob for an oid never seen in a tree walk", async () => {
        const transport = new MockTransport(() => ok({}));
        await assert.rejects(
            () => provider(transport).fetchBlob("unknown-oid"),
            /no recorded location/,
        );
    });
});

// ---------------------------------------------------------------------------
// Writes — documented capability boundary, not a stub
// ---------------------------------------------------------------------------

describe("RadicleProvider writes reject with the documented boundary error", () => {
    const p = provider(new MockTransport(() => ok({})));

    it("createBlob rejects", async () => {
        await assert.rejects(() => p.createBlob("x"), new RegExp(RADICLE_PUSH_UNSUPPORTED));
    });
    it("createTree rejects", async () => {
        await assert.rejects(() => p.createTree([]), new RegExp(RADICLE_PUSH_UNSUPPORTED));
    });
    it("createCommit rejects", async () => {
        await assert.rejects(
            () =>
                p.createCommit({
                    tree: "t",
                    parents: [],
                    message: "m",
                    author: { name: "n", email: "e", date: "2026-01-01T00:00:00Z" },
                }),
            new RegExp(RADICLE_PUSH_UNSUPPORTED),
        );
    });
    it("updateRef rejects", async () => {
        await assert.rejects(
            () => p.updateRef("main", "sha"),
            new RegExp(RADICLE_PUSH_UNSUPPORTED),
        );
    });
});
