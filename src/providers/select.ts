/**
 * Provider selection over the `REMOTE_KIND × REMOTE_URL` instance
 * parameters. Pure and transport-injected so it is unit-testable without
 * the Deno-coupled language entrypoint.
 *
 * Selection rules:
 *   - An explicit `kind` of `github` / `radicle` wins outright: the matching
 *     provider's URL parser is applied, and selection returns null if the
 *     URL does not parse for that kind.
 *   - `auto` (the default, and any unrecognised kind) infers the provider
 *     from the URL — a github.com URL → GitHub; a Radicle RID /
 *     radicle-httpd URL / `rad:` reference → Radicle.
 *   - An empty / unfilled URL → null (no remote configured).
 */

import type { Transport } from "../adapters.js";
import { GitHubProvider, parseGitHubUrl, parseRepoPath } from "./github.js";
import { RadicleProvider, parseRadicleUrl } from "./radicle.js";
import type { GitProvider } from "./types.js";

export type RemoteKind = "auto" | "github" | "radicle";

export interface SelectProviderOpts {
    url: string;
    kind: string;
    transport: Transport;
    authToken: string;
    /**
     * Optional GitHub-compatible API base (`GIT_API_BASE`). When set, the
     * GitHub REST provider targets this base instead of public github.com and
     * `owner/repo` is taken from the URL *path* (so the repo need not live on
     * github.com). Enables GitHub Enterprise, a self-hosted git-data server,
     * or a co-located test rig. Ignored when empty.
     */
    apiBase?: string;
}

export function selectProvider(opts: SelectProviderOpts): GitProvider | null {
    const { url, transport, authToken } = opts;
    if (!url || url === "<to-be-filled>") return null;
    const kind = (opts.kind || "auto").toLowerCase();

    // An explicit GitHub-compatible API base overrides host-based detection:
    // the endpoints are GitHub-REST-shaped regardless of where they are served,
    // so `owner/repo` comes from the URL path and all calls target `apiBase`.
    const apiBase = opts.apiBase?.trim();
    if (apiBase) {
        const ref = parseRepoPath(url);
        return ref
            ? new GitHubProvider(transport, ref, authToken, apiBase)
            : null;
    }

    if (kind === "github") {
        const ref = parseGitHubUrl(url);
        return ref ? new GitHubProvider(transport, ref, authToken) : null;
    }
    if (kind === "radicle") {
        const ref = parseRadicleUrl(url);
        return ref ? new RadicleProvider(transport, ref, authToken) : null;
    }

    // auto — probe each known provider's URL parser in turn.
    const ghRef = parseGitHubUrl(url);
    if (ghRef) return new GitHubProvider(transport, ghRef, authToken);
    const radRef = parseRadicleUrl(url);
    if (radRef) return new RadicleProvider(transport, radRef, authToken);
    return null;
}
