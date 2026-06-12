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
