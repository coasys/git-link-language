/**
 * Tests for the git operations module — exercises isomorphic-git
 * through the KV-backed fs-adapter.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as git from "isomorphic-git";

import type { StorageAdapter } from "../src/adapters.js";
import { createFsAdapter, type GitFs } from "../src/fs-adapter.js";
import {
    REPO_DIR,
    authorFromDid,
    commit as gitCommit,
    currentHead,
    decorateCommit,
    deleteLinkFile,
    diffLinks,
    ensureRepoInit,
    listLinkHashesAt,
    rawLog,
    readLinkAt,
    readLinkFile,
    writeLinkFile,
} from "../src/git.js";

class MockStorage implements StorageAdapter {
    private data = new Map<string, string>();
    get(key: string): string | null { return this.data.get(key) ?? null; }
    put(key: string, value: string): void { this.data.set(key, value); }
    delete(key: string): void { this.data.delete(key); }
    listKeys(prefix?: string): string[] {
        return [...this.data.keys()].filter(k => !prefix || k.startsWith(prefix));
    }
}

let fs: GitFs;

function setup(): void {
    const mock = new MockStorage();
    fs = createFsAdapter(mock);
}

const TEST_DID = "did:key:zTestAgent";

// ---------------------------------------------------------------------------
// ensureRepoInit
// ---------------------------------------------------------------------------

describe("git-ops: ensureRepoInit", () => {
    beforeEach(setup);

    it("initialises a new repo", async () => {
        const ran = await ensureRepoInit(fs, "main");
        assert.equal(ran, true);
        // HEAD should now exist
        const head = await fs.readFile(`${REPO_DIR}/.git/HEAD`, { encoding: "utf8" });
        assert.ok(typeof head === "string" && head.includes("ref: refs/heads/main"));
    });

    it("is idempotent — second call is a no-op", async () => {
        await ensureRepoInit(fs, "main");
        const ran = await ensureRepoInit(fs, "main");
        assert.equal(ran, false);
    });

    it("currentHead returns null before any commit", async () => {
        await ensureRepoInit(fs, "main");
        const head = await currentHead(fs);
        assert.equal(head, null);
    });
});

// ---------------------------------------------------------------------------
// writeLinkFile / readLinkFile
// ---------------------------------------------------------------------------

describe("git-ops: writeLinkFile / readLinkFile / deleteLinkFile", () => {
    beforeEach(setup);

    it("round-trips a link file in the working tree", async () => {
        await ensureRepoInit(fs, "main");
        const payload = JSON.stringify({ hello: "world" });
        await writeLinkFile(fs, "abc123", payload);
        const back = await readLinkFile(fs, "abc123");
        assert.equal(back, payload);
    });

    it("readLinkFile returns null for missing file", async () => {
        await ensureRepoInit(fs, "main");
        const back = await readLinkFile(fs, "missing");
        assert.equal(back, null);
    });

    it("deleteLinkFile removes the file", async () => {
        await ensureRepoInit(fs, "main");
        await writeLinkFile(fs, "abc", '{"x":1}');
        await deleteLinkFile(fs, "abc");
        assert.equal(await readLinkFile(fs, "abc"), null);
    });

    it("deleteLinkFile on missing file is benign", async () => {
        await ensureRepoInit(fs, "main");
        await deleteLinkFile(fs, "never-existed");
    });
});

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

describe("git-ops: commit", () => {
    beforeEach(setup);

    it("commits a single addition and produces a valid SHA", async () => {
        await ensureRepoInit(fs, "main");
        await writeLinkFile(fs, "h1", '{"link":1}');
        const sha = await gitCommit(fs, {
            additions: ["h1"],
            removals: [],
            author: authorFromDid(TEST_DID),
        });
        assert.match(sha, /^[a-f0-9]{40}$/);
        const head = await currentHead(fs);
        assert.equal(head, sha);
    });

    it("commits across multiple operations and links commits", async () => {
        await ensureRepoInit(fs, "main");

        await writeLinkFile(fs, "h1", '{"link":1}');
        const sha1 = await gitCommit(fs, {
            additions: ["h1"],
            removals: [],
            author: authorFromDid(TEST_DID),
        });

        await writeLinkFile(fs, "h2", '{"link":2}');
        const sha2 = await gitCommit(fs, {
            additions: ["h2"],
            removals: [],
            author: authorFromDid(TEST_DID),
        });

        assert.notEqual(sha1, sha2);

        const entries = await rawLog(fs, "HEAD");
        assert.equal(entries.length, 2);
        assert.equal(entries[0].oid, sha2);
        assert.equal(entries[1].oid, sha1);
        assert.equal(entries[0].commit.parent[0], sha1);
    });

    it("commits a removal", async () => {
        await ensureRepoInit(fs, "main");

        await writeLinkFile(fs, "h1", '{"link":1}');
        await gitCommit(fs, {
            additions: ["h1"],
            removals: [],
            author: authorFromDid(TEST_DID),
        });

        await deleteLinkFile(fs, "h1");
        await gitCommit(fs, {
            additions: [],
            removals: ["h1"],
            author: authorFromDid(TEST_DID),
        });

        const head = await currentHead(fs);
        assert.ok(head);
        const hashes = await listLinkHashesAt(fs, head!);
        assert.equal(hashes.size, 0);
    });
});

// ---------------------------------------------------------------------------
// listLinkHashesAt
// ---------------------------------------------------------------------------

describe("git-ops: listLinkHashesAt", () => {
    beforeEach(setup);

    it("returns empty set for a commit with no links", async () => {
        await ensureRepoInit(fs, "main");
        await writeLinkFile(fs, "init", "{}");
        // Commit but then remove
        await gitCommit(fs, {
            additions: ["init"],
            removals: [],
            author: authorFromDid(TEST_DID),
        });
        await deleteLinkFile(fs, "init");
        const sha = await gitCommit(fs, {
            additions: [],
            removals: ["init"],
            author: authorFromDid(TEST_DID),
        });
        const hashes = await listLinkHashesAt(fs, sha);
        assert.equal(hashes.size, 0);
    });

    it("lists every link present in the commit", async () => {
        await ensureRepoInit(fs, "main");
        for (const h of ["a", "b", "c"]) {
            await writeLinkFile(fs, h, `{"h":"${h}"}`);
        }
        const sha = await gitCommit(fs, {
            additions: ["a", "b", "c"],
            removals: [],
            author: authorFromDid(TEST_DID),
        });
        const hashes = await listLinkHashesAt(fs, sha);
        assert.equal(hashes.size, 3);
        assert.ok(hashes.has("a"));
        assert.ok(hashes.has("b"));
        assert.ok(hashes.has("c"));
    });
});

// ---------------------------------------------------------------------------
// diffLinks
// ---------------------------------------------------------------------------

describe("git-ops: diffLinks", () => {
    beforeEach(setup);

    it("treats every link as added when fromSha is null", async () => {
        await ensureRepoInit(fs, "main");
        for (const h of ["a", "b"]) {
            await writeLinkFile(fs, h, `{"h":"${h}"}`);
        }
        const sha = await gitCommit(fs, {
            additions: ["a", "b"],
            removals: [],
            author: authorFromDid(TEST_DID),
        });
        const diff = await diffLinks(fs, null, sha);
        assert.equal(diff.additions.length, 2);
        assert.equal(diff.removals.length, 0);
    });

    it("computes additions and removals between commits", async () => {
        await ensureRepoInit(fs, "main");

        await writeLinkFile(fs, "keep", "1");
        await writeLinkFile(fs, "drop", "2");
        const sha1 = await gitCommit(fs, {
            additions: ["keep", "drop"],
            removals: [],
            author: authorFromDid(TEST_DID),
        });

        await deleteLinkFile(fs, "drop");
        await writeLinkFile(fs, "add", "3");
        const sha2 = await gitCommit(fs, {
            additions: ["add"],
            removals: ["drop"],
            author: authorFromDid(TEST_DID),
        });

        const diff = await diffLinks(fs, sha1, sha2);
        assert.deepEqual([...diff.additions].sort(), ["add"]);
        assert.deepEqual([...diff.removals].sort(), ["drop"]);
    });
});

// ---------------------------------------------------------------------------
// decorateCommit
// ---------------------------------------------------------------------------

describe("git-ops: decorateCommit", () => {
    beforeEach(setup);

    it("attaches additions/removals to a CommitRecord", async () => {
        await ensureRepoInit(fs, "main");

        await writeLinkFile(fs, "h1", "1");
        const sha1 = await gitCommit(fs, {
            additions: ["h1"],
            removals: [],
            author: authorFromDid(TEST_DID),
        });

        await writeLinkFile(fs, "h2", "2");
        const sha2 = await gitCommit(fs, {
            additions: ["h2"],
            removals: [],
            author: authorFromDid(TEST_DID),
        });

        const entries = await rawLog(fs, "HEAD");
        const decorated = await decorateCommit(fs, entries[0]);
        assert.equal(decorated.sha, sha2);
        assert.equal(decorated.author, TEST_DID);
        assert.deepEqual(decorated.additions, ["h2"]);
        assert.deepEqual(decorated.removals, []);
        assert.deepEqual(decorated.parents, [sha1]);
    });
});

// ---------------------------------------------------------------------------
// readLinkAt
// ---------------------------------------------------------------------------

describe("git-ops: readLinkAt", () => {
    beforeEach(setup);

    it("returns link content at a historical commit", async () => {
        await ensureRepoInit(fs, "main");

        await writeLinkFile(fs, "h", '{"v":1}');
        const sha1 = await gitCommit(fs, {
            additions: ["h"],
            removals: [],
            author: authorFromDid(TEST_DID),
        });

        // Replace content in working tree, commit again
        await writeLinkFile(fs, "h", '{"v":2}');
        // Stage the change manually so the commit picks it up
        await git.add({ fs, dir: REPO_DIR, filepath: "links/h.json" });
        const sha2 = await gitCommit(fs, {
            additions: [],
            removals: [],
            author: authorFromDid(TEST_DID),
            message: "update h",
        });
        assert.notEqual(sha1, sha2);

        const v1 = await readLinkAt(fs, sha1, "h");
        const v2 = await readLinkAt(fs, sha2, "h");
        assert.equal(v1, '{"v":1}');
        assert.equal(v2, '{"v":2}');
    });

    it("returns null when the link is absent at that commit", async () => {
        await ensureRepoInit(fs, "main");
        await writeLinkFile(fs, "h", "x");
        const sha = await gitCommit(fs, {
            additions: ["h"],
            removals: [],
            author: authorFromDid(TEST_DID),
        });
        const got = await readLinkAt(fs, sha, "nonexistent");
        assert.equal(got, null);
    });
});
