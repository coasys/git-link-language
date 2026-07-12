/**
 * Radicle provider implementing the READ half of {@link GitProvider} against
 * `radicle-httpd`'s JSON HTTP API.
 *
 * ## What Radicle is
 *
 * Radicle is a sovereign, peer-to-peer Git forge. Repositories live in a
 * local node's storage and replicate over a gossip network; each repo is
 * identified by a Repository ID (**RID**) of the form
 * `rad:z<base58-multibase>` (e.g. `rad:z4GypKmh1gkEfmkXtarcYnkvtFUfE`).
 * A node can run `radicle-httpd`, which exposes the local storage over a
 * read-oriented JSON API (default port 8080) — this is what a browser app
 * like the Radicle web explorer reads from.
 *
 * ## Verified endpoints (base path `/api/v1`)
 *
 * Confirmed against the `radicle-httpd` route table
 * (`src/api/v1/projects.rs`) and its serialisation (`src/api/json.rs`):
 *
 *   GET /api/v1/projects/<rid>
 *       → { name, description, defaultBranch, head, id, ... }
 *         `head` is the default-branch tip commit SHA. There is no
 *         per-branch ref endpoint; the branch head comes from this doc.
 *
 *   GET /api/v1/projects/<rid>/commits/<sha>
 *       → { commit: { id, author{name,email}, summary, description,
 *                     parents, committer{name,email,time} }, ... }
 *
 *   GET /api/v1/projects/<rid>/tree/<commitSha>/<path>
 *       → { entries: [{ path, oid, name, kind }], lastCommit, name, path }
 *         Trees are addressed by the *commit* SHA + a directory path and
 *         are one level deep (not recursive). `oid` is the real Git object
 *         id of each entry.
 *
 *   GET /api/v1/projects/<rid>/blob/<commitSha>/<path>
 *       → { binary, name, content, path, lastCommit }
 *         `content` is raw UTF-8 for text blobs (base64 only when binary).
 *         Blobs are addressed by commit SHA + path, NOT by blob OID.
 *
 * Because radicle-httpd addresses trees and blobs by *commit + path* rather
 * than by tree/blob OID, this provider threads the commit SHA through the
 * read walk: {@link fetchCommit} returns the commit SHA as its own tree
 * handle, {@link fetchTreeRecursive} lists the `links/` directory at that
 * commit and records each entry's `oid → { commit, path }`, and
 * {@link fetchBlob} resolves a recorded OID back to its commit+path to read
 * the content. The link language stores a flat `links/<hash>.json` tree, so
 * one directory listing per commit is exhaustive.
 *
 * ## Why there is no push (`canPush = false`)
 *
 * `radicle-httpd` exposes **no JSON write API** for Git objects: writing to
 * a Radicle repo goes through the local `rad` node and the Git smart
 * protocol, which (a) the executor's UTF-8-decoding `httpFetch` corrupts
 * and (b) the sandbox cannot reach. (The community `cytechmobile` fork only
 * re-adds issue/patch mutation, not Git object creation.) So this provider
 * is honestly read-only: `canPush = false`, and the four write methods
 * throw a clear, documented error. The language skips auto-push for a
 * Radicle remote and remains a read-convergent replica; publishing new
 * commits to Radicle is done out-of-band via the local `rad` node.
 */

import type { Transport } from "../adapters.js";
import type {
    BlobResponse,
    CommitResponse,
    CreateCommitInput,
    GitProvider,
    RefResponse,
    TreeEntry,
    TreeInputEntry,
    TreeResponse,
    UpdateRefResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// URL / RID parsing
// ---------------------------------------------------------------------------

export interface RadicleRepoRef {
    /** The base `radicle-httpd` origin, e.g. `https://seed.example.com`. */
    baseUrl: string;
    /** The Repository ID, including the `rad:` prefix. */
    rid: string;
}

const RID_BODY = "z[1-9A-HJ-NP-Za-km-z]+"; // base58 multibase, no 0/O/I/l
const RID_RE = new RegExp(`^rad:${RID_BODY}$`);

/**
 * Parse a Radicle remote spec into `{ baseUrl, rid }`, or null if the input
 * is not a recognised Radicle reference. Accepts:
 *
 *   - A bare RID: `rad:z4Gyp…` (defaults `baseUrl` to the public
 *     `https://seed.radicle.garden` httpd gateway).
 *   - A radicle-httpd URL embedding the RID in its path, in either the
 *     app/explorer form (`…/nodes/<host>/rad:z…` — host segment is the
 *     httpd origin) or the API form
 *     (`https://<host>/api/v1/projects/rad:z…`).
 *   - A plain `https://<host>/rad:z…`.
 */
export function parseRadicleUrl(url: string): RadicleRepoRef | null {
    if (!url) return null;
    const trimmed = url.trim();

    // Bare RID.
    if (RID_RE.test(trimmed)) {
        return { baseUrl: "https://seed.radicle.garden", rid: trimmed };
    }

    // A URL that contains an RID somewhere in its path.
    const ridMatch = trimmed.match(new RegExp(`(rad:${RID_BODY})`));
    if (!ridMatch) return null;
    const rid = ridMatch[1];

    let parsed: URL;
    try {
        parsed = new URL(trimmed);
    } catch (_e) {
        return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null;
    }

    // Explorer form: /nodes/<httpd-host>/rad:z… — the node host names the
    // httpd origin the API lives on.
    const nodeMatch = parsed.pathname.match(
        new RegExp(`/nodes/([^/]+)/rad:${RID_BODY}`),
    );
    if (nodeMatch) {
        const host = nodeMatch[1];
        const scheme = host.includes(":") ? "http" : "https";
        return { baseUrl: `${scheme}://${host}`, rid };
    }

    // Otherwise the URL's own origin is the httpd origin.
    return { baseUrl: parsed.origin, rid };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/** Message shared by every write method on this read-only provider. */
export const RADICLE_PUSH_UNSUPPORTED =
    "push to Radicle is out-of-band via the local rad node; " +
    "radicle-httpd exposes no JSON write API";

export class RadicleProvider implements GitProvider {
    public readonly canPush = false;

    private readonly apiBase: string;
    private readonly headers: Record<string, string>;

    // Records where each blob OID was found (commit SHA + path) so a later
    // fetchBlob(oid) can hit radicle-httpd's commit+path-addressed blob
    // endpoint. Populated during fetchTreeRecursive.
    private readonly blobLocation = new Map<
        string,
        { commit: string; path: string }
    >();

    constructor(
        private readonly transport: Transport,
        ref: RadicleRepoRef,
        authToken: string,
    ) {
        const origin = ref.baseUrl.replace(/\/+$/, "");
        this.apiBase = `${origin}/api/v1/projects/${encodeURIComponent(ref.rid)}`;
        this.headers = {
            "Accept": "application/json",
            ...(authToken ? { "Authorization": `Bearer ${authToken}` } : {}),
        };
    }

    // -- reads --------------------------------------------------------------

    /**
     * The default-branch tip. radicle-httpd has no conditional-ref
     * endpoint, so ETag negotiation is not available; we read the project
     * doc and return its `head`. When a non-default `branch` is requested
     * we surface `head` too (radicle-httpd's project doc only exposes the
     * default branch head; per-branch tips would require the `/remotes`
     * endpoint, which keys by peer, not by a shared branch name).
     */
    async fetchRef(_branch: string, _etag?: string): Promise<RefResponse> {
        const response = await this.transport.fetch(
            this.apiBase,
            "GET",
            this.headers,
            "",
        );
        if (response.status < 200 || response.status >= 300) {
            throw new Error(
                `Radicle fetchRef: HTTP ${response.status} for ${this.apiBase}`,
            );
        }
        const parsed = parseJson<{ head?: string; defaultBranch?: string }>(
            response.body,
        );
        const sha = parsed?.head;
        if (!sha) {
            throw new Error(
                "Radicle fetchRef: project doc missing `head`",
            );
        }
        return { notModified: false, sha };
    }

    async fetchCommit(sha: string): Promise<CommitResponse> {
        const response = await this.transport.fetch(
            `${this.apiBase}/commits/${encodeURIComponent(sha)}`,
            "GET",
            this.headers,
            "",
        );
        if (response.status < 200 || response.status >= 300) {
            throw new Error(
                `Radicle fetchCommit: HTTP ${response.status} for ${sha}`,
            );
        }
        const parsed = parseJson<{
            commit?: {
                id?: string;
                summary?: string;
                description?: string;
                parents?: string[];
                author?: { name?: string; email?: string };
                committer?: { name?: string; email?: string; time?: number };
            };
        }>(response.body);
        const c = parsed?.commit;
        if (!c?.id) {
            throw new Error(`Radicle fetchCommit: malformed response for ${sha}`);
        }
        const summary = c.summary ?? "";
        const description = c.description ?? "";
        const message = description ? `${summary}\n\n${description}` : summary;
        return {
            sha: c.id,
            // radicle-httpd addresses trees/blobs by commit SHA + path, so
            // the commit SHA is itself the handle we pass to
            // fetchTreeRecursive.
            treeSha: c.id,
            parents: (c.parents ?? []).filter(
                (p): p is string => typeof p === "string",
            ),
            message,
            author: {
                name: c.committer?.name ?? c.author?.name ?? "",
                email: c.committer?.email ?? c.author?.email ?? "",
                timestamp: typeof c.committer?.time === "number"
                    ? c.committer.time
                    : 0,
            },
        };
    }

    /**
     * List the `links/` directory at a commit and expose it as a flat
     * TreeResponse. `treeHandle` is the commit SHA (see {@link fetchCommit}).
     * Records each entry's `oid → { commit, path }` so {@link fetchBlob} can
     * resolve the content.
     */
    async fetchTreeRecursive(treeHandle: string): Promise<TreeResponse> {
        const commit = treeHandle;
        const response = await this.transport.fetch(
            `${this.apiBase}/tree/${encodeURIComponent(commit)}/links`,
            "GET",
            this.headers,
            "",
        );
        // A commit whose tree has no `links/` directory (empty link-set)
        // yields a 404; treat that as an empty tree rather than an error.
        if (response.status === 404) {
            return { sha: commit, truncated: false, entries: [] };
        }
        if (response.status < 200 || response.status >= 300) {
            throw new Error(
                `Radicle fetchTreeRecursive: HTTP ${response.status} for ${commit}`,
            );
        }
        const parsed = parseJson<{
            entries?: Array<{
                path?: string;
                oid?: string;
                name?: string;
                kind?: string;
            }>;
        }>(response.body);
        const entries: TreeEntry[] = [];
        for (const e of parsed?.entries ?? []) {
            if (!e.oid || !e.name) continue;
            if (e.kind && e.kind !== "blob") continue;
            const path = `links/${e.name}`;
            this.blobLocation.set(e.oid, { commit, path });
            entries.push({
                path,
                mode: "100644",
                type: "blob",
                sha: e.oid,
            });
        }
        return { sha: commit, truncated: false, entries };
    }

    async fetchBlob(oid: string): Promise<BlobResponse> {
        const loc = this.blobLocation.get(oid);
        if (!loc) {
            throw new Error(
                `Radicle fetchBlob: no recorded location for oid ${oid} ` +
                    "(fetchTreeRecursive must run first)",
            );
        }
        const response = await this.transport.fetch(
            `${this.apiBase}/blob/${encodeURIComponent(loc.commit)}/${loc.path}`,
            "GET",
            this.headers,
            "",
        );
        if (response.status < 200 || response.status >= 300) {
            throw new Error(
                `Radicle fetchBlob: HTTP ${response.status} for ${loc.path}`,
            );
        }
        const parsed = parseJson<{ content?: string; binary?: boolean }>(
            response.body,
        );
        if (parsed?.content === undefined) {
            throw new Error(`Radicle fetchBlob: missing content for ${loc.path}`);
        }
        // Link blobs are JSON text, so content is raw UTF-8. (radicle-httpd
        // base64-encodes only binary blobs, which link files never are.)
        return { sha: oid, content: parsed.content };
    }

    // -- writes (unsupported) ----------------------------------------------

    createBlob(_utf8: string): Promise<{ sha: string }> {
        return Promise.reject(new Error(RADICLE_PUSH_UNSUPPORTED));
    }

    createTree(_entries: TreeInputEntry[]): Promise<{ sha: string }> {
        return Promise.reject(new Error(RADICLE_PUSH_UNSUPPORTED));
    }

    createCommit(_input: CreateCommitInput): Promise<{ sha: string }> {
        return Promise.reject(new Error(RADICLE_PUSH_UNSUPPORTED));
    }

    updateRef(
        _branch: string,
        _sha: string,
        _opts?: { force?: boolean },
    ): Promise<UpdateRefResult> {
        return Promise.reject(new Error(RADICLE_PUSH_UNSUPPORTED));
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJson<T>(body: string): T | null {
    if (!body) return null;
    try {
        return JSON.parse(body) as T;
    } catch (_e) {
        return null;
    }
}
