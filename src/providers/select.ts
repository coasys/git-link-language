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
import { GitHubProvider, parseGitHubUrl } from "./github.js";
import { RadicleProvider, parseRadicleUrl } from "./radicle.js";
import type { GitProvider } from "./types.js";

export type RemoteKind = "auto" | "github" | "radicle";

export interface SelectProviderOpts {
    url: string;
    kind: string;
    transport: Transport;
    authToken: string;
}

export function selectProvider(opts: SelectProviderOpts): GitProvider | null {
    const { url, transport, authToken } = opts;
    if (!url || url === "<to-be-filled>") return null;
    const kind = (opts.kind || "auto").toLowerCase();

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
