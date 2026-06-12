/**
 * GitHub REST API client for the read-only sync path.
 *
 * Why: the executor's `httpFetch` UTF-8-decodes response bodies, which
 * corrupts Git smart-protocol pack files. GitHub's REST plumbing
 * (`/git/refs`, `/git/commits`, `/git/trees`, `/git/blobs`) returns
 * everything as JSON with blob content base64-encoded — every byte is
 * valid UTF-8 on the wire, so it round-trips cleanly.
 *
 * Endpoints used (all under `https://api.github.com/repos/<owner>/<repo>`):
 *
 *   GET /git/refs/heads/<branch>       — supports If-None-Match → 304
 *   GET /git/commits/<sha>
 *   GET /git/trees/<sha>?recursive=1
 *   GET /git/blobs/<sha>
 *
 * Auth is `Authorization: token <pat>` (works for classic + fine-grained
 * PATs); `Accept: application/vnd.github+json` and
 * `X-GitHub-Api-Version: 2022-11-28` are sent on every request.
 */

import type { Transport } from "../adapters.js";

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

// ---------------------------------------------------------------------------
// Response shapes (only the fields we read)
// ---------------------------------------------------------------------------

export interface RefResponse {
    notModified: boolean;
    sha?: string;
    etag?: string;
}

export interface CommitResponse {
    sha: string;
    treeSha: string;
    parents: string[];
    message: string;
    author: {
        name: string;
        email: string;
        timestamp: number; // seconds since epoch
    };
}

export interface TreeEntry {
    path: string;
    mode: string;
    type: "blob" | "tree" | "commit";
    sha: string;
    size?: number;
}

export interface TreeResponse {
    sha: string;
    truncated: boolean;
    entries: TreeEntry[];
}

export interface BlobResponse {
    sha: string;
    content: string; // UTF-8 decoded
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const ACCEPT = "application/vnd.github+json";
const API_VERSION = "2022-11-28";

export class GitHubProvider {
    private readonly base: string;
    private readonly headers: Record<string, string>;

    constructor(
        private readonly transport: Transport,
        ref: GitHubRepoRef,
        authToken: string,
    ) {
        this.base = `https://api.github.com/repos/${ref.owner}/${ref.repo}`;
        this.headers = {
            "Accept": ACCEPT,
            "X-GitHub-Api-Version": API_VERSION,
            ...(authToken ? { "Authorization": `token ${authToken}` } : {}),
        };
    }

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

function decodeBase64Utf8(b64: string): string {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
}
