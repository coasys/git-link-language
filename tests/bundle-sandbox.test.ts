/**
 * Regression guard for the executor's per-language sandbox.
 *
 * The executor loads each language bundle in a Deno runtime whose permissions
 * deny env access (allow_env: none). Any module-init-time read of a specific
 * environment variable — `process.env.<KEY>` — routes through `Deno.env.get`
 * and throws NotCapable, aborting evaluation of the ENTIRE bundle before the
 * language constructor is ever exposed. (The executor historically relabelled
 * that failure as "Top-level await is not allowed in synchronous evaluation",
 * a red herring that hid the real cause.)
 *
 * isomorphic-git pulls in the `ignore` package, whose module init reads
 * `process.env.IGNORE_TEST_WIN32`. esbuild's `define` folds that read to a
 * build-time constant so no runtime env access survives. This test asserts the
 * shipped bundle carries neither a permission-gated env read nor a surviving
 * runtime `require()` of a bare Node builtin (a sibling failure mode the
 * node-builtin shims neutralise) — either of which aborts the sandboxed load.
 *
 * Tests the built build/bundle.js (the shipped artifact — gitignored like every
 * sibling language, so `npm run build` must run before this test). Rebuild with
 * `npm run build` after changing esbuild config or dependencies.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const bundlePath = fileURLToPath(new URL("../build/bundle.js", import.meta.url));
const bundle = readFileSync(bundlePath, "utf8");

describe("bundle sandbox compatibility", () => {
    it("contains no permission-gated process.env keyed read", () => {
        // Bare `process.env` (the proxy object itself) is permission-safe; only a
        // keyed read `process.env.X` / `process.env["X"]` triggers Deno.env.get.
        const matches = bundle.match(/process\.env\s*[.\[]/g) ?? [];
        assert.deepEqual(
            [...new Set(matches)],
            [],
            "bundle must not read specific env vars — the executor sandbox denies " +
                "env access (allow_env:none) and a keyed process.env read throws " +
                "NotCapable, aborting the language load",
        );
    });

    it("contains no surviving runtime require() of a bare Node builtin", () => {
        // esbuild's CJS interop emits `__require("name")` for unresolved bare
        // requires. The executor installs no synchronous require resolver, so any
        // survivor aborts the sandboxed load; the node-builtin shims must absorb
        // them all. (The lone legitimate `__require` is the interop definition
        // `function __require()`, which this call-form regex does not match.)
        const matches =
            bundle.match(
                /__require\(\s*["'](?:node:)?(?:buffer|util|crypto|fs|path|stream|events|url|os|assert|process)["']\s*\)/g,
            ) ?? [];
        assert.deepEqual(
            [...new Set(matches)],
            [],
            "bundle must not runtime-require bare Node builtins — none is resolvable " +
                "in the executor's language runtime",
        );
    });
});
