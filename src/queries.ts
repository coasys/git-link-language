/**
 * Query handlers for the `perspective-query` capability.
 *
 * Four query kinds are supported:
 *
 *   link-pattern    — Filter the link set by source/target/predicate (standard).
 *   git-history     — Walk the commit DAG; return CommitRecords with
 *                     link-hash additions/removals.
 *   git-state-at    — Render the Perspective as it existed at a given SHA.
 *   git-blame       — Locate the commit that introduced a given link hash
 *                     (and the commit that removed it, if absent now).
 */

import type {
    BlameRecord,
    CommitRecord,
    LinkExpression,
    Perspective,
    SHA,
} from "./types.js";
import * as gitops from "./git.js";
import type { GitFs } from "./fs-adapter.js";
import * as store from "./store.js";
import type { LinkQuery } from "./store.js";
import { deserializeLink } from "./encoding.js";

// ---------------------------------------------------------------------------
// Supported query kinds
// ---------------------------------------------------------------------------

export const QUERY_KINDS = [
    "link-pattern",
    "git-history",
    "git-state-at",
    "git-blame",
] as const;

export type QueryKind = typeof QUERY_KINDS[number];

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

export interface QueryRequest {
    kind: string;
    payload: unknown;
}

export interface QueryResponse {
    kind: string;
    payload: unknown;
}

export interface GitHistoryPayload {
    from?: SHA;
    to?: SHA;
    limit?: number;
}

export interface GitStateAtPayload {
    sha: SHA;
}

export interface GitBlamePayload {
    linkHash: string;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runQuery(
    req: QueryRequest,
    fs: GitFs,
): Promise<QueryResponse> {
    switch (req.kind) {
        case "link-pattern":
            return linkPattern(req.payload as LinkQuery | null | undefined);
        case "git-history":
            return await gitHistory(req.payload as GitHistoryPayload | null, fs);
        case "git-state-at":
            return await gitStateAt(req.payload as GitStateAtPayload, fs);
        case "git-blame":
            return await gitBlame(req.payload as GitBlamePayload, fs);
        default:
            return {
                kind: "error",
                payload: `Unsupported query kind: ${req.kind}`,
            };
    }
}

// ---------------------------------------------------------------------------
// link-pattern
// ---------------------------------------------------------------------------

function linkPattern(payload: LinkQuery | null | undefined): QueryResponse {
    const query = payload ?? {};
    const links = store.queryLinks(query);
    return { kind: "links", payload: links };
}

// ---------------------------------------------------------------------------
// git-history
// ---------------------------------------------------------------------------

async function gitHistory(
    payload: GitHistoryPayload | null,
    fs: GitFs,
): Promise<QueryResponse> {
    const opts = payload ?? {};
    const head = opts.from ?? (await gitops.currentHead(fs));
    if (head === null) {
        return { kind: "history", payload: [] };
    }
    const limit = opts.limit ?? 100;
    const rawEntries = await gitops.rawLog(fs, head, limit);

    let stopAt: SHA | undefined = opts.to;
    const records: CommitRecord[] = [];
    for (const entry of rawEntries) {
        records.push(await gitops.decorateCommit(fs, entry));
        if (stopAt && entry.oid === stopAt) break;
    }
    return { kind: "history", payload: records };
}

// ---------------------------------------------------------------------------
// git-state-at
// ---------------------------------------------------------------------------

async function gitStateAt(
    payload: GitStateAtPayload,
    fs: GitFs,
): Promise<QueryResponse> {
    if (!payload || !payload.sha) {
        return { kind: "error", payload: "git-state-at requires a `sha` field" };
    }
    const hashes = await gitops.listLinkHashesAt(fs, payload.sha);
    const links: LinkExpression[] = [];
    for (const h of hashes) {
        const raw = await gitops.readLinkAt(fs, payload.sha, h);
        if (!raw) continue;
        try {
            links.push(deserializeLink(raw));
        } catch (_err) {
            // Skip malformed link files rather than failing the whole render
        }
    }
    const perspective: Perspective = { links };
    return { kind: "perspective", payload: perspective };
}

// ---------------------------------------------------------------------------
// git-blame
// ---------------------------------------------------------------------------

async function gitBlame(
    payload: GitBlamePayload,
    fs: GitFs,
): Promise<QueryResponse> {
    if (!payload || !payload.linkHash) {
        return { kind: "error", payload: "git-blame requires a `linkHash` field" };
    }
    const head = await gitops.currentHead(fs);
    if (head === null) {
        return { kind: "error", payload: "blame: no HEAD yet" };
    }
    const rawEntries = await gitops.rawLog(fs, head);
    // Walk newest → oldest. For each commit, compare presence of linkHash
    // between this commit's tree and its first parent's tree.
    let removedBy: SHA | undefined;
    for (const entry of rawEntries) {
        const present = await gitops.listLinkHashesAt(fs, entry.oid);
        const inThis = present.has(payload.linkHash);
        const parents = entry.commit.parent;
        if (parents.length === 0) {
            if (inThis) {
                // Root commit introduced the link
                return makeBlameResponse(entry, removedBy);
            }
            // Never appeared at all
            return { kind: "blame", payload: null };
        }
        const inParent = (await gitops.listLinkHashesAt(fs, parents[0])).has(
            payload.linkHash,
        );
        if (inThis && !inParent) {
            return makeBlameResponse(entry, removedBy);
        }
        if (!inThis && inParent && removedBy === undefined) {
            // First commit (newest) where it was absent while parent had it
            removedBy = entry.oid;
        }
    }
    return { kind: "blame", payload: null };
}

function makeBlameResponse(
    entry: gitops.RawCommitEntry,
    removedBy: SHA | undefined,
): QueryResponse {
    const tsIso = new Date(entry.commit.author.timestamp * 1000).toISOString();
    const record: BlameRecord = {
        introducedBy: entry.oid,
        author: entry.commit.author.name,
        timestamp: tsIso,
        removedBy,
    };
    return { kind: "blame", payload: record };
}
