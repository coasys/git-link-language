# AGENTS.md — git-link-language

AD4M link language that stores a Perspective as a **git commit-DAG** in a real
repository and syncs it to a remote forge. The commit history *is* the
convergence substrate; the checked-out working tree *is* the native projection —
so unlike the plain-text protocols this language needs no separate SHACL
transformer.

## Architecture (the load-bearing idea)

- **Role A — convergence substrate (source of truth).** A git commit-DAG. Each
  commit's tree carries link additions (one blob per link, named by link content
  hash) and removals (tombstones carrying the *original* link hash). Merge walks
  the commit ancestry and folds an **OR-Set keyed by link hash**, deriving the
  delta from the commit op-log rather than a base-vs-head snapshot — so
  add-then-remove converges and merge order does not matter.
- **Role B — native projection (derived).** The working tree / repo contents in
  git's own idiom. Native git users see and diff real files; there is no separate
  projection module.

Invariants — do not break these:

- `currentRevision()` is the **HEAD commit SHA** (a content hash of the DAG head).
  When histories diverge it is a deterministic digest of the sorted head SHAs.
  **Never** a timestamp, ETag, reflog index, or sequence integer.
- Removals are **tombstones carrying the original link hash**, never a `git rm`
  of history.
- `sync()` detects HEAD movement (from the automated remote loop, an external
  `git pull`, or shared storage) and emits the resulting PerspectiveDiff by
  walking commit ancestry — do not reintroduce snapshot diffing.

## Remote sync (instance-parameterised)

The remote leg rides provider **JSON REST APIs**, not the git smart protocol —
the executor's `httpFetch` UTF-8-decodes binary bodies and corrupts pack files,
so pack transport is unreachable from inside the language sandbox.

- **GitHub** (`src/providers/github.ts`): pull is ETag-conditional (60 s default);
  push is a trailing-edge debounced mirror — `POST` blobs → trees → commits,
  `PATCH` the ref, every write asserting the SHA GitHub returns equals the local
  OID; a non-fast-forward triggers pull → OR-Set merge → one retry.
- **Radicle** (`src/providers/radicle.ts`): read-convergent via `radicle-httpd`'s
  JSON read API. No JSON write path, so `canPush = false`; publishing is
  out-of-band via the operator's local `rad` node.
- The provider is chosen by the `REMOTE_KIND × REMOTE_URL` instance parameters
  (`auto` infers from the URL) in `src/providers/select.ts`. Setting `GIT_API_BASE`
  overrides host-based detection: the GitHub-REST provider targets that base
  (GitHub Enterprise, a self-hosted git-data server, or a co-located test rig) and
  takes `owner/repo` from the URL *path*, so the repo need not live on github.com.

## Layout

- `src/git.ts` — commit/tree/blob object model + DAG walk.
- `src/operations.ts` — commit construction from PerspectiveDiffs.
- `src/merge.ts` — OR-Set-over-commit-ancestry merge.
- `src/remote-sync.ts` — the pull/debounced-push loop over a `GitProvider`.
- `src/providers/{types,github,radicle,select}.ts` — the `GitProvider` interface,
  the two forge implementations, and `REMOTE_KIND × REMOTE_URL` selection.
- `src/http-transport.ts` — REST transport over the injected `Transport`.
- `src/queries.ts` — custom `perspective-query` kinds beyond `link-pattern`:
  `git-history` (walk the commit DAG), `git-state-at` (Perspective at any past
  SHA), `git-blame` (commit that introduced a link hash).
- `src/fs-adapter.ts` — on-disk repo access.
- `src/encoding.ts` — link ↔ blob encoding + content hashing.
- `src/interactions.ts` — the language-interface `interactions()` no-op.
- `src/store.ts` — derived link cache + query indexes.
- `src/{types}.ts` — shared types.
- `src/adapters.ts` / `src/adapters-deno.ts` — injected Transport / Storage /
  Runtime / Signing; `ad4m:host` imports confined to `adapters-deno.ts` +
  `index.ts`, so core modules stay runtime-agnostic and unit-testable.

## Build / test / typecheck

```bash
NODE_ENV=development pnpm install     # NODE_ENV=production skips devDeps — installs look broken
deno run --allow-all esbuild.ts       # bundle → build/ (needs @coasys/ad4m-ldk at ../ad4m/ad4m-ldk/js or AD4M_LDK_ENTRY)
npx tsc --noEmit                      # typecheck — the ONLY type gate; tsx/esbuild transpile without checking
node --experimental-vm-modules --import tsx --test tests/*.test.ts   # full suite
```

ESM imports use explicit `.js` extensions even for `.ts` sources. `npm test`
runs `node:test` via tsx; the summary lines are `ℹ tests N` / `ℹ pass N` /
`ℹ fail N`.

## What's unit-tested vs what needs a live backend

Hermetic (no network): the commit-DAG fold, OR-Set merge, revision stability,
order-independence, and the **push REST contract** — `tests/github-push.test.ts`
drives the push path against a request-recording mock asserting the exact
blobs→trees→commits→ref sequence and SHA-equality. **Not** in CI: live GitHub
round-trips (need real credentials + repo) and Radicle publish (needs a running
`rad` node).

## Gotchas

- Push MUST go through the JSON object API — do not attempt the smart/pack
  protocol; `httpFetch` will mangle the binary pack body.
- `interactions()` returning `[]` is the legitimate language-interface no-op, not
  a stub to fill.
- **Sandboxed env access is denied.** The executor evaluates each language bundle
  in a Deno runtime with `allow_env:none`. Any module-init-time *keyed* read of
  `process.env.<KEY>` routes through `Deno.env.get`, throws `NotCapable`, and
  aborts evaluation of the ENTIRE bundle before the language constructor is
  exposed. Bundled node deps that probe env at import must be neutralised at build
  time — e.g. `isomorphic-git` pulls in `ignore`, whose init reads
  `IGNORE_TEST_WIN32`; esbuild `define` folds that read to a constant (see
  `esbuild.ts`). Bare `process.env` (the object) is fine — only keyed reads throw.
  `tests/bundle-sandbox.test.ts` guards the shipped bundle against both this and a
  surviving bare-builtin `__require`. Historically such failures surfaced as a
  misleading `"Top-level await is not allowed in synchronous evaluation"` — a red
  herring from the executor's event-loop error handler (which relabelled every
  event-loop error as TLA), NOT an actual top-level await.
