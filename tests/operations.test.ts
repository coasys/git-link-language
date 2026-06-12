/**
 * Integration tests for the language operations: commit, render,
 * sync, and the revert-to interaction.
 *
 * Mocks the host-provided adapters (storage, runtime) and exercises
 * the full stack from PerspectiveDiff through the fs-adapter and
 * isomorphic-git.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as git from "isomorphic-git";

import type { StorageAdapter, RuntimeAdapter } from "../src/adapters.js";
import { initStorage, initRuntime, getStorage } from "../src/adapters.js";
import { createFsAdapter, type GitFs } from "../src/fs-adapter.js";
import * as ops from "../src/operations.js";
import * as store from "../src/store.js";
import * as queries from "../src/queries.js";
import { buildInteractions } from "../src/interactions.js";
import type { LinkExpression, PerspectiveDiff } from "../src/types.js";
import { REPO_DIR } from "../src/git.js";

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
        timestamp: overrides?.timestamp ?? "2026-01-01T00:00:00.000Z",
        data: {
            source: overrides?.source ?? "src://A",
            target: overrides?.target ?? "tgt://B",
            predicate: overrides?.predicate ?? "pred://P",
        },
        proof: { signature: "sig", key: "key" },
    };
}

// ---------------------------------------------------------------------------
// commit + render
// ---------------------------------------------------------------------------

describe("ops: commit + render", () => {
    beforeEach(setup);

    it("an empty diff is a no-op and returns empty SHA", async () => {
        const sha = await ops.commit({
            fs,
            diff: { additions: [], removals: [] },
            authorDid: TEST_DID,
        });
        assert.equal(sha, "");
        assert.equal(ops.render().links.length, 0);
    });

    it("commits a single addition and render reflects it", async () => {
        const link = makeLink();
        const sha = await ops.commit({
            fs,
            diff: { additions: [link], removals: [] },
            authorDid: TEST_DID,
        });
        assert.match(sha, /^[a-f0-9]{40}$/);
        const rendered = ops.render();
        assert.equal(rendered.links.length, 1);
        assert.equal(rendered.links[0].data.source, "src://A");
    });

    it("emits a PerspectiveDiff on commit", async () => {
        const link = makeLink();
        await ops.commit({
            fs,
            diff: { additions: [link], removals: [] },
            authorDid: TEST_DID,
        });
        assert.equal(runtime.emittedDiffs.length, 1);
        assert.equal(runtime.emittedDiffs[0].additions.length, 1);
    });

    it("batches an N-link diff into a single Git commit", async () => {
        const links = [
            makeLink({ source: "a", target: "1" }),
            makeLink({ source: "b", target: "2" }),
            makeLink({ source: "c", target: "3" }),
            makeLink({ source: "d", target: "4" }),
            makeLink({ source: "e", target: "5" }),
        ];
        const sha = await ops.commit({
            fs,
            diff: { additions: links, removals: [] },
            authorDid: TEST_DID,
        });
        assert.match(sha, /^[a-f0-9]{40}$/);

        // One commit, five link files
        const historyResult = await queries.runQuery(
            { kind: "git-history", payload: {} },
            fs,
        );
        const records = historyResult.payload as Array<{
            additions: string[];
            removals: string[];
        }>;
        assert.equal(records.length, 1, "expected exactly one commit for the batch");
        assert.equal(records[0].additions.length, 5);
        assert.equal(records[0].removals.length, 0);

        // All five links render
        assert.equal(ops.render().links.length, 5);

        // Exactly one PerspectiveDiff was emitted
        assert.equal(runtime.emittedDiffs.length, 1);
        assert.equal(runtime.emittedDiffs[0].additions.length, 5);
    });

    it("batches mixed additions + removals into a single commit", async () => {
        // Seed two links so we can remove them
        const seedA = makeLink({ source: "seed-a" });
        const seedB = makeLink({ source: "seed-b" });
        await ops.commit({
            fs,
            diff: { additions: [seedA, seedB], removals: [] },
            authorDid: TEST_DID,
        });

        // Now apply a mixed diff: drop seedA, add three new links
        const newOnes = [
            makeLink({ source: "new-1" }),
            makeLink({ source: "new-2" }),
            makeLink({ source: "new-3" }),
        ];
        runtime.emittedDiffs.length = 0;
        const sha = await ops.commit({
            fs,
            diff: { additions: newOnes, removals: [seedA] },
            authorDid: TEST_DID,
        });
        assert.match(sha, /^[a-f0-9]{40}$/);

        // The new commit shows +3 -1 in one record
        const historyResult = await queries.runQuery(
            { kind: "git-history", payload: { limit: 1 } },
            fs,
        );
        const records = historyResult.payload as Array<{
            additions: string[];
            removals: string[];
        }>;
        assert.equal(records.length, 1);
        assert.equal(records[0].additions.length, 3);
        assert.equal(records[0].removals.length, 1);

        // Final state: seedB + three new links = 4
        assert.equal(ops.render().links.length, 4);

        // One emission for the whole batch
        assert.equal(runtime.emittedDiffs.length, 1);
    });

    it("commits an addition and then a removal", async () => {
        const link = makeLink();
        await ops.commit({
            fs,
            diff: { additions: [link], removals: [] },
            authorDid: TEST_DID,
        });
        await ops.commit({
            fs,
            diff: { additions: [], removals: [link] },
            authorDid: TEST_DID,
        });
        assert.equal(ops.render().links.length, 0);
    });

    it("currentRevision tracks HEAD across commits", async () => {
        await ops.commit({
            fs,
            diff: { additions: [makeLink({ source: "a" })], removals: [] },
            authorDid: TEST_DID,
        });
        const rev1 = await ops.currentRevision(fs);
        await ops.commit({
            fs,
            diff: { additions: [makeLink({ source: "b" })], removals: [] },
            authorDid: TEST_DID,
        });
        const rev2 = await ops.currentRevision(fs);
        assert.notEqual(rev1, rev2);
    });
});

// ---------------------------------------------------------------------------
// sync — picks up externally-applied commits
// ---------------------------------------------------------------------------

describe("ops: sync", () => {
    beforeEach(setup);

    it("returns empty diff when HEAD has not moved", async () => {
        const link = makeLink();
        await ops.commit({
            fs,
            diff: { additions: [link], removals: [] },
            authorDid: TEST_DID,
        });
        const diff = await ops.sync({ fs });
        assert.equal(diff.additions.length, 0);
        assert.equal(diff.removals.length, 0);
    });

    it("detects HEAD movement applied via raw isomorphic-git", async () => {
        // Commit one link through our ops layer
        const linkA = makeLink({ source: "A" });
        await ops.commit({
            fs,
            diff: { additions: [linkA], removals: [] },
            authorDid: TEST_DID,
        });
        const initialRevision = store.getRevision();
        assert.ok(initialRevision);

        // Apply a commit externally — bypass our store update
        const linkB = makeLink({ source: "B" });
        const hashB = store.hashLink(linkB);
        await fs.writeFile(
            `${REPO_DIR}/links/${hashB}.json`,
            JSON.stringify(linkB),
        );
        await git.add({ fs, dir: REPO_DIR, filepath: `links/${hashB}.json` });
        const externalSha = await git.commit({
            fs,
            dir: REPO_DIR,
            author: { name: "external", email: "external@cli" },
            message: "external add B",
        });

        // sync() should now report the addition
        const diff = await ops.sync({ fs });
        assert.equal(diff.additions.length, 1);
        assert.equal(diff.additions[0].data.source, "B");
        assert.equal(diff.removals.length, 0);

        // Store revision should now reflect the external commit
        assert.equal(store.getRevision(), externalSha);

        // Render now includes both links
        assert.equal(ops.render().links.length, 2);
    });
});

// ---------------------------------------------------------------------------
// link-pattern query
// ---------------------------------------------------------------------------

describe("queries: link-pattern", () => {
    beforeEach(setup);

    it("filters by source", async () => {
        await ops.commit({
            fs,
            diff: {
                additions: [
                    makeLink({ source: "a", target: "1" }),
                    makeLink({ source: "a", target: "2" }),
                    makeLink({ source: "b", target: "3" }),
                ],
                removals: [],
            },
            authorDid: TEST_DID,
        });
        const result = await queries.runQuery(
            { kind: "link-pattern", payload: { source: "a" } },
            fs,
        );
        assert.equal(result.kind, "links");
        const links = result.payload as LinkExpression[];
        assert.equal(links.length, 2);
    });

    it("returns all links with empty payload", async () => {
        await ops.commit({
            fs,
            diff: {
                additions: [
                    makeLink({ source: "x" }),
                    makeLink({ source: "y" }),
                ],
                removals: [],
            },
            authorDid: TEST_DID,
        });
        const result = await queries.runQuery(
            { kind: "link-pattern", payload: {} },
            fs,
        );
        assert.equal((result.payload as LinkExpression[]).length, 2);
    });

    it("reports unsupported kinds as an error", async () => {
        const result = await queries.runQuery(
            { kind: "totally-unknown", payload: {} },
            fs,
        );
        assert.equal(result.kind, "error");
    });
});

// ---------------------------------------------------------------------------
// git-history query
// ---------------------------------------------------------------------------

describe("queries: git-history", () => {
    beforeEach(setup);

    it("returns commits in newest-first order with additions decorated", async () => {
        await ops.commit({
            fs,
            diff: { additions: [makeLink({ source: "a" })], removals: [] },
            authorDid: TEST_DID,
        });
        await ops.commit({
            fs,
            diff: { additions: [makeLink({ source: "b" })], removals: [] },
            authorDid: TEST_DID,
        });
        const result = await queries.runQuery(
            { kind: "git-history", payload: {} },
            fs,
        );
        assert.equal(result.kind, "history");
        const records = result.payload as Array<{
            additions: string[];
            removals: string[];
            sha: string;
        }>;
        assert.equal(records.length, 2);
        // Newest first: the 'b' commit should be entry 0
        assert.equal(records[0].additions.length, 1);
        assert.equal(records[1].additions.length, 1);
    });

    it("respects the limit", async () => {
        for (let i = 0; i < 5; i++) {
            await ops.commit({
                fs,
                diff: { additions: [makeLink({ source: `s${i}` })], removals: [] },
                authorDid: TEST_DID,
            });
        }
        const result = await queries.runQuery(
            { kind: "git-history", payload: { limit: 2 } },
            fs,
        );
        const records = result.payload as Array<unknown>;
        assert.equal(records.length, 2);
    });
});

// ---------------------------------------------------------------------------
// git-state-at query
// ---------------------------------------------------------------------------

describe("queries: git-state-at", () => {
    beforeEach(setup);

    it("returns the link set as it existed at a past SHA", async () => {
        const linkA = makeLink({ source: "A" });
        const linkB = makeLink({ source: "B" });

        const sha1 = await ops.commit({
            fs,
            diff: { additions: [linkA], removals: [] },
            authorDid: TEST_DID,
        });

        await ops.commit({
            fs,
            diff: { additions: [linkB], removals: [] },
            authorDid: TEST_DID,
        });

        const result = await queries.runQuery(
            { kind: "git-state-at", payload: { sha: sha1 } },
            fs,
        );
        assert.equal(result.kind, "perspective");
        const links = (result.payload as { links: LinkExpression[] }).links;
        assert.equal(links.length, 1);
        assert.equal(links[0].data.source, "A");
    });
});

// ---------------------------------------------------------------------------
// git-blame query
// ---------------------------------------------------------------------------

describe("queries: git-blame", () => {
    beforeEach(setup);

    it("returns the commit that introduced a link", async () => {
        const linkA = makeLink({ source: "A" });
        const linkB = makeLink({ source: "B" });

        const sha1 = await ops.commit({
            fs,
            diff: { additions: [linkA], removals: [] },
            authorDid: TEST_DID,
        });
        await ops.commit({
            fs,
            diff: { additions: [linkB], removals: [] },
            authorDid: TEST_DID,
        });

        const hashA = store.hashLink(linkA);
        const result = await queries.runQuery(
            { kind: "git-blame", payload: { linkHash: hashA } },
            fs,
        );
        assert.equal(result.kind, "blame");
        const blame = result.payload as { introducedBy: string; author: string };
        assert.equal(blame.introducedBy, sha1);
        assert.equal(blame.author, TEST_DID);
    });

    it("returns null for never-existed link", async () => {
        await ops.commit({
            fs,
            diff: { additions: [makeLink({ source: "x" })], removals: [] },
            authorDid: TEST_DID,
        });
        const result = await queries.runQuery(
            { kind: "git-blame", payload: { linkHash: "nonexistent" } },
            fs,
        );
        assert.equal(result.payload, null);
    });
});

// ---------------------------------------------------------------------------
// revert-to interaction
// ---------------------------------------------------------------------------

describe("interactions: revert-to", () => {
    beforeEach(setup);

    it("produces a forward commit that reverses the link state", async () => {
        const linkA = makeLink({ source: "A" });
        const linkB = makeLink({ source: "B" });

        // Commit A
        const sha1 = await ops.commit({
            fs,
            diff: { additions: [linkA], removals: [] },
            authorDid: TEST_DID,
        });
        // Commit B on top
        await ops.commit({
            fs,
            diff: { additions: [linkB], removals: [] },
            authorDid: TEST_DID,
        });
        // Sanity: two links present
        assert.equal(ops.render().links.length, 2);

        // Revert-to sha1
        const [, revertInteraction] = buildInteractions({ fs, agentDid: TEST_DID });
        assert.equal(revertInteraction.name, "revert-to");
        const result = await revertInteraction.execute({ sha: sha1 });
        assert.ok(result?.startsWith("revert-to: committed inverse"));

        // After revert, only linkA remains
        const links = ops.render().links;
        assert.equal(links.length, 1);
        assert.equal(links[0].data.source, "A");

        // History should now contain THREE commits (sha1 + sha2 + revert)
        const history = await queries.runQuery(
            { kind: "git-history", payload: {} },
            fs,
        );
        assert.equal((history.payload as Array<unknown>).length, 3);
    });

    it("reports nothing-to-do when target equals current", async () => {
        const sha = await ops.commit({
            fs,
            diff: { additions: [makeLink({ source: "x" })], removals: [] },
            authorDid: TEST_DID,
        });
        const [, revertInteraction] = buildInteractions({ fs, agentDid: TEST_DID });
        const result = await revertInteraction.execute({ sha });
        assert.ok(result?.includes("equals current HEAD"));
    });
});
