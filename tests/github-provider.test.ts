/**
 * Tests for the GitHub REST API client. URL parsing is exercised
 * directly; HTTP calls go through a mock Transport so the suite has
 * no network dependency.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Transport, TransportResponse } from "../src/adapters.js";
import { GitHubProvider, parseGitHubUrl } from "../src/providers/github.js";

// ---------------------------------------------------------------------------
// parseGitHubUrl
// ---------------------------------------------------------------------------

describe("parseGitHubUrl", () => {
    it("accepts plain https URL", () => {
        const ref = parseGitHubUrl("https://github.com/coasys/git-link-language");
        assert.deepEqual(ref, { owner: "coasys", repo: "git-link-language" });
    });

    it("accepts URL with .git suffix", () => {
        const ref = parseGitHubUrl("https://github.com/o/r.git");
        assert.deepEqual(ref, { owner: "o", repo: "r" });
    });

    it("accepts URL with trailing slash", () => {
        const ref = parseGitHubUrl("https://github.com/o/r/");
        assert.deepEqual(ref, { owner: "o", repo: "r" });
    });

    it("rejects non-GitHub URLs", () => {
        assert.equal(parseGitHubUrl("https://gitlab.com/o/r"), null);
        assert.equal(parseGitHubUrl("https://example.com/o/r"), null);
        assert.equal(parseGitHubUrl(""), null);
    });

    it("rejects malformed paths", () => {
        assert.equal(parseGitHubUrl("https://github.com/only-one-segment"), null);
        assert.equal(parseGitHubUrl("https://github.com/"), null);
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
        public handler: (call: MockCall) => TransportResponse | Promise<TransportResponse>,
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

function ok(body: object, etag?: string): TransportResponse {
    return {
        status: 200,
        headers: etag ? { etag } : {},
        body: JSON.stringify(body),
    };
}

function notModified(): TransportResponse {
    return { status: 304, headers: {}, body: "" };
}

// ---------------------------------------------------------------------------
// GitHubProvider — fetchRef
// ---------------------------------------------------------------------------

describe("GitHubProvider.fetchRef", () => {
    it("returns the sha and etag on 200", async () => {
        const transport = new MockTransport(() =>
            ok({ object: { sha: "abc123" } }, "W/\"etag-1\""),
        );
        const provider = new GitHubProvider(transport, { owner: "o", repo: "r" }, "");
        const result = await provider.fetchRef("main");
        assert.equal(result.notModified, false);
        assert.equal(result.sha, "abc123");
        assert.equal(result.etag, "W/\"etag-1\"");
    });

    it("returns notModified on 304", async () => {
        const transport = new MockTransport(() => notModified());
        const provider = new GitHubProvider(transport, { owner: "o", repo: "r" }, "");
        const result = await provider.fetchRef("main", "W/\"etag-1\"");
        assert.equal(result.notModified, true);
        assert.equal(result.sha, undefined);
    });

    it("forwards the If-None-Match header when an ETag is supplied", async () => {
        const transport = new MockTransport(() => notModified());
        const provider = new GitHubProvider(transport, { owner: "o", repo: "r" }, "");
        await provider.fetchRef("main", "W/\"etag-1\"");
        assert.equal(transport.calls.length, 1);
        assert.equal(
            transport.calls[0].headers["If-None-Match"],
            "W/\"etag-1\"",
        );
    });

    it("sends Authorization header when a token is provided", async () => {
        const transport = new MockTransport(() =>
            ok({ object: { sha: "abc" } }),
        );
        const provider = new GitHubProvider(
            transport,
            { owner: "o", repo: "r" },
            "ghp_TESTTOKEN",
        );
        await provider.fetchRef("main");
        assert.equal(
            transport.calls[0].headers["Authorization"],
            "token ghp_TESTTOKEN",
        );
    });

    it("omits Authorization when no token is provided", async () => {
        const transport = new MockTransport(() =>
            ok({ object: { sha: "abc" } }),
        );
        const provider = new GitHubProvider(transport, { owner: "o", repo: "r" }, "");
        await provider.fetchRef("main");
        assert.equal(transport.calls[0].headers["Authorization"], undefined);
    });

    it("targets the canonical refs/heads endpoint", async () => {
        const transport = new MockTransport(() =>
            ok({ object: { sha: "abc" } }),
        );
        const provider = new GitHubProvider(transport, { owner: "o", repo: "r" }, "");
        await provider.fetchRef("dev");
        assert.equal(
            transport.calls[0].url,
            "https://api.github.com/repos/o/r/git/refs/heads/dev",
        );
    });
});

// ---------------------------------------------------------------------------
// GitHubProvider — fetchCommit
// ---------------------------------------------------------------------------

describe("GitHubProvider.fetchCommit", () => {
    it("extracts parents and tree", async () => {
        const transport = new MockTransport(() =>
            ok({
                sha: "c1",
                tree: { sha: "t1" },
                parents: [{ sha: "p1" }, { sha: "p2" }],
                message: "msg",
                author: {
                    name: "did:key:zABC",
                    email: "did@ad4m",
                    date: "2026-06-12T12:00:00Z",
                },
            }),
        );
        const provider = new GitHubProvider(transport, { owner: "o", repo: "r" }, "");
        const commit = await provider.fetchCommit("c1");
        assert.equal(commit.sha, "c1");
        assert.equal(commit.treeSha, "t1");
        assert.deepEqual(commit.parents, ["p1", "p2"]);
        assert.equal(commit.message, "msg");
        assert.equal(commit.author.name, "did:key:zABC");
        assert.equal(
            commit.author.timestamp,
            Math.floor(new Date("2026-06-12T12:00:00Z").getTime() / 1000),
        );
    });
});

// ---------------------------------------------------------------------------
// GitHubProvider — fetchTreeRecursive
// ---------------------------------------------------------------------------

describe("GitHubProvider.fetchTreeRecursive", () => {
    it("returns only blob/tree entries with the expected fields", async () => {
        const transport = new MockTransport(() =>
            ok({
                sha: "t1",
                tree: [
                    { path: "links/Qmaaa.json", type: "blob", mode: "100644", sha: "b1", size: 100 },
                    { path: "links/Qmbbb.json", type: "blob", mode: "100644", sha: "b2" },
                    { path: ".ad4m", type: "tree", mode: "040000", sha: "tdir" },
                    { /* missing path */ type: "blob", sha: "skip" },
                ],
            }),
        );
        const provider = new GitHubProvider(transport, { owner: "o", repo: "r" }, "");
        const tree = await provider.fetchTreeRecursive("t1");
        assert.equal(tree.entries.length, 3);
        assert.equal(tree.entries[0].path, "links/Qmaaa.json");
        assert.equal(tree.entries[0].sha, "b1");
        assert.equal(tree.entries[0].type, "blob");
    });

    it("requests recursive=1", async () => {
        const transport = new MockTransport(() =>
            ok({ sha: "t1", tree: [] }),
        );
        const provider = new GitHubProvider(transport, { owner: "o", repo: "r" }, "");
        await provider.fetchTreeRecursive("t1");
        assert.equal(
            transport.calls[0].url,
            "https://api.github.com/repos/o/r/git/trees/t1?recursive=1",
        );
    });
});

// ---------------------------------------------------------------------------
// GitHubProvider — fetchBlob
// ---------------------------------------------------------------------------

describe("GitHubProvider.fetchBlob", () => {
    it("base64-decodes the content field into UTF-8", async () => {
        const payload = JSON.stringify({ hello: "world" });
        const b64 = btoa(payload);
        const transport = new MockTransport(() =>
            ok({ sha: "b1", content: b64, encoding: "base64" }),
        );
        const provider = new GitHubProvider(transport, { owner: "o", repo: "r" }, "");
        const blob = await provider.fetchBlob("b1");
        assert.equal(blob.sha, "b1");
        assert.equal(blob.content, payload);
    });

    it("tolerates the chunked base64 GitHub returns (newlines every 60 chars)", async () => {
        const payload = JSON.stringify({ data: "x".repeat(200) });
        const b64Plain = btoa(payload);
        // Insert newlines every 60 chars, the way GitHub serialises it
        const b64Chunked = b64Plain.replace(/(.{60})/g, "$1\n");
        const transport = new MockTransport(() =>
            ok({ sha: "b1", content: b64Chunked, encoding: "base64" }),
        );
        const provider = new GitHubProvider(transport, { owner: "o", repo: "r" }, "");
        const blob = await provider.fetchBlob("b1");
        assert.equal(blob.content, payload);
    });
});
