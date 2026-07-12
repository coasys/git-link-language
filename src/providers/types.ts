/**
 * The provider abstraction the remote-convergence engine talks to.
 *
 * A provider adapts one Git forge's JSON HTTP API to the small object-store
 * surface the link language needs. It has two halves:
 *
 *   - **Reads** (`fetchRef`, `fetchCommit`, `fetchTreeRecursive`,
 *     `fetchBlob`) — walked by the pull path in `src/remote-sync.ts` to
 *     mirror remote commits into the local object store.
 *   - **Writes** (`createBlob`, `createTree`, `createCommit`, `updateRef`)
 *     — used by the push path to POST byte-identical objects and move the
 *     remote ref.
 *
 * ## Why push works over a JSON object API
 *
 * Git object hashing is deterministic over content: the OID of a blob /
 * tree / commit is a hash of its canonical serialisation. If a provider's
 * object API stores byte-identical content, it returns the *same* SHA the
 * local repo computed. So a local commit's parent OIDs are valid remote
 * parent SHAs, and push is the mirror image of pull: walk local commits
 * from HEAD back to the boundary the remote already has, POST each missing
 * commit's blobs → tree → commit bottom-up (parents first), then move the
 * ref. Every provider write asserts `returnedSha === localOid`; a mismatch
 * means the remote canonicalised differently and is a hard error, not a
 * silent divergence.
 *
 * ## `canPush`
 *
 * Not every forge exposes a JSON *write* API. GitHub does
 * (`POST /git/{blobs,trees,commits,refs}`). Radicle does **not** —
 * `radicle-httpd` is read-oriented and writes go through the local `rad`
 * node over the smart protocol, which the executor's UTF-8-decoding
 * `httpFetch` corrupts and the sandbox cannot reach. Such a provider sets
 * `canPush=false` and its write methods throw a clear, documented error;
 * the language simply skips auto-push and remains a read-convergent
 * replica (push happens out-of-band via the local node). This is an honest
 * capability boundary, not a stub.
 */

// ---------------------------------------------------------------------------
// Read response shapes
// ---------------------------------------------------------------------------

export interface RefResponse {
    /** True when the server answered 304 Not Modified to a conditional GET. */
    notModified: boolean;
    /** The branch head commit SHA (absent on 304). */
    sha?: string;
    /** An opaque validator to replay as `If-None-Match` on the next poll. */
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
// Write request/response shapes
// ---------------------------------------------------------------------------

/** A single entry in a tree POST — mirrors GitHub's `tree[]` element. */
export interface TreeInputEntry {
    path: string;
    mode: string;
    type: "blob" | "tree" | "commit";
    sha: string;
}

export interface CommitIdentity {
    name: string;
    email: string;
    /** ISO-8601 date string, e.g. `2026-06-12T00:00:00Z`. */
    date: string;
}

export interface CreateCommitInput {
    tree: string;
    parents: string[];
    message: string;
    author: CommitIdentity;
    /**
     * The committer identity. Sent explicitly (rather than letting the forge
     * default it to the author with server time) so the reconstructed commit
     * object is byte-identical to the local one and reproduces its OID. When
     * omitted, the forge's default applies — but then SHA-equality is not
     * guaranteed, so the push path always supplies it.
     */
    committer?: CommitIdentity;
}

export interface UpdateRefResult {
    ok: boolean;
    /**
     * Set when the update was rejected because it was not a fast-forward
     * (the remote advanced under us). The caller pulls + merges, then
     * retries the push.
     */
    notFastForward?: boolean;
}

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface GitProvider {
    // --- reads -------------------------------------------------------------
    fetchRef(branch: string, etag?: string): Promise<RefResponse>;
    fetchCommit(sha: string): Promise<CommitResponse>;
    fetchTreeRecursive(sha: string): Promise<TreeResponse>;
    fetchBlob(sha: string): Promise<BlobResponse>;

    // --- writes ------------------------------------------------------------
    /**
     * Whether this provider supports pushing over its JSON API. When
     * false, the four write methods below throw and the language skips
     * auto-push.
     */
    readonly canPush: boolean;

    /** POST a blob's UTF-8 content; returns the object SHA. */
    createBlob(utf8: string): Promise<{ sha: string }>;

    /** POST a tree from explicit entries; returns the tree SHA. */
    createTree(entries: TreeInputEntry[]): Promise<{ sha: string }>;

    /** POST a commit; returns the commit SHA. */
    createCommit(input: CreateCommitInput): Promise<{ sha: string }>;

    /**
     * Move `branch` to `sha`, creating the ref if it does not exist.
     * A non-fast-forward rejection resolves to `{ ok:false,
     * notFastForward:true }` rather than throwing, so the caller can
     * pull + merge + retry. `force` overrides the fast-forward check.
     */
    updateRef(
        branch: string,
        sha: string,
        opts?: { force?: boolean },
    ): Promise<UpdateRefResult>;
}
