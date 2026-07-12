/**
 * Local link cache.
 *
 * The Git working tree is the source of truth for link expressions;
 * the cache mirrors the current `links/` tree in storage so that
 * `render()` and link-pattern queries do not have to traverse the
 * Git index on every call.
 *
 * Keys live under `cache/` so they do not collide with the
 * fs-adapter (which uses `/repo/...`) or other Language state.
 *
 *   cache/links/{link-hash}             → serialised LinkExpression
 *   cache/by-source/{source}/{hash}     → link-hash
 *   cache/by-target/{target}/{hash}     → link-hash
 *   cache/by-pred/{predicate}/{hash}    → link-hash
 *   cache/revision                      → last synced HEAD SHA
 */

import { getStorage } from "./adapters.js";
import type { LinkExpression, Perspective, PerspectiveDiff } from "./types.js";
import { hashLink as computeHashLink } from "./encoding.js";

let _hashFn: ((data: string) => string) | null = null;

export function initStore(hashFn?: (data: string) => string): void {
    _hashFn = hashFn ?? null;
}

function getHashFn(): (data: string) => string {
    if (!_hashFn) {
        throw new Error(
            "Store not initialized with a hash function. Call initStore(hashFn) during language init().",
        );
    }
    return _hashFn;
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

const CACHE_LINK_PREFIX = "cache/links/";
const CACHE_SOURCE_PREFIX = "cache/by-source/";
const CACHE_TARGET_PREFIX = "cache/by-target/";
const CACHE_PRED_PREFIX = "cache/by-pred/";
const REVISION_KEY = "cache/revision";

function linkKey(linkHash: string): string {
    return `${CACHE_LINK_PREFIX}${linkHash}`;
}
function sourceIndexKey(source: string, h: string): string {
    return `${CACHE_SOURCE_PREFIX}${source}/${h}`;
}
function targetIndexKey(target: string, h: string): string {
    return `${CACHE_TARGET_PREFIX}${target}/${h}`;
}
function predIndexKey(predicate: string, h: string): string {
    return `${CACHE_PRED_PREFIX}${predicate}/${h}`;
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

export function hashLink(link: LinkExpression): string {
    return computeHashLink(link, getHashFn());
}

// ---------------------------------------------------------------------------
// Cache mutation
// ---------------------------------------------------------------------------

export function putLink(link: LinkExpression): string {
    const h = hashLink(link);
    putLinkWithHash(link, h);
    return h;
}

export function putLinkWithHash(link: LinkExpression, h: string): void {
    const storage = getStorage();
    storage.put(linkKey(h), JSON.stringify(link));
    const source = link.data.source || "";
    const target = link.data.target || "";
    const predicate = link.data.predicate || "";
    if (source) storage.put(sourceIndexKey(source, h), h);
    if (target) storage.put(targetIndexKey(target, h), h);
    if (predicate) storage.put(predIndexKey(predicate, h), h);
}

export function removeLink(link: LinkExpression): void {
    removeLinkByHash(hashLink(link));
}

export function removeLinkByHash(h: string): void {
    const storage = getStorage();
    const raw = storage.get(linkKey(h));
    if (raw === null) {
        // Nothing to do — keep idempotent
        return;
    }
    const link = JSON.parse(raw) as LinkExpression;
    storage.delete(linkKey(h));
    const source = link.data.source || "";
    const target = link.data.target || "";
    const predicate = link.data.predicate || "";
    if (source) storage.delete(sourceIndexKey(source, h));
    if (target) storage.delete(targetIndexKey(target, h));
    if (predicate) storage.delete(predIndexKey(predicate, h));
}

export function getLink(linkHash: string): LinkExpression | null {
    const raw = getStorage().get(linkKey(linkHash));
    if (!raw) return null;
    return JSON.parse(raw) as LinkExpression;
}

export function applyDiff(diff: PerspectiveDiff): void {
    for (const addition of diff.additions) {
        putLink(addition);
    }
    for (const removal of diff.removals) {
        removeLink(removal);
    }
}

export function clearCache(): void {
    const storage = getStorage();
    const allKeys = [
        ...storage.listKeys(CACHE_LINK_PREFIX),
        ...storage.listKeys(CACHE_SOURCE_PREFIX),
        ...storage.listKeys(CACHE_TARGET_PREFIX),
        ...storage.listKeys(CACHE_PRED_PREFIX),
    ];
    for (const k of allKeys) storage.delete(k);
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface LinkQuery {
    source?: string;
    target?: string;
    predicate?: string;
}

export function queryLinks(query: LinkQuery): LinkExpression[] {
    const { source, target, predicate } = query;
    const storage = getStorage();

    let candidateHashes: string[];
    if (source) {
        const keys = storage.listKeys(`${CACHE_SOURCE_PREFIX}${source}/`);
        candidateHashes = keys
            .map((k: string) => storage.get(k) || "")
            .filter(Boolean);
    } else if (target) {
        const keys = storage.listKeys(`${CACHE_TARGET_PREFIX}${target}/`);
        candidateHashes = keys
            .map((k: string) => storage.get(k) || "")
            .filter(Boolean);
    } else if (predicate) {
        const keys = storage.listKeys(`${CACHE_PRED_PREFIX}${predicate}/`);
        candidateHashes = keys
            .map((k: string) => storage.get(k) || "")
            .filter(Boolean);
    } else {
        const keys = storage.listKeys(CACHE_LINK_PREFIX);
        candidateHashes = keys.map((k: string) => k.slice(CACHE_LINK_PREFIX.length));
    }

    const results: LinkExpression[] = [];
    const seen = new Set<string>();
    for (const h of candidateHashes) {
        if (seen.has(h)) continue;
        seen.add(h);
        const link = getLink(h);
        if (!link) continue;
        if (source && link.data.source !== source) continue;
        if (target && link.data.target !== target) continue;
        if (predicate && link.data.predicate !== predicate) continue;
        results.push(link);
    }
    return results;
}

export function allLinks(): Perspective {
    const storage = getStorage();
    const keys = storage.listKeys(CACHE_LINK_PREFIX);
    const links: LinkExpression[] = [];
    for (const key of keys) {
        const raw = storage.get(key);
        if (raw) links.push(JSON.parse(raw) as LinkExpression);
    }
    return { links };
}

// ---------------------------------------------------------------------------
// Raw cache access (used by the remote-sync module for tracking the
// last-known remote SHA and the ETag for conditional ref polls)
// ---------------------------------------------------------------------------

export function getStorageRaw(key: string): string | null {
    return getStorage().get(key);
}

export function setStorageRaw(key: string, value: string): void {
    getStorage().put(key, value);
}

export function listStorageKeys(prefix: string): string[] {
    return getStorage().listKeys(prefix);
}

// ---------------------------------------------------------------------------
// Revision tracking
// ---------------------------------------------------------------------------

export function getRevision(): string | null {
    return getStorage().get(REVISION_KEY);
}

export function setRevision(rev: string): void {
    getStorage().put(REVISION_KEY, rev);
}
