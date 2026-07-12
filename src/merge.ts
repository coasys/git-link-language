/**
 * OR-Set (observed-remove set) merge of two divergent Git branches.
 *
 * Links are immutable, content-addressed elements: a link's hash covers
 * its full triple plus author and timestamp, so the *same* link always
 * has the *same* hash on every replica, and two different links can never
 * collide. That property is exactly what an OR-Set needs, which lets us
 * converge two divergent histories with NO coordinator / scribe:
 *
 *   - An **add** of link `h` inserts `h` (observed) into the set.
 *   - A **remove** of link `h` tombstones the specific observed `h`.
 *   - **Merge** = union of adds, minus the union of tombstones.
 *
 * Because add and remove both key on the identical content hash, a
 * removal on one branch converges against the original add on the other
 * branch across replicas — the removal is "first-class" and carries the
 * original hash (spec §2.4).
 *
 * The only genuine conflict is a link hash that is **added on one branch
 * and removed on the other, concurrently** (i.e. relative to the merge
 * base). `MERGE_POLICY` decides that case:
 *
 *   - `add-wins`    → the link is present in the merge (default OR-Set).
 *   - `remove-wins` → the tombstone wins; the link is absent.
 *
 * This module is pure: it operates on hash sets + a resolved link-content
 * lookup and returns the merged link-set. It has no Git or IO dependency,
 * so it is exhaustively unit-testable and order-independent by
 * construction (all inputs are sets; union and difference commute).
 */

export type MergePolicy = "add-wins" | "remove-wins";

export function parseMergePolicy(raw: string | undefined | null): MergePolicy {
    return raw === "remove-wins" ? "remove-wins" : "add-wins";
}

/**
 * The link-set delta a single branch introduced relative to the merge
 * base, expressed purely as content-addressed hashes.
 *
 *   - `adds`    — link hashes present at this branch's head but not at
 *                 the merge base.
 *   - `removes` — link hashes present at the merge base but absent at
 *                 this branch's head (observed removals / tombstones).
 */
export interface BranchDelta {
    adds: Set<string>;
    removes: Set<string>;
}

/**
 * Compute a {@link BranchDelta} from the base and head link-hash sets of
 * one branch.
 */
export function deltaFromSets(
    base: Set<string>,
    head: Set<string>,
): BranchDelta {
    const adds = new Set<string>();
    const removes = new Set<string>();
    for (const h of head) {
        if (!base.has(h)) adds.add(h);
    }
    for (const h of base) {
        if (!head.has(h)) removes.add(h);
    }
    return { adds, removes };
}

export interface MergeInput {
    /** Link hashes present at the common merge base. */
    base: Set<string>;
    /** What the local branch changed since the base. */
    local: BranchDelta;
    /** What the remote branch changed since the base. */
    remote: BranchDelta;
    policy: MergePolicy;
}

export interface MergeResult {
    /**
     * The merged link-set as content hashes. Deterministic and
     * order-independent: swapping `local` and `remote` yields the same
     * set.
     */
    merged: Set<string>;
    /**
     * Hashes that were concurrently added on one side and removed on the
     * other (the genuine conflicts resolved by `policy`). Surfaced for
     * observability / testing.
     */
    conflicts: Set<string>;
}

/**
 * Fold two branch deltas over a shared base into a single converged link
 * hash-set, per the OR-Set semantics above.
 *
 * The algorithm:
 *   1. Start from the union of everything ever observed as present:
 *      base ∪ local.adds ∪ remote.adds.
 *   2. Apply tombstones: a hash is removed if it was removed on either
 *      side — UNLESS it was concurrently (re-)added on the other side and
 *      the policy is `add-wins`.
 *
 * "Concurrent add+remove of h" ≙ h ∈ (local.adds ∩ remote.removes) or
 * h ∈ (remote.adds ∩ local.removes). For a hash to be added on one side
 * it must have been absent at the base, so the only way the other side
 * "removes" that same hash is if it, too, added-then-removed it — which
 * is itself a tombstone we honour. In practice the conflict set captures
 * add-on-one-side vs tombstone-on-the-other for the identical hash.
 */
export function orSetMerge(input: MergeInput): MergeResult {
    const { base, local, remote, policy } = input;

    // 1. Everything ever observed present.
    const present = new Set<string>(base);
    for (const h of local.adds) present.add(h);
    for (const h of remote.adds) present.add(h);

    // Union of tombstones from both branches.
    const tombstones = new Set<string>();
    for (const h of local.removes) tombstones.add(h);
    for (const h of remote.removes) tombstones.add(h);

    // Concurrent add-vs-remove of the identical hash.
    const conflicts = new Set<string>();
    for (const h of tombstones) {
        const addedOnOtherSide =
            (local.adds.has(h) && remote.removes.has(h)) ||
            (remote.adds.has(h) && local.removes.has(h));
        if (addedOnOtherSide) conflicts.add(h);
    }

    // 2. Apply tombstones.
    const merged = new Set<string>();
    for (const h of present) {
        if (!tombstones.has(h)) {
            merged.add(h);
            continue;
        }
        // h is tombstoned. Keep it only if it's a conflict AND add-wins.
        if (conflicts.has(h) && policy === "add-wins") {
            merged.add(h);
        }
    }

    return { merged, conflicts };
}
