/**
 * GitHub REST API client implementing {@link GitProvider}.
 *
 * ## Why JSON REST, not the smart protocol
 *
 * The executor's `httpFetch` UTF-8-decodes response bodies, which would
 * corrupt binary Git pack files, so the smart protocol is unreachable.
 * GitHub's REST plumbing (`/git/{refs,commits,trees,blobs}`) returns
 * everything as JSON with blob content base64-encoded — every byte is
 * valid UTF-8 on the wire, so it round-trips cleanly.
 *
 * ## Read endpoints (all under `https://api.github.com/repos/<owner>/<repo>`)
 *
 *   GET /git/refs/heads/<branch>       — supports If-None-Match → 304
 *   GET /git/commits/<sha>
 *   GET /git/trees/<sha>?recursive=1
 *   GET /git/blobs/<sha>
 *
 * ## Write endpoints (the push path)
 *
 *   POST  /git/blobs      { content, encoding: "utf-8" }        → { sha }
 *   POST  /git/trees      { tree: [{ path, mode, type, sha }] } → { sha }
 *   POST  /git/commits    { message, tree, parents, author, committer } → { sha }
 *   POST  /git/refs       { ref: "refs/heads/<b>", sha }        (create)
 *   PATCH /git/refs/heads/<branch>  { sha, force }              (advance)
 *
 * GitHub recomputes the object SHA from the posted content, so a
 * byte-identical POST returns the same OID the local repo computed. Each
 * write asserts `returnedSha === localOid`. A `422` on the ref PATCH means
 * a non-fast-forward update (the remote moved) — surfaced as
 * `{ ok:false, notFastForward:true }` so the caller pulls + merges + retries.
 *
 * Auth is `Authorization: token <pat>` (works for classic + fine-grained
 * PATs); `Accept: application/vnd.github+json` and
 * `X-GitHub-Api-Version: 2022-11-28` are sent on every request.
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

export type {
    BlobResponse,
    CommitResponse,
    RefResponse,
    TreeEntry,
    TreeResponse,
} from "./types.js";

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

export interface GitHubRepoRef {
    owner: string;
    repo: string;
}

/**
 * Detect a GitHub repo URL and return owner/repo, or null. Accepts
 * `https://github.com/<o>/<r>`, with or without `.git` suffix and
 * trailing slash.
 */
export function parseGitHubUrl(url: string): GitHubRepoRef | null {
    if (!url) return null;
    const match = url.match(
        /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
    );
    if (!match) return null;
    return { owner: match[1], repo: match[2] };
}

/**
 * Extract `owner/repo` from the *path* of any http(s) URL, regardless of
 * host — the last two path segments (`.git` suffix and trailing slash
 * stripped). Used when a GitHub-compatible API base is configured
 * explicitly (`GIT_API_BASE`: GitHub Enterprise, a self-hosted git-data
 * server, or a test rig) so the repo need not live on github.com. Returns
 * null when the path has fewer than two segments.
 */
export function parseRepoPath(url: string): GitHubRepoRef | null {
    if (!url) return null;
    const withoutProto = url.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, "");
    const parts = withoutProto.split("/").filter((s) => s.length > 0);
    if (parts.length < 2) return null;
    const owner = parts[parts.length - 2];
    const repo = parts[parts.length - 1].replace(/\.git$/, "");
    if (!owner || !repo) return null;
    return { owner, repo };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const ACCEPT = "application/vnd.github+json";
const API_VERSION = "2022-11-28";

export class GitHubProvider implements GitProvider {
    public readonly canPush = true;

    private readonly base: string;
    private readonly headers: Record<string, string>;

    constructor(
        private readonly transport: Transport,
        ref: GitHubRepoRef,
        authToken: string,
        apiBase = "https://api.github.com",
    ) {
        // `apiBase` defaults to public GitHub but may be overridden (GitHub
        // Enterprise `https://host/api/v3`, a self-hosted git-data server, or
        // a co-located test rig). The `/repos/<o>/<r>` suffix and every
        // endpoint path below are GitHub-REST-shaped, so any base speaking that
        // dialect works. Trailing slashes are trimmed so the joins stay clean.
        const trimmedBase = apiBase.replace(/\/+$/, "");
        this.base = `${trimmedBase}/repos/${ref.owner}/${ref.repo}`;
        this.headers = {
            "Accept": ACCEPT,
            "X-GitHub-Api-Version": API_VERSION,
            ...(authToken ? { "Authorization": `token ${authToken}` } : {}),
        };
    }

    // -- reads --------------------------------------------------------------

    async fetchRef(branch: string, etag?: string): Promise<RefResponse> {
        const headers = etag
            ? { ...this.headers, "If-None-Match": etag }
            : this.headers;
        const response = await this.transport.fetch(
            `${this.base}/git/refs/heads/${encodeURIComponent(branch)}`,
            "GET",
            headers,
            "",
        );
        if (response.status === 304) {
            return { notModified: true };
        }
        const parsed = parseJson<{ object?: { sha?: string } }>(response.body);
        const sha = parsed?.object?.sha;
        const nextEtag = response.headers["etag"] || response.headers["ETag"];
        if (!sha) {
            throw new Error(
                `GitHub fetchRef: missing sha for branch ${branch} (status ${response.status})`,
            );
        }
        return { notModified: false, sha, etag: nextEtag };
    }

    async fetchCommit(sha: string): Promise<CommitResponse> {
        const response = await this.transport.fetch(
            `${this.base}/git/commits/${sha}`,
            "GET",
            this.headers,
            "",
        );
        const parsed = parseJson<{
            sha?: string;
            tree?: { sha?: string };
            parents?: Array<{ sha?: string }>;
            message?: string;
            author?: { name?: string; email?: string; date?: string };
        }>(response.body);
        if (!parsed?.sha || !parsed?.tree?.sha) {
            throw new Error(`GitHub fetchCommit: malformed response for ${sha}`);
        }
        const timestamp = parsed.author?.date
            ? Math.floor(new Date(parsed.author.date).getTime() / 1000)
            : 0;
        return {
            sha: parsed.sha,
            treeSha: parsed.tree.sha,
            parents: (parsed.parents ?? [])
                .map((p) => p.sha)
                .filter((s): s is string => typeof s === "string"),
            message: parsed.message ?? "",
            author: {
                name: parsed.author?.name ?? "",
                email: parsed.author?.email ?? "",
                timestamp,
            },
        };
    }

    async fetchTreeRecursive(sha: string): Promise<TreeResponse> {
        const response = await this.transport.fetch(
            `${this.base}/git/trees/${sha}?recursive=1`,
            "GET",
            this.headers,
            "",
        );
        const parsed = parseJson<{
            sha?: string;
            truncated?: boolean;
            tree?: Array<{
                path?: string;
                mode?: string;
                type?: string;
                sha?: string;
                size?: number;
            }>;
        }>(response.body);
        if (!parsed?.tree) {
            throw new Error(`GitHub fetchTreeRecursive: missing tree for ${sha}`);
        }
        const entries: TreeEntry[] = parsed.tree
            .filter((e) => e.path && e.sha && e.type)
            .map((e) => ({
                path: e.path as string,
                mode: e.mode ?? "",
                type: e.type as TreeEntry["type"],
                sha: e.sha as string,
                size: e.size,
            }));
        return {
            sha: parsed.sha ?? sha,
            truncated: Boolean(parsed.truncated),
            entries,
        };
    }

    async fetchBlob(sha: string): Promise<BlobResponse> {
        const response = await this.transport.fetch(
            `${this.base}/git/blobs/${sha}`,
            "GET",
            this.headers,
            "",
        );
        const parsed = parseJson<{
            sha?: string;
            content?: string;
            encoding?: string;
        }>(response.body);
        if (!parsed?.content) {
            throw new Error(`GitHub fetchBlob: missing content for ${sha}`);
        }
        // GitHub returns base64 with newlines every 60 chars; strip them.
        const cleaned = parsed.content.replace(/\s/g, "");
        const utf8 = decodeBase64Utf8(cleaned);
        return { sha: parsed.sha ?? sha, content: utf8 };
    }

    // -- writes -------------------------------------------------------------

    async createBlob(utf8: string): Promise<{ sha: string }> {
        const response = await this.transport.fetch(
            `${this.base}/git/blobs`,
            "POST",
            { ...this.headers, "Content-Type": "application/json" },
            JSON.stringify({ content: utf8, encoding: "utf-8" }),
        );
        const parsed = this.parseWrite<{ sha?: string }>(
            response,
            "createBlob",
        );
        if (!parsed.sha) {
            throw new Error("GitHub createBlob: response missing sha");
        }
        return { sha: parsed.sha };
    }

    async createTree(entries: TreeInputEntry[]): Promise<{ sha: string }> {
        const response = await this.transport.fetch(
            `${this.base}/git/trees`,
            "POST",
            { ...this.headers, "Content-Type": "application/json" },
            JSON.stringify({
                tree: entries.map((e) => ({
                    path: e.path,
                    mode: e.mode,
                    type: e.type,
                    sha: e.sha,
                })),
            }),
        );
        const parsed = this.parseWrite<{ sha?: string }>(
            response,
            "createTree",
        );
        if (!parsed.sha) {
            throw new Error("GitHub createTree: response missing sha");
        }
        return { sha: parsed.sha };
    }

    async createCommit(input: CreateCommitInput): Promise<{ sha: string }> {
        // Send `committer` explicitly (defaulting it to the author) so GitHub
        // reconstructs a byte-identical commit object and reproduces the local
        // OID. Omitting it makes GitHub stamp the committer with server time,
        // which changes the SHA and breaks the push invariant.
        const committer = input.committer ?? input.author;
        const response = await this.transport.fetch(
            `${this.base}/git/commits`,
            "POST",
            { ...this.headers, "Content-Type": "application/json" },
            JSON.stringify({
                message: input.message,
                tree: input.tree,
                parents: input.parents,
                author: {
                    name: input.author.name,
                    email: input.author.email,
                    date: input.author.date,
                },
                committer: {
                    name: committer.name,
                    email: committer.email,
                    date: committer.date,
                },
            }),
        );
        const parsed = this.parseWrite<{ sha?: string }>(
            response,
            "createCommit",
        );
        if (!parsed.sha) {
            throw new Error("GitHub createCommit: response missing sha");
        }
        return { sha: parsed.sha };
    }

    async updateRef(
        branch: string,
        sha: string,
        opts?: { force?: boolean },
    ): Promise<UpdateRefResult> {
        const force = opts?.force ?? false;
        const encoded = encodeURIComponent(branch);

        // Fast path: try to advance an existing ref.
        const patch = await this.transport.fetch(
            `${this.base}/git/refs/heads/${encoded}`,
            "PATCH",
            { ...this.headers, "Content-Type": "application/json" },
            JSON.stringify({ sha, force }),
        );
        if (patch.status >= 200 && patch.status < 300) {
            return { ok: true };
        }
        // 422 = the update is not a fast-forward (remote moved). The caller
        // pulls + merges, then retries.
        if (patch.status === 422) {
            return { ok: false, notFastForward: true };
        }
        // Any other 4xx (typically 404) means the ref does not exist yet →
        // create it. GitHub returns 422 (handled above) for a real
        // non-fast-forward on an existing ref, so a create attempt here is
        // safe: if the ref does exist, create answers 422 → notFastForward.
        if (patch.status >= 400 && patch.status < 500) {
            return await this.createRef(encoded, sha);
        }
        throw new Error(
            `GitHub updateRef: unexpected status ${patch.status} for ${branch}: ${truncate(patch.body)}`,
        );
    }

    private async createRef(
        encodedBranch: string,
        sha: string,
    ): Promise<UpdateRefResult> {
        const create = await this.transport.fetch(
            `${this.base}/git/refs`,
            "POST",
            { ...this.headers, "Content-Type": "application/json" },
            JSON.stringify({
                ref: `refs/heads/${decodeURIComponent(encodedBranch)}`,
                sha,
            }),
        );
        if (create.status >= 200 && create.status < 300) {
            return { ok: true };
        }
        // 422 on create with an already-existing ref is effectively a race
        // that the caller resolves by pulling + retrying.
        if (create.status === 422) {
            return { ok: false, notFastForward: true };
        }
        throw new Error(
            `GitHub createRef: unexpected status ${create.status}: ${truncate(create.body)}`,
        );
    }

    private parseWrite<T>(
        response: { status: number; body: string },
        label: string,
    ): T {
        if (response.status < 200 || response.status >= 300) {
            throw new Error(
                `GitHub ${label}: HTTP ${response.status}: ${truncate(response.body)}`,
            );
        }
        const parsed = parseJson<T>(response.body);
        if (!parsed) {
            throw new Error(`GitHub ${label}: unparseable response body`);
        }
        return parsed;
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

function truncate(body: string, max = 200): string {
    if (!body) return "";
    return body.length > max ? `${body.slice(0, max)}…` : body;
}

function decodeBase64Utf8(b64: string): string {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
}
