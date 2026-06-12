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
        └── tag                                     │
                                                    │
src/store.ts      ← in-memory cache (links, indexes, revision)
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

## Known Limitation: Remote Sync

Git smart-protocol responses are **binary** (pack files). The executor's `httpFetch` returns response bodies as UTF-8 strings, which mangles non-UTF-8 bytes via U+FFFD replacement. Until the host exposes a binary HTTP primitive (`httpFetchBytes`), this Language **cannot** perform automated `git fetch` or `git push` against any Git server. This is a fundamental host-contract gap, not a missing feature in the Language.

**What works today:**

- Two peers sharing the underlying repo storage (network mount, Syncthing, etc.) — `sync()` detects HEAD movement and emits the resulting `PerspectiveDiff`.
- A user running `git pull` from their terminal against the language storage directory, then calling `sync()` in AD4M.
- All local commits, history queries, blame, time-travel reads, revert.

**What waits on a host enhancement:**

- Automated push to a remote on commit.
- Automated fetch on `sync()`.
- See spec §11.2 in [git-link-language.md](https://github.com/HexaField/git-link-language/blob/main/spec/git-link-language.md) and §5.1 of the successor spec for the host-contract changes that unblock this.

The `REMOTE_URL`, `AUTH_TOKEN`, and related template variables are captured in the bundle and ready to be read by the network code path the moment the host gains binary HTTP support.

---

## Template variables

```typescript
//!@ad4m-template-variable
const REMOTE_URL = "<to-be-filled>";        // e.g. "https://github.com/me/perspective.git" (captured for future use)

//!@ad4m-template-variable
const DEFAULT_BRANCH = "main";

//!@ad4m-template-variable
const AUTH_TOKEN = "";                       // captured; not read in v1

//!@ad4m-template-variable
const MERGE_POLICY = "add-wins";             // add-wins | remove-wins (captured; not yet acted on in v1)

//!@ad4m-template-variable
const PUSH_DEBOUNCE_MS = "5000";             // captured; not yet acted on in v1
```

`DEFAULT_BRANCH` is the one variable v1 acts on — it's the branch the Language operates against. The rest are captured for forward compatibility with the remote-sync path.

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

| Name        | Parameters         | Effect                                                        |
|-------------|--------------------|---------------------------------------------------------------|
| `flush`     | none               | No-op in v1 (gated by binary HTTP).                           |
| `revert-to` | `sha: string`      | Compute the forward inverse and commit it. Preserves history. |
| `tag`       | `name`, `sha`      | Create a Git tag at the given commit.                         |

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
│   ├── store.ts               # In-memory link cache + indexes
│   ├── queries.ts             # link-pattern + git-history + git-state-at + git-blame
│   ├── interactions.ts        # flush, revert-to, tag
│   └── operations.ts          # commit, sync, render, currentRevision, boot
├── tests/
│   ├── encoding.test.ts
│   ├── fs-adapter.test.ts
│   ├── git-ops.test.ts
│   ├── operations.test.ts
│   └── store.test.ts
└── build/bundle.js            # esbuild output
```

## License

[Cryptographic Autonomy License v1.0 (CAL-1.0)](LICENSE)
