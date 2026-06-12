/**
 * Encoding helpers used across the FS adapter, link serialisation,
 * and link-hash computation.
 *
 * The executor's storage layer accepts only UTF-8 strings, so binary
 * Git objects are base64-encoded for storage. Link expressions are
 * stored as raw JSON text (no encoding) in their working-tree files,
 * since JSON is already valid UTF-8.
 */

import type { LinkExpression } from "./types.js";

// ---------------------------------------------------------------------------
// Base64
// ---------------------------------------------------------------------------

/**
 * Encode bytes to a base64 string. Chunked to avoid argument-list
 * limits on `String.fromCharCode.apply` for large buffers.
 */
export function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, Array.from(chunk));
    }
    return btoa(binary);
}

/**
 * Decode a base64 string back to bytes.
 */
export function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

// ---------------------------------------------------------------------------
// UTF-8
// ---------------------------------------------------------------------------

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8");

export function utf8ToBytes(s: string): Uint8Array {
    return TEXT_ENCODER.encode(s);
}

export function bytesToUtf8(bytes: Uint8Array): string {
    return TEXT_DECODER.decode(bytes);
}

// ---------------------------------------------------------------------------
// Link hashing
// ---------------------------------------------------------------------------

/**
 * Canonical hash of a link expression. Same composition the LDK
 * uses internally — covers the link triple plus author and timestamp
 * so two semantically identical adds from different agents at
 * different times yield distinct hashes.
 */
export function hashLink(
    link: LinkExpression,
    hashFn: (data: string) => string,
): string {
    const canonical = JSON.stringify({
        source: link.data.source,
        predicate: link.data.predicate,
        target: link.data.target,
        author: link.author,
        timestamp: link.timestamp,
    });
    return hashFn(canonical);
}

// ---------------------------------------------------------------------------
// Link file paths
// ---------------------------------------------------------------------------

/**
 * Working-tree path under which a single link is serialised.
 * Keeps every link in its own content-addressed file so concurrent
 * adds merge cleanly as a tree-union.
 */
export function linkFilePath(linkHash: string): string {
    return `links/${linkHash}.json`;
}

/**
 * Inverse of {@link linkFilePath}. Returns the hash if the path is
 * a link file, otherwise null.
 */
export function linkHashFromPath(path: string): string | null {
    const match = path.match(/^links\/([^/]+)\.json$/);
    return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Link serialisation
// ---------------------------------------------------------------------------

export function serializeLink(link: LinkExpression): string {
    return JSON.stringify(link);
}

export function deserializeLink(json: string): LinkExpression {
    return JSON.parse(json) as LinkExpression;
}
