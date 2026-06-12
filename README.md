# Git Link Language for AD4M

An AD4M Link Language that backs Perspectives with a real Git repository. Every link change is one commit, full history is queryable, and the underlying repo is inspectable through any standard Git tool.

Built with the modern [ALDK](https://github.com/coasys/ad4m/tree/dev/ad4m-ldk) (`@coasys/ad4m-ldk`) pattern.

**Status:** v0.1, local-first only. See [Known Limitation: Remote Sync](#known-limitation-remote-sync) below.

---

## What it does

- **One commit per `PerspectiveDiff`.** Additions write `links/<hash>.json` files in the working tree; removals delete them; both are staged and committed in a single Git commit signed under a DID-derived committer identity.
- **Full local history.** Custom `git-history`, `git-state-at`, and `git-blame` query kinds expose the commit DAG, render the Perspective as it existed at any past SHA, and locate the commit that introduced a given link.
- **Fast `link-pattern` queries** against an in-memory cache that mirrors the current `links/` tree.
- **History-preserving revert.** The `revert-to` interaction computes the forward diff that takes current state back to a past state and commits it as a new commit — never destructively rewinds.
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
    ├── perspective-query    → src/queries.ts ─────┤
    │   ├── link-pattern     (filter cache)        │
    │   ├── git-history      (walk commit DAG)     │  uses
    │   ├── git-state-at     (read tree at SHA)    │  src/git.ts (isomorphic-git wrappers)
    │   └── git-blame        (find introducing commit) │
    └── interactions          → src/interactions.ts ─┤
        ├── flush             (gated; see below)    │
        ├── revert-to         (forward inverse)     │
        ├── tag                                     │
        └── pull-now          (immediate JSON pull) │
                                                    │
src/providers/github.ts ← JSON REST client for GitHub (refs/commits/trees/blobs)
src/remote-sync.ts ← chained-setTimeout pull loop (default 60 s, ETag-conditional)
src/store.ts      ← in-memory cache (links, indexes, revision, remote-sha, etag)
src/fs-adapter.ts ← isomorphic-git fs over storage KV (base64-encoded binary)
src/http-transport.ts ← iso-git HttpClient over httpFetch (binary-blocked, see below)
src/encoding.ts   ← base64, UTF-8, link hashing, link file paths
```

### Data model

A Perspective is a Git repository under the language's storage directory. Each link expression is one JSON file in `links/`, named by `hash(source + predicate + target + author + timestamp)`. The content-addressed naming makes concurrent additions merge as a clean tree-union — no textual merge conflicts on the link set itself.

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
2. When the ref SHA changes, the Language fetches the commit, walks the tree recursively, fetches any newly-needed blobs, decodes them from base64, and applies the resulting diff via the standard `commit` path. The local cache + emitted `PerspectiveDiff` update like any other addLink/removeLink.
3. The remote SHA and ETag are persisted in the cache so reboots resume cleanly.

**Manual override:** the `pull-now` interaction (§ Interactions) triggers an immediate pull, bypassing the 60-second tick — useful for "refresh" buttons in UIs.

**Push** (after a local `addLink`) is the follow-up: POST `/git/blobs` (base64), POST `/git/trees`, POST `/git/commits`, PATCH `/git/refs/heads/<branch>`. Same plumbing, opposite direction. Wired in a subsequent PR.

**Local-only fallback:** if `REMOTE_URL` is unset or points at an unsupported host (raw self-hosted Git, Radicle web seeds), the Language runs in local-only mode. `sync()` still detects external HEAD movement and emits the diff for two-peer setups that share storage out-of-band.

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
const MERGE_POLICY = "add-wins";             // add-wins | remove-wins (push-side; not yet acted on)

//!@ad4m-template-variable
const PUSH_DEBOUNCE_MS = "5000";             // push-side; not yet acted on
```

**Active in v1:**

- `REMOTE_URL`, `AUTH_TOKEN`, `PULL_INTERVAL_MS`, `DEFAULT_BRANCH` — drive the JSON-API pull loop.

**Captured for the push follow-up:**

- `MERGE_POLICY`, `PUSH_DEBOUNCE_MS`.

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

## Interactions

| Name        | Parameters         | Effect                                                                                |
|-------------|--------------------|---------------------------------------------------------------------------------------|
| `pull-now`  | none               | Trigger an immediate JSON-API pull, bypassing the 60-second tick. Returns the diff.   |
| `flush`     | none               | Force a push (push path is the follow-up; no-op in v1).                               |
| `revert-to` | `sha: string`      | Compute the forward inverse and commit it. Preserves history.                         |
| `tag`       | `name`, `sha`      | Create a Git tag at the given commit.                                                 |

---

## Prerequisites

- **[Deno](https://deno.land/)** (v1.32+) — used by the build script.
- **[Node.js](https://nodejs.org/)** (v20+) + **pnpm** — for dev dependencies and tests.
- **`@coasys/ad4m-ldk`** at `../ad4m/ad4m-ldk/js/` (or set `AD4M_LDK_ENTRY` env var to its compiled `lib/index.js`).

## Build, test, type-check

```bash
NODE_ENV=development pnpm install
pnpm test       # 83 tests across 31 suites
pnpm typecheck  # tsc --noEmit
pnpm build      # → build/bundle.js (~624KB, includes isomorphic-git)
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
│   ├── git.ts                 # iso-git wrappers (init, commit, log, diff, tree walk)
│   ├── providers/github.ts    # GitHub JSON REST API client
│   ├── remote-sync.ts         # chained-setTimeout pull loop + pullOnce
│   ├── store.ts               # In-memory link cache + indexes + remote-sha/etag
│   ├── queries.ts             # link-pattern + git-history + git-state-at + git-blame
│   ├── interactions.ts        # pull-now, flush, revert-to, tag
│   └── operations.ts          # commit, sync, render, currentRevision, boot
├── tests/
│   ├── encoding.test.ts
│   ├── fs-adapter.test.ts
│   ├── git-ops.test.ts
│   ├── github-provider.test.ts
│   ├── operations.test.ts
│   ├── remote-sync.test.ts
│   └── store.test.ts
└── build/bundle.js            # esbuild output
```

## License

[Cryptographic Autonomy License v1.0 (CAL-1.0)](LICENSE)
