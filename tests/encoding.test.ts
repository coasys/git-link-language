/**
 * Tests for the encoding module: base64 round-trips, UTF-8 helpers,
 * link hashing, and link file path conversion.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    base64ToBytes,
    bytesToBase64,
    bytesToUtf8,
    deserializeLink,
    hashLink,
    linkFilePath,
    linkHashFromPath,
    serializeLink,
    utf8ToBytes,
} from "../src/encoding.js";
import type { LinkExpression } from "../src/types.js";

// ---------------------------------------------------------------------------
// base64
// ---------------------------------------------------------------------------

describe("encoding: base64", () => {
    it("round-trips empty bytes", () => {
        const b = bytesToBase64(new Uint8Array());
        assert.equal(b, "");
        assert.equal(base64ToBytes(b).length, 0);
    });

    it("round-trips ASCII", () => {
        const bytes = new TextEncoder().encode("hello, world");
        const b = bytesToBase64(bytes);
        const back = base64ToBytes(b);
        assert.deepEqual(Array.from(back), Array.from(bytes));
    });

    it("round-trips random binary", () => {
        const bytes = new Uint8Array(256);
        for (let i = 0; i < 256; i++) bytes[i] = i;
        const b = bytesToBase64(bytes);
        const back = base64ToBytes(b);
        assert.deepEqual(Array.from(back), Array.from(bytes));
    });

    it("round-trips large buffer (>64KB)", () => {
        const bytes = new Uint8Array(70_000);
        for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
        const b = bytesToBase64(bytes);
        const back = base64ToBytes(b);
        assert.equal(back.length, bytes.length);
        for (let i = 0; i < 100; i++) assert.equal(back[i], bytes[i]);
        assert.equal(back[bytes.length - 1], bytes[bytes.length - 1]);
    });
});

// ---------------------------------------------------------------------------
// UTF-8
// ---------------------------------------------------------------------------

describe("encoding: utf8", () => {
    it("round-trips ASCII", () => {
        const s = "hello";
        const bytes = utf8ToBytes(s);
        assert.equal(bytesToUtf8(bytes), s);
    });

    it("round-trips multi-byte characters", () => {
        const s = "café — 漢字 — 🦊";
        const bytes = utf8ToBytes(s);
        assert.equal(bytesToUtf8(bytes), s);
    });
});

// ---------------------------------------------------------------------------
// hashLink
// ---------------------------------------------------------------------------

describe("encoding: hashLink", () => {
    const contentHash = (s: string) => {
        let h = 0;
        for (let i = 0; i < s.length; i++) {
            h = ((h << 5) - h + s.charCodeAt(i)) | 0;
        }
        return `H:${(h >>> 0).toString(16)}`;
    };

    function makeLink(overrides?: Partial<LinkExpression>): LinkExpression {
        return {
            author: "did:key:zABC",
            timestamp: "2026-01-01T00:00:00.000Z",
            data: {
                source: "a://x",
                target: "b://y",
                predicate: "p://q",
            },
            proof: { signature: "sig", key: "key" },
            ...overrides,
        };
    }

    it("is deterministic across calls", () => {
        const link = makeLink();
        assert.equal(hashLink(link, contentHash), hashLink(link, contentHash));
    });

    it("includes author in the hash composition", () => {
        const a = makeLink({ author: "did:key:zA" });
        const b = makeLink({ author: "did:key:zB" });
        assert.notEqual(hashLink(a, contentHash), hashLink(b, contentHash));
    });

    it("includes timestamp in the hash composition", () => {
        const a = makeLink({ timestamp: "2025-01-01T00:00:00.000Z" });
        const b = makeLink({ timestamp: "2025-01-02T00:00:00.000Z" });
        assert.notEqual(hashLink(a, contentHash), hashLink(b, contentHash));
    });
});

// ---------------------------------------------------------------------------
// linkFilePath / linkHashFromPath
// ---------------------------------------------------------------------------

describe("encoding: linkFilePath / linkHashFromPath", () => {
    it("round-trips a link hash through the path form", () => {
        const h = "Qmabcdef123";
        assert.equal(linkFilePath(h), `links/${h}.json`);
        assert.equal(linkHashFromPath(`links/${h}.json`), h);
    });

    it("returns null for non-link paths", () => {
        assert.equal(linkHashFromPath(".ad4m/language.json"), null);
        assert.equal(linkHashFromPath("links/sub/dir/file.json"), null);
        assert.equal(linkHashFromPath("links/missing-ext"), null);
    });
});

// ---------------------------------------------------------------------------
// serializeLink / deserializeLink
// ---------------------------------------------------------------------------

describe("encoding: serializeLink / deserializeLink", () => {
    it("round-trips a link expression", () => {
        const link: LinkExpression = {
            author: "did:key:zX",
            timestamp: "2026-06-12T00:00:00.000Z",
            data: { source: "s://1", target: "t://2", predicate: "p://3" },
            proof: { signature: "sig", key: "key" },
        };
        const json = serializeLink(link);
        const back = deserializeLink(json);
        assert.deepEqual(back, link);
    });
});
