/**
 * Local type definitions for the Git Link Language.
 *
 * Mirrors the subset of @coasys/ad4m-ldk types used here, plus
 * Git-specific record shapes for the custom query kinds.
 */

export type DID = string;
export type Address = string;
export type SHA = string;

export interface ExpressionProof {
    signature: string;
    key: string;
    valid?: boolean;
    invalid?: boolean;
}

export interface Expression<T = unknown> {
    author: DID;
    timestamp: string;
    data: T;
    proof: ExpressionProof;
}

export interface Link {
    source: string;
    target: string;
    predicate?: string;
}

export interface LinkExpression extends Expression<Link> {
    status?: string;
}

export interface PerspectiveDiff {
    additions: LinkExpression[];
    removals: LinkExpression[];
}

export interface Perspective {
    links: LinkExpression[];
}

// ---------------------------------------------------------------------------
// Custom query records
// ---------------------------------------------------------------------------

/**
 * A single Git commit, decorated with the link additions/removals it
 * introduced. Produced by the `git-history` query.
 */
export interface CommitRecord {
    sha: SHA;
    author: DID;
    timestamp: string;
    message: string;
    additions: string[];
    removals: string[];
    parents: SHA[];
}

/**
 * Provenance of a single link: which commit introduced it and (if
 * the link is no longer present) which commit removed it. Produced
 * by the `git-blame` query.
 */
export interface BlameRecord {
    introducedBy: SHA;
    author: DID;
    timestamp: string;
    removedBy?: SHA;
}
