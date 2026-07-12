/**
 * Integration tests for the diff-DAG convergence contract, driven through
 * the real remote-sync + git plumbing against an in-memory {@link
 * FakeRemote} (see tests/fake-remote.ts). These exercise the four spec
 * acceptance criteria end-to-end:
 *
 *   1. Remote sync walks ancestry — a multi-commit remote advance applies
 *      each intermediate diff, not just a snapshot of the head tree.
 *   2. Removal convergence — an observed removal tombstones the link on
 *      both replicas; a concurrent add-vs-remove of the same hash resolves
 *      per MERGE_POLICY deterministically.
 *   3. Merge order-independence — applying two diffs in either order yields
 *      the same materialised link-set and revision.
 *   4. DAG is authoritative — folding the commit history from genesis
 *      reproduces the materialised link-set.
 *
 * These paths cannot be exercised against a single-snapshot mock, which is
 * why the fake models a real multi-commit content-addressed remote.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { RuntimeAdapter, StorageAdapter } from "../src/adapters.js";
import { initRuntime, initStorage, getStorage } from "../src/adapters.js";
import { createFsAdapter, type GitFs } from "../src/fs-adapter.js";
import * as ops from "../src/operations.js";
import * as store from "../src/store.js";
import * as gitops from "../src/git.js";
import { pullOnce } from "../src/remote-sync.js";
import type { LinkExpression, PerspectiveDiff } from "../src/types.js";
import { FakeRemote } from "./fake-remote.js";
import type { MergePolicy } from "../src/merge.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

class MockStorage implements StorageAdapter {
    public data = new Map<string, string>();
    get(key: string): string | null { return this.data.get(key) ?? null; }
    put(key: string, value: string): void { this.data.set(key, value); }
    delete(key: string): void { this.data.delete(key); }
    listKeys(prefix?: string): string[] {
        return [...this.data.keys()].filter((k) => !prefix || k.startsWith(prefix));
    }
}

class MockRuntime implements RuntimeAdapter {
    public emittedDiffs: PerspectiveDiff[] = [];
    hash(data: string): string {
        // FNV-1a — deterministic, collision-resistant enough for tests.
        let h = 0x811c9dc5;
        for (let i = 0; i < data.length; i++) {
            h ^= data.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return `Qm${(h >>> 0).toString(16)}`;
    }
    emitSignal(_data: string): void {}
    emitPerspectiveDiff(diff: unknown): void {
        this.emittedDiffs.push(diff as PerspectiveDiff);
    }
}

const TEST_DID = "did:key:zLocalAgent";

interface Ctx {
    fs: GitFs;
    runtime: MockRuntime;
}

async function freshCtx(): Promise<Ctx> {
    initStorage(new MockStorage());
    const runtime = new MockRuntime();
    initRuntime(runtime);
    store.initStore(runtime.hash.bind(runtime));
    const fs = createFsAdapter(getStorage());
    await ops.boot({ fs, defaultBranch: "main" });
    return { fs, runtime };
}

let ctx: Ctx;
beforeEach(async () => {
    ctx = await freshCtx();
});

function makeLink(source: string, opts?: { author?: string; timestamp?: string }): LinkExpression {
    return {
        author: opts?.author ?? TEST_DID,
        timestamp: opts?.timestamp ?? "2026-06-12T00:00:00.000Z",
        data: { source, target: `tgt://${source}`, predicate: "pred://P" },
        proof: { signature: "sig", key: "key" },
    };
}

/** Hash a link the same way the store does, so remote trees agree. */
function h(link: LinkExpression): string {
    return store.hashLink(link);
}

/** The materialised link-set at HEAD, as a sorted array of `source`s. */
async function headSources(fs: GitFs): Promise<string[]> {
    const head = await gitops.currentHead(fs);
    if (!head) return [];
    const hashes = await gitops.listLinkHashesAt(fs, head);
    const sources: string[] = [];
    for (const hash of hashes) {
        const raw = await gitops.readLinkAt(fs, head, hash);
        if (raw) sources.push(JSON.parse(raw).data.source);
    }
    return sources.sort();
}

async function pull(fs: GitFs, remote: FakeRemote, policy?: MergePolicy): Promise<PerspectiveDiff> {
    return await pullOnce({
        provider: remote.asProvider(),
        branch: "main",
        intervalMs: 0,
        fs,
        agentDid: TEST_DID,
        mergePolicy: policy,
    });
}

// ---------------------------------------------------------------------------
// 1. Ancestry walk — multi-commit remote advance applies each diff
// ---------------------------------------------------------------------------

describe("ancestry walk", () => {
    it("applies every intermediate commit's diff, not just the head snapshot", async () => {
        const { fs } = ctx;
        const remote = new FakeRemote("main");

        const l1 = makeLink("A1");
        const l2 = makeLink("A2");
        const l3 = makeLink("A3");

        // Three separate remote commits: +A1, then +A2, then (-A1, +A3).
        // A snapshot of only the head tree would show {A2, A3} and never
        // reveal that A1 ever existed; the ancestry walk must traverse the
        // chain. We verify the walk by asserting that the final HEAD is a
        // fast-forward whose git history contains all three commits.
        remote.commit(new Map([[h(l1), l1]]));
        remote.commit(new Map([[h(l1), l1], [h(l2), l2]]));
        remote.commit(new Map([[h(l2), l2], [h(l3), l3]])); // dropped A1, added A3

        const diff = await pull(fs, remote);

        // Net effect at first contact is a union of the surviving links.
        assert.deepEqual((await headSources(fs)).sort(), ["A2", "A3"]);
        assert.deepEqual(diff.additions.map((l) => l.data.source).sort(), ["A2", "A3"]);

        // The ancestry walk mirrored all THREE remote commits locally (not a
        // single squashed snapshot): the local history depth from HEAD is 3.
        const head = await gitops.currentHead(fs);
        assert.ok(head);
        const log = await gitops.rawLog(fs, head as string, 100);
        assert.equal(log.length, 3, "expected all three remote commits mirrored");

        // And the OLDEST mirrored commit carried only A1 — proving the
        // intermediate state was reconstructed, not collapsed.
        const oldest = log[log.length - 1];
        const oldestHashes = await gitops.listLinkHashesAt(fs, oldest.oid);
        assert.deepEqual([...oldestHashes], [h(l1)]);
    });

    it("resumes the walk on a second pull without re-mirroring", async () => {
        const { fs } = ctx;
        const remote = new FakeRemote("main");
        const l1 = makeLink("B1");
        remote.commit(new Map([[h(l1), l1]]));
        await pull(fs, remote);
        const afterFirst = await gitops.currentHead(fs);

        // Remote advances by one commit; second pull should mirror only it.
        const l2 = makeLink("B2");
        remote.commit(new Map([[h(l1), l1], [h(l2), l2]]));
        const diff = await pull(fs, remote);

        assert.deepEqual(diff.additions.map((l) => l.data.source), ["B2"]);
        assert.deepEqual(await headSources(fs), ["B1", "B2"]);

        // History grew by exactly one commit (no re-mirror of B1's commit).
        const head = await gitops.currentHead(fs);
        const log = await gitops.rawLog(fs, head as string, 100);
        assert.equal(log.length, 2);
        assert.notEqual(head, afterFirst);
    });
});

// ---------------------------------------------------------------------------
// 2. Removal convergence + concurrent add-vs-remove per policy
// ---------------------------------------------------------------------------

describe("removal convergence", () => {
    it("an observed removal in the remote chain tombstones the link locally", async () => {
        const { fs } = ctx;
        const remote = new FakeRemote("main");
        const l = makeLink("gone");

        // First contact: remote has the link, local adopts it.
        remote.commit(new Map([[h(l), l]]));
        await pull(fs, remote);
        assert.deepEqual(await headSources(fs), ["gone"]);

        // Remote removes it in a follow-up commit → local fast-forwards and
        // the net diff is a removal.
        remote.commit(new Map());
        const diff = await pull(fs, remote);
        assert.deepEqual(diff.removals.map((l) => l.data.source), ["gone"]);
        assert.deepEqual(await headSources(fs), []);
    });

    // A genuine concurrent add-vs-remove of the SAME hash requires each side
    // to have an *observed operation* on h(s) since the shared base. Both
    // replicas observe S at genesis. Local removes S (one observed op:
    // remove h(s)). Remote, on its own fork, removes S and then re-adds the
    // identical S — its op-log since genesis therefore contains an ADD of
    // h(s) (the re-add's parent tree lacks S, so it registers as an add-op).
    // Now local.removes ∩ remote.adds = {h(s)} — the conflict MERGE_POLICY
    // exists to resolve. (Merely re-committing S unchanged would be a no-op
    // add against the genesis tree and would NOT surface a conflict; the
    // tombstone would simply win. This models a real remove/re-add churn.)
    async function setupConflict(fs: GitFs, remote: FakeRemote): Promise<LinkExpression> {
        const s = makeLink("S");
        // Shared genesis observed by both replicas.
        remote.commit(new Map([[h(s), s]]));
        await pull(fs, remote);
        assert.deepEqual(await headSources(fs), ["S"]);

        // LOCAL branch: observed removal of S.
        await ops.commit({ fs, diff: { additions: [], removals: [s] }, authorDid: TEST_DID });
        assert.deepEqual(await headSources(fs), []);

        // REMOTE branch (forks from genesis): remove S, then re-add S. Two
        // commits, both parented off genesis's descendant chain on the remote
        // side, so the remote op-log carries an observed ADD of h(s).
        const genesis = remote.head as string;
        const removed = remote.commit(new Map(), { parents: [genesis], message: "remote drop S" });
        remote.commit(new Map([[h(s), s]]), { parents: [removed], message: "remote re-add S" });
        return s;
    }

    it("concurrent add-vs-remove of the same link: add-wins keeps it", async () => {
        const { fs } = ctx;
        const remote = new FakeRemote("main");
        await setupConflict(fs, remote);

        const diff = await pull(fs, remote, "add-wins");

        // add-wins → S present after the merge on this replica.
        assert.deepEqual(await headSources(fs), ["S"]);
        assert.deepEqual(diff.additions.map((l) => l.data.source), ["S"]);

        // A genuine two-parent merge commit was written.
        const head = await gitops.currentHead(fs);
        const commit = await gitops.readCommitObject(fs, head as string);
        assert.equal(commit?.parent.length, 2, "expected a two-parent merge commit");
    });

    it("concurrent add-vs-remove of the same link: remove-wins drops it", async () => {
        const { fs } = ctx;
        const remote = new FakeRemote("main");
        await setupConflict(fs, remote);

        await pull(fs, remote, "remove-wins");

        // remove-wins → the observed tombstone prevails; S is absent.
        assert.deepEqual(await headSources(fs), []);

        const head = await gitops.currentHead(fs);
        const commit = await gitops.readCommitObject(fs, head as string);
        assert.equal(commit?.parent.length, 2);
    });

    it("policy default is add-wins when unspecified", async () => {
        const { fs } = ctx;
        const remote = new FakeRemote("main");
        await setupConflict(fs, remote);
        await pull(fs, remote); // no policy passed → default add-wins
        assert.deepEqual(await headSources(fs), ["S"]);
    });
});

// ---------------------------------------------------------------------------
// 3. Merge order-independence
// ---------------------------------------------------------------------------

describe("merge order-independence", () => {
    // Build the SAME divergent scenario two ways: once merging remote into a
    // local that added X, once with the roles of the two independent adds
    // swapped. The materialised link-set must be identical.
    async function convergedSet(localSource: string, remoteSource: string): Promise<string[]> {
        const ctxN = await freshCtx();
        const fs = ctxN.fs;
        const remote = new FakeRemote("main");

        // Shared genesis with a base link.
        const base = makeLink("BASE");
        remote.commit(new Map([[h(base), base]]));
        await pull(fs, remote);

        // Local adds its link on top of genesis.
        const localLink = makeLink(localSource);
        await ops.commit({ fs, diff: { additions: [localLink], removals: [] }, authorDid: TEST_DID });

        // Remote adds its link, forking from genesis → divergence.
        const remoteLink = makeLink(remoteSource);
        remote.commit(new Map([[h(base), base], [h(remoteLink), remoteLink]]));

        await pull(fs, remote);
        return await headSources(fs);
    }

    it("yields the same link-set regardless of which side is 'local'", async () => {
        const a = await convergedSet("X", "Y");
        const b = await convergedSet("Y", "X");
        assert.deepEqual(a, b);
        assert.deepEqual(a, ["BASE", "X", "Y"]);
    });
});

// ---------------------------------------------------------------------------
// 4. DAG is authoritative — folding from genesis reproduces the link-set
// ---------------------------------------------------------------------------

describe("DAG-authoritative fold", () => {
    it("folding the commit history from genesis reproduces the materialised set", async () => {
        const { fs } = ctx;
        const remote = new FakeRemote("main");

        // A non-trivial multi-commit remote history with an add and a drop.
        const p = makeLink("P");
        const q = makeLink("Q");
        const r = makeLink("R");
        remote.commit(new Map([[h(p), p]]));
        remote.commit(new Map([[h(p), p], [h(q), q]]));
        remote.commit(new Map([[h(q), q], [h(r), r]])); // dropped P
        await pull(fs, remote);

        // Independent fold: walk the local commit DAG from HEAD back to the
        // root, replaying each commit's add/remove ops (oldest → newest), and
        // confirm it reproduces exactly what listLinkHashesAt(HEAD) reports.
        const head = await gitops.currentHead(fs);
        assert.ok(head);
        const materialised = await gitops.listLinkHashesAt(fs, head as string);

        const folded = await gitops.branchOpsSince(fs, null, head as string);
        // With base=null the fold replays the entire history; the surviving
        // adds are exactly the materialised set, and nothing lingers in
        // removes that is also present.
        const survivors = new Set([...folded.adds].filter((x) => !folded.removes.has(x)));

        assert.deepEqual([...survivors].sort(), [...materialised].sort());
        // Sanity: the materialised set is {Q, R} (P was dropped).
        assert.deepEqual(
            (await headSources(fs)),
            ["Q", "R"],
        );
    });

    it("currentRevision is the HEAD commit SHA (a content hash), stable across a no-op sync", async () => {
        const { fs } = ctx;
        const remote = new FakeRemote("main");
        const l = makeLink("rev");
        remote.commit(new Map([[h(l), l]]));
        await pull(fs, remote);

        const rev1 = await ops.currentRevision(fs);
        const head = await gitops.currentHead(fs);
        assert.equal(rev1, head);
        assert.match(rev1, /^[0-9a-f]{40}$/, "revision is a git SHA-1 content hash");

        // A second pull with no remote movement leaves the revision unchanged.
        const diff = await pull(fs, remote);
        assert.deepEqual(diff, { additions: [], removals: [] });
        assert.equal(await ops.currentRevision(fs), rev1);
    });
});
