/**
 * Unit tests for the pure OR-Set merge (`src/merge.ts`).
 *
 * These tests pin the CRDT semantics at the algebraic level — no Git, no
 * IO. Because every input is a set, the merge must be commutative,
 * associative-friendly, and idempotent; the concurrent add-vs-remove
 * conflict must resolve deterministically per `MERGE_POLICY`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    deltaFromSets,
    orSetMerge,
    parseMergePolicy,
    type BranchDelta,
} from "../src/merge.js";

function set(...xs: string[]): Set<string> {
    return new Set(xs);
}

function sorted(s: Set<string>): string[] {
    return [...s].sort();
}

// ---------------------------------------------------------------------------
// parseMergePolicy
// ---------------------------------------------------------------------------

describe("parseMergePolicy", () => {
    it("defaults to add-wins for unknown / missing values", () => {
        assert.equal(parseMergePolicy(undefined), "add-wins");
        assert.equal(parseMergePolicy(null), "add-wins");
        assert.equal(parseMergePolicy(""), "add-wins");
        assert.equal(parseMergePolicy("nonsense"), "add-wins");
        assert.equal(parseMergePolicy("add-wins"), "add-wins");
    });

    it("recognises remove-wins explicitly", () => {
        assert.equal(parseMergePolicy("remove-wins"), "remove-wins");
    });
});

// ---------------------------------------------------------------------------
// deltaFromSets
// ---------------------------------------------------------------------------

describe("deltaFromSets", () => {
    it("classifies additions and removals relative to the base", () => {
        const base = set("a", "b", "c");
        const head = set("b", "c", "d"); // dropped a, added d
        const delta = deltaFromSets(base, head);
        assert.deepEqual(sorted(delta.adds), ["d"]);
        assert.deepEqual(sorted(delta.removes), ["a"]);
    });

    it("is empty when head equals base", () => {
        const base = set("x", "y");
        const delta = deltaFromSets(base, set("x", "y"));
        assert.equal(delta.adds.size, 0);
        assert.equal(delta.removes.size, 0);
    });
});

// ---------------------------------------------------------------------------
// orSetMerge — basic union / difference
// ---------------------------------------------------------------------------

describe("orSetMerge: concurrent additions", () => {
    it("unions independent adds from both branches", () => {
        const base = set("shared");
        const local: BranchDelta = { adds: set("local1"), removes: set() };
        const remote: BranchDelta = { adds: set("remote1"), removes: set() };
        const { merged, conflicts } = orSetMerge({ base, local, remote, policy: "add-wins" });
        assert.deepEqual(sorted(merged), ["local1", "remote1", "shared"]);
        assert.equal(conflicts.size, 0);
    });
});

// ---------------------------------------------------------------------------
// orSetMerge — removal convergence (the acceptance-criteria case)
// ---------------------------------------------------------------------------

describe("orSetMerge: removal convergence", () => {
    it("a remove on one branch tombstones a link that stays on the base", () => {
        // Base holds h. Local removes it; remote leaves it untouched.
        // The observed removal must win — h is absent from the merge.
        const base = set("h", "keep");
        const local: BranchDelta = { adds: set(), removes: set("h") };
        const remote: BranchDelta = { adds: set(), removes: set() };
        const { merged, conflicts } = orSetMerge({ base, local, remote, policy: "add-wins" });
        assert.deepEqual(sorted(merged), ["keep"]);
        // Not a conflict: remote never re-added h.
        assert.equal(conflicts.size, 0);
    });

    it("a remove converges even when both branches remove the same link", () => {
        const base = set("h");
        const local: BranchDelta = { adds: set(), removes: set("h") };
        const remote: BranchDelta = { adds: set(), removes: set("h") };
        const { merged } = orSetMerge({ base, local, remote, policy: "add-wins" });
        assert.equal(merged.size, 0);
    });
});

// ---------------------------------------------------------------------------
// orSetMerge — concurrent add-vs-remove resolved by policy
// ---------------------------------------------------------------------------

describe("orSetMerge: concurrent add-vs-remove", () => {
    // Construct a genuine concurrent conflict on hash h: it existed at the
    // base, local removed it, and remote (relative to the base) also has it
    // recorded as an add — i.e. the two sides disagree on h's membership.
    // deltaFromSets can't produce "add of a base member", so we build the
    // deltas directly to model the wire-level conflict the merge must handle.
    const base = set("h");
    const local: BranchDelta = { adds: set(), removes: set("h") };
    const remote: BranchDelta = { adds: set("h"), removes: set() };

    it("add-wins keeps the link and flags the conflict", () => {
        const { merged, conflicts } = orSetMerge({ base, local, remote, policy: "add-wins" });
        assert.deepEqual(sorted(merged), ["h"]);
        assert.deepEqual(sorted(conflicts), ["h"]);
    });

    it("remove-wins drops the link but still flags the conflict", () => {
        const { merged, conflicts } = orSetMerge({ base, local, remote, policy: "remove-wins" });
        assert.equal(merged.size, 0);
        assert.deepEqual(sorted(conflicts), ["h"]);
    });
});

// ---------------------------------------------------------------------------
// orSetMerge — order independence (commutativity)
// ---------------------------------------------------------------------------

describe("orSetMerge: order independence", () => {
    it("swapping local and remote yields the identical merged set", () => {
        const base = set("b1", "b2");
        const local: BranchDelta = { adds: set("la"), removes: set("b1") };
        const remote: BranchDelta = { adds: set("ra"), removes: set("b2") };

        const forward = orSetMerge({ base, local, remote, policy: "add-wins" });
        const swapped = orSetMerge({ base, local: remote, remote: local, policy: "add-wins" });

        assert.deepEqual(sorted(forward.merged), sorted(swapped.merged));
        assert.deepEqual(sorted(forward.conflicts), sorted(swapped.conflicts));
    });

    it("commutes for both policies including a conflict hash", () => {
        const base = set("h", "x");
        const local: BranchDelta = { adds: set("lonly"), removes: set("h") };
        const remote: BranchDelta = { adds: set("h", "ronly"), removes: set("x") };

        for (const policy of ["add-wins", "remove-wins"] as const) {
            const f = orSetMerge({ base, local, remote, policy });
            const s = orSetMerge({ base, local: remote, remote: local, policy });
            assert.deepEqual(sorted(f.merged), sorted(s.merged), `merged mismatch for ${policy}`);
            assert.deepEqual(sorted(f.conflicts), sorted(s.conflicts), `conflicts mismatch for ${policy}`);
        }
    });
});

// ---------------------------------------------------------------------------
// orSetMerge — idempotence
// ---------------------------------------------------------------------------

describe("orSetMerge: idempotence", () => {
    it("merging a branch with itself reproduces its own head set", () => {
        const base = set("a", "b");
        const delta: BranchDelta = { adds: set("c"), removes: set("a") };
        const { merged } = orSetMerge({ base, local: delta, remote: delta, policy: "add-wins" });
        // head = base + c - a = {b, c}
        assert.deepEqual(sorted(merged), ["b", "c"]);
    });
});
