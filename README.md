# Git Link Language for AD4M

An AD4M Link Language that backs Perspectives with a real Git repository. Every `PerspectiveDiff` lands as one signed commit — a single `addLink` and a bulk `addLinks(N)` both collapse to one commit each. Full history is queryable, and the underlying repo is inspectable through any standard Git tool.

Built with the modern [ALDK](https://github.com/coasys/ad4m/tree/dev/ad4m-ldk) (`@coasys/ad4m-ldk`) pattern.

**Status:** v0.1. Bidirectional sync: the pull path walks remote commit ancestry and OR-Set-merges divergent histories into a genuine two-parent merge commit, and — for providers that expose a JSON write API — the **push path mirrors local commits back to the configured remote** (trailing-edge debounced, non-fast-forward → pull + merge + retry). The remote is chosen from the `REMOTE_KIND × REMOTE_URL` instance parameters: **GitHub** (read + write) and **Radicle** (read-convergent; push is out-of-band via the local `rad` node) are supported today.

The commit DAG **is** the convergence substrate this Language exposes to AD4M — the `perspective-sync` revision is the HEAD commit SHA (a content hash), and convergence is a DAG operation (ancestry walk + merge), not a snapshot fetch-and-replace. See [Diff-DAG convergence](#diff-dag-convergence).

---

## What it does

- **One commit per `PerspectiveDiff`.** Additions write `links/<hash>.json` files in the working tree; removals delete them; both are staged and committed in a single Git commit signed under a DID-derived committer identity.
- **Convergent remote sync.** The pull path walks the remote commit chain back to the last commit it already mirrored, reconstructs each missing commit locally as a real Git object (preserving remote author/message/timestamp), then fast-forwards or — on genuine divergence — writes an **OR-Set merge commit** keyed by link hash. `MERGE_POLICY` resolves a concurrent add-vs-remove of the same hash.
- **Push write-back (capable providers).** After a local commit, the push path walks HEAD back to the boundary the remote already holds and POSTs each missing commit's objects bottom-up (blobs → tree → commit) via the provider's JSON write API, then advances the ref. Because Git object hashing is deterministic over content, a byte-identical POST reproduces the local OID — every write asserts `returnedSha === localOid`, so a push is the exact mirror image of a pull. A non-fast-forward ref rejection triggers a pull + OR-Set merge and one retry.
- **Pluggable providers.** `REMOTE_KIND` (`auto` | `github` | `radicle`) selects the backing forge; `auto` infers it from `REMOTE_URL`. GitHub is read + write; Radicle is read-convergent (`radicle-httpd` exposes no JSON write API, so pushes go out-of-band through the local `rad` node — an honest capability boundary, `canPush = false`).
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
src/providers/types.ts  ← GitProvider interface (reads + writes + canPush)
src/providers/select.ts ← REMOTE_KIND × REMOTE_URL → provider (explicit kind wins; auto infers from URL)
src/providers/github.ts ← JSON REST client for GitHub — reads + writes (refs/commits/trees/blobs), canPush = true
src/providers/radicle.ts ← radicle-httpd JSON reads (project doc / commits / tree / blob); writes throw (canPush = false)
src/remote-sync.ts ← ancestry-walk pull + mirror + fast-forward/OR-Set-merge AND mirror-image push (blobs→tree→commit, SHA-equality asserted, NFF→pull+retry); chained-setTimeout loop (default 60 s, ETag-conditional)
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

**Provider selection.** `REMOTE_KIND` picks the backing forge: an explicit `github` / `radicle` wins outright (and selection is null if `REMOTE_URL` does not parse for that kind — no silent fallback); the default `auto` probes each provider's URL parser in turn. An empty / `<to-be-filled>` `REMOTE_URL` means no remote (local-only). See `src/providers/select.ts`.

**v1 provider support:**

| Provider | `REMOTE_KIND` | Pull | Push | Notes |
|---|---|---|---|---|
| GitHub (`github.com/<o>/<r>`) | `github` / `auto` | ✅ Automatic, 60 s default | ✅ Debounced write-back | `/repos/<o>/<r>/git/{refs,commits,trees,blobs}`; `canPush = true` |
| Radicle (RID, `radicle-httpd`, or explorer URL) | `radicle` / `auto` | ✅ Read-convergent | ⛔ Out-of-band | `radicle-httpd` `/api/v1` reads only; no JSON write API, so push is via the local `rad` node. `canPush = false` |
| GitLab / Gitea | (planned) | Planned | Planned | Same JSON-plumbing shape, different URL prefix |

**How the pull loop works:**

1. Every `PULL_INTERVAL_MS` (default 60 s), the Language calls `GET /git/refs/heads/<branch>` with `If-None-Match: <last-etag>`. GitHub returns **304 Not Modified** for unchanged refs, and 304s do not count against the rate limit — idle Perspectives are essentially free.
2. When the ref SHA changes, the Language converges via a DAG walk — **not** a snapshot of the head tree. See [Diff-DAG convergence](#diff-dag-convergence) for the full algorithm.
3. The remote SHA, ETag, and the remote→local commit-mirror map are persisted in the cache so reboots resume the ancestry walk cleanly instead of re-mirroring.

**On-demand mode (`PULL_INTERVAL_MS=0`):** the background timer is disabled, but the standard `perspective-sync.sync()` capability still routes through the same pull. Apps trigger refreshes by calling the AD4M `perspective.pullLinks` / `perspective.sync()` RPC — useful when polling is wasteful and the UI knows when state should change (e.g. after a user "refresh" action, or driven by an external signal).

**How the push path works (GitHub):** after a local commit advances HEAD, a **trailing-edge debounced** push (default `PUSH_DEBOUNCE_MS` = 5 s — a burst of `addLink`s coalesces into one push fired after the last) walks HEAD back to the boundary the remote already holds (tracked via the remote→local mirror map) and POSTs each missing commit oldest-first: `POST /git/blobs` (UTF-8), `POST /git/trees`, `POST /git/commits`, then `PATCH /git/refs/heads/<branch>` (creating the ref with `POST /git/refs` if absent). Every write asserts the SHA GitHub returns equals the local OID; a mismatch is a hard error (never a silent divergence). If the ref PATCH is rejected as a non-fast-forward (the remote moved under us), the push runs `pullOnce()` to OR-Set-merge, then retries **once**. Local commits are pinned to a **UTC** author/committer so the OID is reproducible off-box — the ISO date POSTed to GitHub reconstructs the exact bytes Git hashed. Push failures are swallowed (logged) so they never break the local commit path; the next commit or a manual `sync()` re-attempts.

**Radicle push is out-of-band.** `radicle-httpd` exposes only a read API (`/api/v1`) — there is no JSON endpoint to create blobs/trees/commits or move a ref (the smart-protocol write path is unreachable through the executor's UTF-8-decoding `httpFetch`, and the sandbox cannot reach a local node socket). The Radicle provider therefore sets `canPush = false` and its write methods throw a clear, documented error; the Language skips auto-push and remains a read-convergent replica. Publishing changes back happens through the operator's local `rad` node (`rad push` / `git push rad`), after which every other replica converges by the normal pull path. This is an honest capability boundary, verified against the `radicle-httpd` route table — **not** a stub.

**Local-only fallback:** if `REMOTE_URL` is unset / `<to-be-filled>` or points at an unrecognised host, the Language runs in local-only mode. `sync()` still detects external HEAD movement and emits the diff for two-peer setups that share storage out-of-band.

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

## Verified live against a git-data server (co-located C1)

The AD4M wind-tunnel C1 scenario runs this language end-to-end against a **co-located git-data server** that speaks the GitHub JSON git-data REST contract (`infra/git-data-shim.mjs`, backed by the same `isomorphic-git` this language hashes with, so `returnedSha === localOid` holds by construction). Two executors template one shared repo — `GIT_API_BASE` points the GitHub provider at the shim and `owner/repo` is read from the `REMOTE_URL` path, so no github.com is touched — and the harness proves convergence via each executor's own `queryLinks`. **Both agents reached 20/20 links in 6.06 s and a removal converged in 2.05 s.** This exercises, for real, what the unit suite can only fake against `tests/fake-remote.ts`:

- **Wire fetches** — conditional ref reads and `commits` / `trees` / `blobs` GETs against a live HTTP server.
- **Object write-back** — `POST` blobs → trees → commits then `PATCH` the ref, each write asserting the returned SHA equals the local OID; a non-fast-forward `422` triggers pull → **OR-Set-over-commit-ancestry** merge → retry, with the background pull timer fast-forwarding both sides to the shared head.

Unlike the other backends' C1 runs, the defect this surfaced was not a convergence bug but a **masked bundle-load failure** — the language never loaded. The executor sandboxes each language bundle with `allow_env:none`, and `isomorphic-git`'s transitive `ignore` dep reads `process.env.IGNORE_TEST_WIN32` at module-init; a keyed `process.env` read routes through `Deno.env.get`, throws `NotCapable`, and aborts the whole bundle before the language constructor is exposed. The executor then *mislabelled* it as "Top-level await is not allowed in synchronous evaluation" (a hardcoded `CoreError::TLA` masking every event-loop error), which hid the real cause across multiple sessions. The build-time fix (an esbuild `define` folding the read to a constant) is regression-guarded by `tests/bundle-sandbox.test.ts` and documented in `AGENTS.md`; the executor observability fix rides a separate `ad4m` branch.

Live github.com round-trips and Radicle publish remain **out-of-band from CI** (see [Remote sync](#remote-sync)) — the hermetic shim proves convergence against the GitHub REST *contract*, not the hosted service.

---

## Template variables

```typescript
//!@ad4m-template-variable
const REMOTE_URL = "<to-be-filled>";        // GitHub repo URL, or a Radicle RID / radicle-httpd / explorer URL

//!@ad4m-template-variable
const REMOTE_KIND = "auto";                  // auto | github | radicle — auto infers the provider from REMOTE_URL

//!@ad4m-template-variable
const DEFAULT_BRANCH = "main";

//!@ad4m-template-variable
const AUTH_TOKEN = "";                       // GitHub PAT ("Authorization: token <pat>") / Radicle session ("Bearer <token>")

//!@ad4m-template-variable
const MERGE_POLICY = "add-wins";             // add-wins | remove-wins — resolves concurrent add-vs-remove of the same link hash during divergent-history merge

//!@ad4m-template-variable
const PUSH_DEBOUNCE_MS = "5000";             // trailing-edge push debounce; coalesces a burst of commits into one push (GitHub only)

//!@ad4m-template-variable
const PULL_INTERVAL_MS = "60000";            // pull cadence; 0 or unset disables the loop (manual sync() still works)
```

**All active in v1:**

- `REMOTE_URL` + `REMOTE_KIND` — select the provider (`src/providers/select.ts`); an empty / `<to-be-filled>` URL means local-only.
- `AUTH_TOKEN` — bearer/PAT for the chosen provider's reads (and GitHub writes).
- `PULL_INTERVAL_MS`, `DEFAULT_BRANCH` — drive the JSON-API pull loop.
- `MERGE_POLICY` — parsed once at init and threaded into every pull (and the push-retry merge); decides the concurrent add-vs-remove conflict during divergent-history convergence (see [Diff-DAG convergence](#diff-dag-convergence)).
- `PUSH_DEBOUNCE_MS` — trailing-edge debounce for the GitHub write-back; a no-op when the provider cannot push (Radicle) or the debounce is ≤ 0.

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
pnpm test       # 179 tests across 72 suites
pnpm typecheck  # tsc --noEmit
pnpm build      # → build/bundle.js (~647KB, includes isomorphic-git)
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
│   ├── providers/
│   │   ├── types.ts           # GitProvider interface (reads + writes + canPush)
│   │   ├── select.ts          # REMOTE_KIND × REMOTE_URL → provider
│   │   ├── github.ts          # GitHub JSON REST client (reads + writes)
│   │   └── radicle.ts         # radicle-httpd JSON reads; writes throw (canPush = false)
│   ├── remote-sync.ts         # ancestry-walk pull + mirror + fast-forward/OR-Set-merge + mirror-image push; setTimeout loop + pullOnce/pushOnce
│   ├── store.ts               # In-memory link cache + indexes + remote-sha/etag + mirror map
│   ├── queries.ts             # link-pattern + git-history + git-state-at + git-blame
│   └── operations.ts          # commit, sync (pull-routed), render, currentRevision, boot
├── tests/
│   ├── fake-remote.ts         # in-memory content-addressed fake remote (multi-commit histories)
│   ├── encoding.test.ts
│   ├── fs-adapter.test.ts
│   ├── git-ops.test.ts
│   ├── github-provider.test.ts   # GitHub read endpoints
│   ├── github-push.test.ts       # GitHub write payloads + pushOnce end-to-end (real iso-git "remote")
│   ├── provider-selection.test.ts # selectProvider over REMOTE_KIND × REMOTE_URL
│   ├── radicle-provider.test.ts  # parseRadicleUrl + radicle-httpd reads + write capability boundary
│   ├── merge.test.ts          # pure OR-Set semantics (order-independence, tombstones, policy)
│   ├── convergence.test.ts    # end-to-end diff-DAG: ancestry walk, divergent merge, fold
│   ├── operations.test.ts
│   ├── remote-sync.test.ts
│   └── store.test.ts
└── build/bundle.js            # esbuild output
```

## License

[Cryptographic Autonomy License v1.0 (CAL-1.0)](LICENSE)
