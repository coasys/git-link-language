/**
 * User-invocable interactions exposed by the Language.
 *
 *   flush       — Force an immediate remote push (no-op in v1; the binary
 *                 HTTP gap means automated push is gated on a future host
 *                 enhancement).
 *   revert-to   — Compute the forward diff that takes the current state
 *                 back to a past commit's state and commit it. Preserves
 *                 history rather than destructively rewinding.
 *   tag         — Create a Git tag pointing at the given commit SHA.
 *                 Useful for named release / checkpoint markers.
 *
 * Interaction execute() functions return a short status string that
 * the host surfaces to the UI.
 */

import * as git from "isomorphic-git";

import * as gitops from "./git.js";
import * as ops from "./operations.js";
import type { GitFs } from "./fs-adapter.js";
import { deserializeLink } from "./encoding.js";
import type { LinkExpression } from "./types.js";

// ---------------------------------------------------------------------------
// Interaction shapes (matching the Language interface)
// ---------------------------------------------------------------------------

export interface InteractionParameter {
    name: string;
    type: string;
}

export interface Interaction {
    label: string;
    name: string;
    parameters: InteractionParameter[];
    execute(parameters: object): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Context bag captured per interactions() call
// ---------------------------------------------------------------------------

export interface InteractionContext {
    fs: GitFs;
    agentDid: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build the interaction set for a given expression address.
 *
 * `flush` and `revert-to` apply to the Perspective as a whole.
 * `tag` takes a commit SHA as a parameter.
 *
 * For v1 the same set is returned regardless of address — we don't
 * differentiate Perspective-scope from commit-scope at the address
 * level. Callers wire up the right interaction by name.
 */
export function buildInteractions(ctx: InteractionContext): Interaction[] {
    return [
        flushInteraction(),
        revertToInteraction(ctx),
        tagInteraction(ctx),
    ];
}

// ---------------------------------------------------------------------------
// flush
// ---------------------------------------------------------------------------

function flushInteraction(): Interaction {
    return {
        label: "Flush",
        name: "flush",
        parameters: [],
        async execute() {
            return "flush: no-op (automated remote push is gated on binary HTTP host support; see spec §11.2)";
        },
    };
}

// ---------------------------------------------------------------------------
// revert-to
// ---------------------------------------------------------------------------

function revertToInteraction(ctx: InteractionContext): Interaction {
    return {
        label: "Revert to commit",
        name: "revert-to",
        parameters: [{ name: "sha", type: "string" }],
        async execute(parameters) {
            const sha = (parameters as { sha?: string }).sha;
            if (!sha || typeof sha !== "string") {
                return "revert-to: missing or invalid `sha` parameter";
            }

            const head = await gitops.currentHead(ctx.fs);
            if (head === null) {
                return "revert-to: repo has no HEAD";
            }
            if (sha === head) {
                return "revert-to: target SHA equals current HEAD; nothing to do";
            }

            // Read the link set at both SHAs
            const targetHashes = await gitops.listLinkHashesAt(ctx.fs, sha);
            const currentHashes = await gitops.listLinkHashesAt(ctx.fs, head);

            // Compute the forward diff that takes current → target state
            const additions: LinkExpression[] = [];
            const removals: LinkExpression[] = [];

            for (const h of targetHashes) {
                if (currentHashes.has(h)) continue;
                const raw = await gitops.readLinkAt(ctx.fs, sha, h);
                if (!raw) continue;
                try {
                    additions.push(deserializeLink(raw));
                } catch (_err) {
                    // Skip malformed entries
                }
            }
            for (const h of currentHashes) {
                if (targetHashes.has(h)) continue;
                const raw = await gitops.readLinkAt(ctx.fs, head, h);
                if (!raw) continue;
                try {
                    removals.push(deserializeLink(raw));
                } catch (_err) {
                    // Skip
                }
            }

            if (additions.length === 0 && removals.length === 0) {
                return "revert-to: target state matches current; nothing to do";
            }

            const newHead = await ops.commit({
                fs: ctx.fs,
                diff: { additions, removals },
                authorDid: ctx.agentDid,
            });

            return `revert-to: committed inverse as ${newHead} (+${additions.length} -${removals.length})`;
        },
    };
}

// ---------------------------------------------------------------------------
// tag
// ---------------------------------------------------------------------------

function tagInteraction(ctx: InteractionContext): Interaction {
    return {
        label: "Tag commit",
        name: "tag",
        parameters: [
            { name: "name", type: "string" },
            { name: "sha", type: "string" },
        ],
        async execute(parameters) {
            const params = parameters as { name?: string; sha?: string };
            const name = params.name;
            const sha = params.sha;
            if (!name || typeof name !== "string") {
                return "tag: missing or invalid `name` parameter";
            }
            if (!sha || typeof sha !== "string") {
                return "tag: missing or invalid `sha` parameter";
            }
            await git.tag({
                fs: ctx.fs,
                dir: gitops.REPO_DIR,
                ref: name,
                object: sha,
                force: false,
            });
            return `tag: created '${name}' -> ${sha}`;
        },
    };
}
