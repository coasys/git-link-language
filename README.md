# Git Link Language for AD4M

An AD4M Link Language that backs Perspectives with a real Git repository. Every `PerspectiveDiff` lands as one signed commit — a single `addLink` and a bulk `addLinks(N)` both collapse to one commit each. Full history is queryable, and the underlying repo is inspectable through any standard Git tool.

Built with the modern [ALDK](https://github.com/coasys/ad4m/tree/dev/ad4m-ldk) (`@coasys/ad4m-ldk`) pattern.

**Status:** v0.1. Bidirectional convergence: the pull path walks remote commit ancestry and OR-Set-merges divergent histories into a genuine two-parent merge commit. Push (write-back to the remote) is the remaining follow-up.

The commit DAG **is** the convergence substrate this Language exposes to AD4M — the `perspective-sync` revision is the HEAD commit SHA (a content hash), and convergence is a DAG operation (ancestry walk + merge), not a snapshot fetch-and-replace. See [Diff-DAG convergence](#diff-dag-convergence).

---

## What it does

- **One commit per `PerspectiveDiff`.** Additions write `links/<hash>.json` files in the working tree; removals delete them; both are staged and committed in a single Git commit signed under a DID-derived committer identity.
- **Convergent remote sync.** The pull path walks the remote commit chain back to the last commit it already mirrored, reconstructs each missing commit locally as a real Git object (preserving remote author/message/timestamp), then fast-forwards or — on genuine divergence — writes an **OR-Set merge commit** keyed by link hash. `MERGE_POLICY` resolves a concurrent add-vs-remove of the same hash.
- **Full local history.** Custom `git-history`, `git-state-at`, and `git-blame` query kinds expose the commit DAG, render the Perspective as it existed at any past SHA, and locate the commit that introduced a given link.
- **Fast `link-pattern` queries** against an in-memory cache that mirrors the current `links/` tree. The cache is a *derived* view — HEAD is the source of truth and the cache is rebuilt from it after every convergence.
- **Self-contained.** No external daemon, no native dependency. The bundle includes `isomorphic-git` and runs anywhere AD4M does.

---

## Architecture

```
index.ts
└── defineLanguage capabilities:
    ├── perspective-commit   → src/operations.ts ─┐
    ├── perspective-sync     → src/operations.ts ─┤
    │   ├── sync()                                 │
    │   ├── render()                               │
    │   └── currentRevision()                      │
    └── perspective-query    → src/queries.ts ─────┤
        ├── link-pattern     (filter cache)        │
        ├── git-history      (walk commit DAG)     │  uses
        ├── git-state-at     (read tree at SHA)    │  src/git.ts (isomorphic-git wrappers)
        └── git-blame        (find introducing commit) │
                                                    │
src/providers/github.ts ← JSON REST client for GitHub (refs/commits/trees/blobs)
src/remote-sync.ts ← ancestry-walk pull + mirror + fast-forward/OR-Set-merge; chained-setTimeout loop (default 60 s, ETag-conditional)
src/merge.ts      ← pure OR-Set fold (adds ∪ − tombstones) + MERGE_POLICY conflict resolution
src/store.ts      ← in-memory cache (links, indexes, revision, remote-sha, etag, remote→local mirror map)
src/fs-adapter.ts ← isomorphic-git fs over storage KV (base64-encoded binary)
src/http-transport.ts ← iso-git HttpClient over httpFetch (binary-blocked, see below)
src/encoding.ts   ← base64, UTF-8, link hashing, link file paths
```

### Data model

A Perspective is a Git repository under the language's storage directory. Each link expression is one JSON file in `links/`, named by `hash(source + predicate + target + author + timestamp)`. Links are therefore **immutable, content-addressed elements**: the same link has the same hash on every replica, and two different links can never collide. Concurrent additions merge as a clean tree-union, and — because add and remove both key on the identical hash — a removal on one replica converges against the original add on another with no coordinator. This is exactly what the OR-Set merge relies on (see [Diff-DAG convergence](#diff-dag-convergence)).

```
<perspective-repo>/
├── .git/                  # Git internals (binary, base64-encoded in storage)
└── links/
    └── <link-hash>.json   # one file per link
```

---

## Remote sync

Git smart-protocol responses are binary (pack files). The executor's `httpFetch` returns response bodies as UTF-8 strings, which mangles non-UTF-8 bytes via U+FFFD replacement. The smart-protocol path is therefore unreachable.

The Language closes the loop by talking to Git provider **JSON REST APIs** instead — refs, commits, trees, and blobs (base64-encoded content) all round-trip cleanly through `httpFetch` because they are valid UTF-8 on the wire.

**v1 provider support:**

| Provider | Pull | Push | Notes |
|---|---|---|---|
| GitHub (`github.com/<o>/<r>`) | ✅ Automatic, 60 s default | ⚠️ Follow-up | Uses `/repos/<o>/<r>/git/{refs,commits,trees,blobs}` |
| GitLab / Gitea | Planned | ⚠️ Follow-up | Same shape, different URL prefix |
| Self-hosted Git / Radicle web seed | Manual fallback | ⚠️ Follow-up | Configure as opaque remote; pull via external `git pull` + AD4M `sync()` |

**How the pull loop works:**

1. Every `PULL_INTERVAL_MS` (default 60 s), the Language calls `GET /git/refs/heads/<branch>` with `If-None-Match: <last-etag>`. GitHub returns **304 Not Modified** for unchanged refs, and 304s do not count against the rate limit — idle Perspectives are essentially free.
2. When the ref SHA changes, the Language converges via a DAG walk — **not** a snapshot of the head tree. See [Diff-DAG convergence](#diff-dag-convergence) for the full algorithm.
3. The remote SHA, ETag, and the remote→local commit-mirror map are persisted in the cache so reboots resume the ancestry walk cleanly instead of re-mirroring.

**On-demand mode (`PULL_INTERVAL_MS=0`):** the background timer is disabled, but the standard `perspective-sync.sync()` capability still routes through the same pull. Apps trigger refreshes by calling the AD4M `perspective.pullLinks` / `perspective.sync()` RPC — useful when polling is wasteful and the UI knows when state should change (e.g. after a user "refresh" action, or driven by an external signal).

**Push** (after a local `addLink`) is the follow-up: POST `/git/blobs` (base64), POST `/git/trees`, POST `/git/commits`, PATCH `/git/refs/heads/<branch>`. Same plumbing, opposite direction. Wired in a subsequent PR. `PUSH_DEBOUNCE_MS` is reserved for it.

**Local-only fallback:** if `REMOTE_URL` is unset or points at an unsupported host (raw self-hosted Git, Radicle web seeds), the Language runs in local-only mode. `sync()` still detects external HEAD movement and emits the diff for two-peer setups that share storage out-of-band.

---

## Diff-DAG convergence

AD4M's `perspective-sync` contract is a hash-linked **diff-DAG** with content-addressed convergence: each replica holds a causal DAG of link diffs, and any two replicas converge to the same link-set with no coordinator. This Language rides Git's native commit-DAG as that substrate — one commit per diff, and the `perspective-sync` revision is the HEAD commit SHA. Convergence is therefore a DAG operation:

**1. Ancestry walk.** From the remote head, parent pointers are walked back to the last remote commit already mirrored, accumulating the ordered list of commits the local replica is missing. Each intermediate commit's own add/remove diff is applied in causal order — a multi-commit remote advance is **not** collapsed into a snapshot of the head tree (that was the bug this design fixes).

**2. Local mirror.** Each missing remote commit is reconstructed as a real local Git commit (same link-set, preserving remote author/message/timestamp). Every AD4M agent keeps its own per-agent repo, so mirroring gives the incoming history a genuine, ancestry-walkable presence in the local object store — which is what lets a merge commit carry a real second parent and lets `git merge-base` find the true fork point.

**3. Fast-forward or merge.**
- If the local branch has not advanced past the remote's fork point, the branch fast-forwards onto the mirrored remote head.
- If **both** sides advanced from a shared base (genuine divergence), the two branches are OR-Set-merged (`src/merge.ts`) and a genuine **two-parent merge commit** is written.

### OR-Set merge

Because links are immutable and content-addressed, the link-set is an **OR-Set** (observed-remove set):

- an **add** of link `h` inserts `h`;
- a **remove** of link `h` tombstones that specific `h`;
- **merge** = union of adds, minus the union of tombstones.

Each branch's adds/removes are derived from its **commit op-log since the merge base** (the union of every commit's add/remove ops, causal order, last-op-wins per hash), *not* from a base-vs-head snapshot diff. This distinction is load-bearing: an add-then-remove on a branch is thereby recorded as an observed tombstone even when the merge base predates the link entirely — a snapshot diff would silently lose that removal and resurrect the link. Removals stay first-class and carry the original link hash, so a removal on one branch converges against the original add on another.

### MERGE_POLICY

The only genuine conflict is a link hash that is **concurrently added on one branch and removed on the other** (relative to the base). `MERGE_POLICY` resolves it deterministically:

- `add-wins` (default) — the link is present in the merge.
- `remove-wins` — the tombstone wins; the link is absent.

`src/merge.ts` is pure (sets in, merged set out) and order-independent by construction: union and difference commute, so applying two diffs in either order yields the same link-set and the same materialised revision.

### Determinism note

Cross-network convergence between two *live* AD4M nodes cannot be exercised in this repo's unit tests (no live backend). It is instead covered structurally by `tests/convergence.test.ts`, which drives the real `remote-sync` + Git plumbing against an in-memory content-addressed fake remote (`tests/fake-remote.ts`) modelling multi-commit remote histories and server-side divergence. The four acceptance properties — ancestry walk applies each intermediate diff, removal/tombstone convergence, concurrent add-vs-remove per `MERGE_POLICY`, merge order-independence, and DAG-authoritative fold from genesis — are each asserted end-to-end there.

---

## Template variables

```typescript
//!@ad4m-template-variable
const REMOTE_URL = "<to-be-filled>";        // e.g. "https://github.com/me/perspective.git"

//!@ad4m-template-variable
const DEFAULT_BRANCH = "main";

//!@ad4m-template-variable
const AUTH_TOKEN = "";                       // GitHub PAT, sent as "Authorization: token <pat>"

//!@ad4m-template-variable
const PULL_INTERVAL_MS = "60000";            // pull cadence; 0 or unset disables the loop

//!@ad4m-template-variable
const MERGE_POLICY = "add-wins";             // add-wins | remove-wins — resolves concurrent add-vs-remove of the same link hash during divergent-history merge

//!@ad4m-template-variable
const PUSH_DEBOUNCE_MS = "5000";             // push-side; reserved for the write-back follow-up
```

**Active in v1:**

- `REMOTE_URL`, `AUTH_TOKEN`, `PULL_INTERVAL_MS`, `DEFAULT_BRANCH` — drive the JSON-API pull loop.
- `MERGE_POLICY` — parsed once at init and threaded into every pull; decides the concurrent add-vs-remove conflict during divergent-history convergence (see [Diff-DAG convergence](#diff-dag-convergence)).

**Captured for the push follow-up:**

- `PUSH_DEBOUNCE_MS`.

---

## Custom query kinds

### `link-pattern`

Standard. Filter the link set by source/target/predicate.

```typescript
{ kind: "link-pattern", payload: { source?: string; target?: string; predicate?: string } }
// → { kind: "links", payload: LinkExpression[] }
```

### `git-history`

Walk the commit DAG starting from HEAD (or `from`). Each `CommitRecord` is decorated with the link hashes added and removed in that commit relative to its first parent.

```typescript
{ kind: "git-history", payload: { from?: SHA; to?: SHA; limit?: number } }
// → { kind: "history", payload: CommitRecord[] }
```

### `git-state-at`

Render the Perspective as it existed at a specific commit. Pure read; HEAD is not moved.

```typescript
{ kind: "git-state-at", payload: { sha: SHA } }
// → { kind: "perspective", payload: { links: LinkExpression[] } }
```

### `git-blame`

For a specific link hash, locate the commit that introduced it (and the commit that removed it, if absent now).

```typescript
{ kind: "git-blame", payload: { linkHash: string } }
// → { kind: "blame", payload: BlameRecord | null }
```

---

## Prerequisites

- **[Deno](https://deno.land/)** (v1.32+) — used by the build script.
- **[Node.js](https://nodejs.org/)** (v20+) + **pnpm** — for dev dependencies and tests.
- **`@coasys/ad4m-ldk`** at `../ad4m/ad4m-ldk/js/` (or set `AD4M_LDK_ENTRY` env var to its compiled `lib/index.js`).

## Build, test, type-check

```bash
NODE_ENV=development pnpm install
pnpm test       # 133 tests across 54 suites
pnpm typecheck  # tsc --noEmit
pnpm build      # → build/bundle.js (~632KB, includes isomorphic-git)
```

## Project structure

```
├── index.ts                   # defineLanguage entry — flat exports
├── esbuild.ts                 # Build script (Deno + esbuild)
├── package.json
├── tsconfig.json
├── src/
│   ├── types.ts               # LinkExpression, PerspectiveDiff, CommitRecord, BlameRecord
│   ├── adapters.ts            # Transport, Storage, Runtime, Signing interfaces
│   ├── adapters-deno.ts       # Concrete adapters wrapping ad4m:host
│   ├── encoding.ts            # base64, UTF-8, link hashing, link file paths
│   ├── fs-adapter.ts          # isomorphic-git fs over storage KV
│   ├── http-transport.ts      # iso-git HttpClient over httpFetch (binary-blocked)
│   ├── git.ts                 # iso-git wrappers (init, commit, log, diff, tree walk, low-level object plumbing, branch op-log)
│   ├── merge.ts               # pure OR-Set fold + MERGE_POLICY conflict resolution
│   ├── providers/github.ts    # GitHub JSON REST API client
│   ├── remote-sync.ts         # ancestry-walk pull + mirror + fast-forward/OR-Set-merge; setTimeout loop + pullOnce
│   ├── store.ts               # In-memory link cache + indexes + remote-sha/etag + mirror map
│   ├── queries.ts             # link-pattern + git-history + git-state-at + git-blame
│   └── operations.ts          # commit, sync (pull-routed), render, currentRevision, boot
├── tests/
│   ├── fake-remote.ts         # in-memory content-addressed fake remote (multi-commit histories)
│   ├── encoding.test.ts
│   ├── fs-adapter.test.ts
│   ├── git-ops.test.ts
│   ├── github-provider.test.ts
│   ├── merge.test.ts          # pure OR-Set semantics (order-independence, tombstones, policy)
│   ├── convergence.test.ts    # end-to-end diff-DAG: ancestry walk, divergent merge, fold
│   ├── operations.test.ts
│   ├── remote-sync.test.ts
│   └── store.test.ts
└── build/bundle.js            # esbuild output
```

## License

[Cryptographic Autonomy License v1.0 (CAL-1.0)](LICENSE)
