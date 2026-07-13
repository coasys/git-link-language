import * as esbuild from "https://deno.land/x/esbuild@v0.19.4/mod.js";
import { resolve } from "https://deno.land/std@0.201.0/path/mod.ts";

// Resolve `@coasys/ad4m-ldk` — prefer AD4M_LDK_ENTRY env, fall back to
// sibling directory relative to this script.
const ad4mLdkEntry = Deno.env.get("AD4M_LDK_ENTRY") ||
    new URL("../ad4m/ad4m-ldk/js/lib/index.js", import.meta.url).pathname;

// Project root — only resolve .js→.ts within our own source tree
const projectRoot = new URL(".", import.meta.url).pathname.replace(/\/$/, "");

const ad4mLdkAliasPlugin = {
    name: "ad4m-ldk-alias",
    setup(build: any) {
        // Mark ad4m:host as external — resolved at runtime by the executor
        build.onResolve({ filter: /^ad4m:host$/ }, () => ({
            path: "ad4m:host",
            external: true,
        }));
        // Resolve @coasys/ad4m-ldk to the local workspace build
        build.onResolve({ filter: /^@coasys\/ad4m-ldk$/ }, () => ({
            path: ad4mLdkEntry,
            namespace: "file",
        }));
    },
};

// isomorphic-git ships both a CJS build (index.cjs, selected by the "node"
// export condition) and a pre-bundled ESM build (index.js, the "default"
// condition). Under platform:"node", esbuild matches the "node" condition and
// pulls in the full CJS tree wrapped in esbuild's CJS interop (__commonJS /
// __require). Forcing the pure-ESM entry roughly halves the bundle and drops
// most of that interop; the two remaining CJS leaves that runtime-`require`
// Node builtins (safe-buffer -> "buffer", inherits -> "util") are neutralised
// by nodeBuiltinShimPlugin below so NO runtime require survives.
// Resolve through the pnpm symlink to the real .pnpm location so isomorphic-git's
// own dependencies (async-lock, sha.js, crc-32, pako, pify, ignore) resolve from
// its sibling node_modules rather than the (un-hoisted) project root.
const isomorphicGitEsmEntry = Deno.realPathSync(
    new URL(
        "./node_modules/isomorphic-git/index.js",
        `file://${projectRoot}/`,
    ).pathname,
);

const isomorphicGitEsmPlugin = {
    name: "isomorphic-git-esm",
    setup(build: any) {
        build.onResolve({ filter: /^isomorphic-git$/ }, () => ({
            path: isomorphicGitEsmEntry,
            namespace: "file",
        }));
    },
};

// The executor's language runtime (rust-executor language_bootstrap.js) imports
// `node:buffer` at startup and assigns `globalThis.Buffer`, but it does NOT
// install a synchronous `require()` resolver for bare Node builtins. Two CJS
// leaves in isomorphic-git's ESM tree runtime-require builtins:
//   safe-buffer (pulled by sha.js) -> require("buffer").Buffer
//   inherits                        -> require("util").inherits
// Under platform:"node" esbuild leaves these as external `__require(...)` calls.
// At runtime deno_core routes `__require("buffer")` through op_import_sync, which
// resolves bare `buffer` to Deno's node:buffer ESM polyfill. That polyfill's
// module graph contains top-level await, so V8's is_graph_async() is true and
// deno_core's mod_evaluate_sync throws CoreError::TLA ("Top-level await is not
// allowed in synchronous evaluation"), aborting evaluation of the ENTIRE language
// bundle. (git is the only language that hits this: it is the only one bundling a
// CJS lib that runtime-requires a Node builtin — the other eight bundles have
// zero __commonJS and zero runtime require.) Fix: resolve these builtins to tiny
// inline ESM shims backed by the already-global Buffer, so esbuild bundles them
// and no runtime require survives.
const nodeBuiltinShims: Record<string, string> = {
    buffer: `
        const B = globalThis.Buffer;
        export { B as Buffer };
        export function SlowBuffer(n) { return B.allocUnsafeSlow(n); }
        export const INSPECT_MAX_BYTES = 50;
        export const kMaxLength = 0x7fffffff;
        export const kStringMaxLength = 0x1fffffe8;
        export const constants = { MAX_LENGTH: kMaxLength, MAX_STRING_LENGTH: kStringMaxLength };
        export default { Buffer: B, SlowBuffer, INSPECT_MAX_BYTES, kMaxLength, kStringMaxLength, constants };
    `,
    util: `
        export function inherits(ctor, superCtor) {
            if (superCtor) {
                ctor.super_ = superCtor;
                Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
            }
        }
        export default { inherits };
    `,
};

const nodeBuiltinShimPlugin = {
    name: "node-builtin-shim",
    setup(build: any) {
        build.onResolve({ filter: /^(buffer|util)$/ }, (args: any) => ({
            path: args.path,
            namespace: "node-builtin-shim",
        }));
        build.onLoad(
            { filter: /.*/, namespace: "node-builtin-shim" },
            (args: any) => ({ contents: nodeBuiltinShims[args.path], loader: "js" }),
        );
    },
};

// Plugin to resolve .js imports to .ts source files, but ONLY within
// our own source tree. The ALDK lib/ ships compiled .js and node_modules
// dependencies must resolve as-is.
const ownSourceRoots = [
    `${projectRoot}/src`,
    projectRoot,
];

function isOwnSource(dir: string): boolean {
    if (dir.includes("/node_modules/")) return false;
    return ownSourceRoots.some((root) => dir === root || dir.startsWith(`${root}/`));
}

const tsResolverPlugin = {
    name: "ts-resolver",
    setup(build: any) {
        build.onResolve({ filter: /\.js$/ }, (args: any) => {
            if (args.namespace !== "file" || !args.path.startsWith(".")) return;
            const resolveDir = args.resolveDir || ".";
            if (!isOwnSource(resolveDir)) return;
            const tsPath = args.path.replace(/\.js$/, ".ts");
            const resolved = resolve(resolveDir, tsPath);
            return { path: resolved, namespace: "file" };
        });
    },
};

const result = await esbuild.build({
    plugins: [
        ad4mLdkAliasPlugin,
        isomorphicGitEsmPlugin,
        nodeBuiltinShimPlugin,
        tsResolverPlugin,
    ],
    entryPoints: ["index.ts"],
    absWorkingDir: projectRoot,
    outfile: "build/bundle.js",
    bundle: true,
    platform: "node",
    target: "es2022",
    format: "esm",
    globalName: "git.link.language",
    charset: "ascii",
    legalComments: "inline",
    // isomorphic-git pulls in the `ignore` package, whose module-init code reads
    // `process.env.IGNORE_TEST_WIN32` to detect a win32 test mode. Under the
    // executor's Deno runtime, `process.env.<key>` routes through `Deno.env.get`,
    // which the per-language sandbox denies (allow_env:none) — throwing NotCapable
    // during bundle evaluation and aborting the language load. (The executor's
    // SmartGlobalVariableFuture then mislabels every such event-loop error as the
    // generic "Top-level await is not allowed in synchronous evaluation", which is
    // why this surfaced as a TLA red herring.) Fold the env read to a build-time
    // constant so no runtime env access survives — we are never in win32 test mode.
    define: {
        "process.env.IGNORE_TEST_WIN32": "false",
    },
    // External Node builtins — the executor's Deno runtime provides these
    // via its node-compatibility layer at runtime.
    external: [
        "node:crypto",
        "node:fs",
        "node:path",
        "node:stream",
        "node:util",
        "node:buffer",
        "node:events",
        "node:url",
    ],
});

console.log("Build result:", result);

esbuild.stop();
