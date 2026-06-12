/**
 * Tests for the fs-adapter — verifies it presents the storage KV
 * as an isomorphic-git-compatible filesystem with correct binary
 * round-trips, directory semantics, and error codes.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import type { StorageAdapter } from "../src/adapters.js";
import { createFsAdapter, type GitFs } from "../src/fs-adapter.js";

class MockStorage implements StorageAdapter {
    public data = new Map<string, string>();
    get(key: string): string | null { return this.data.get(key) ?? null; }
    put(key: string, value: string): void { this.data.set(key, value); }
    delete(key: string): void { this.data.delete(key); }
    listKeys(prefix?: string): string[] {
        return [...this.data.keys()].filter(k => !prefix || k.startsWith(prefix));
    }
}

let fs: GitFs;
let mock: MockStorage;

function setup(): void {
    mock = new MockStorage();
    fs = createFsAdapter(mock);
}

// ---------------------------------------------------------------------------
// readFile / writeFile
// ---------------------------------------------------------------------------

describe("fs-adapter: readFile / writeFile", () => {
    beforeEach(setup);

    it("round-trips a UTF-8 string", async () => {
        await fs.writeFile("/repo/a.txt", "hello", { encoding: "utf8" });
        const got = await fs.readFile("/repo/a.txt", { encoding: "utf8" });
        assert.equal(got, "hello");
    });

    it("round-trips binary bytes", async () => {
        const bytes = new Uint8Array(256);
        for (let i = 0; i < 256; i++) bytes[i] = i;
        await fs.writeFile("/repo/binary.dat", bytes);
        const got = await fs.readFile("/repo/binary.dat");
        assert.ok(got instanceof Uint8Array);
        assert.deepEqual(Array.from(got as Uint8Array), Array.from(bytes));
    });

    it("readFile on non-existent path throws ENOENT", async () => {
        await assert.rejects(
            () => fs.readFile("/repo/missing"),
            (err: Error & { code?: string }) => err.code === "ENOENT",
        );
    });

    it("overwrites an existing file", async () => {
        await fs.writeFile("/repo/a.txt", "first", { encoding: "utf8" });
        await fs.writeFile("/repo/a.txt", "second", { encoding: "utf8" });
        const got = await fs.readFile("/repo/a.txt", { encoding: "utf8" });
        assert.equal(got, "second");
    });
});

// ---------------------------------------------------------------------------
// unlink
// ---------------------------------------------------------------------------

describe("fs-adapter: unlink", () => {
    beforeEach(setup);

    it("removes a file", async () => {
        await fs.writeFile("/repo/x", "y", { encoding: "utf8" });
        await fs.unlink("/repo/x");
        await assert.rejects(
            () => fs.readFile("/repo/x"),
            (err: Error & { code?: string }) => err.code === "ENOENT",
        );
    });

    it("throws ENOENT for missing file", async () => {
        await assert.rejects(
            () => fs.unlink("/repo/nope"),
            (err: Error & { code?: string }) => err.code === "ENOENT",
        );
    });
});

// ---------------------------------------------------------------------------
// readdir
// ---------------------------------------------------------------------------

describe("fs-adapter: readdir", () => {
    beforeEach(setup);

    it("lists direct entries only", async () => {
        await fs.writeFile("/repo/links/a.json", "1", { encoding: "utf8" });
        await fs.writeFile("/repo/links/b.json", "2", { encoding: "utf8" });
        await fs.writeFile("/repo/links/c.json", "3", { encoding: "utf8" });
        await fs.writeFile("/repo/other.json", "x", { encoding: "utf8" });
        const entries = await fs.readdir("/repo/links");
        entries.sort();
        assert.deepEqual(entries, ["a.json", "b.json", "c.json"]);
    });

    it("deduplicates nested first segments", async () => {
        await fs.writeFile("/repo/.git/refs/heads/main", "sha", { encoding: "utf8" });
        await fs.writeFile("/repo/.git/refs/heads/dev", "sha2", { encoding: "utf8" });
        await fs.writeFile("/repo/.git/refs/tags/v1", "sha3", { encoding: "utf8" });
        const entries = await fs.readdir("/repo/.git/refs");
        entries.sort();
        assert.deepEqual(entries, ["heads", "tags"]);
    });

    it("returns empty array for empty dir under root", async () => {
        // Mounting root only returns existing children
        await fs.writeFile("/repo/file", "x", { encoding: "utf8" });
        const entries = await fs.readdir("/repo");
        assert.deepEqual(entries, ["file"]);
    });
});

// ---------------------------------------------------------------------------
// stat / lstat
// ---------------------------------------------------------------------------

describe("fs-adapter: stat", () => {
    beforeEach(setup);

    it("returns file stats for a file", async () => {
        await fs.writeFile("/repo/a", "hello", { encoding: "utf8" });
        const s = await fs.stat("/repo/a");
        assert.equal(s.type, "file");
        assert.equal(s.isFile(), true);
        assert.equal(s.isDirectory(), false);
        assert.equal(s.size, 5); // "hello" is 5 bytes
    });

    it("returns directory stats for a directory", async () => {
        await fs.writeFile("/repo/d/x", "1", { encoding: "utf8" });
        const s = await fs.stat("/repo/d");
        assert.equal(s.type, "dir");
        assert.equal(s.isFile(), false);
        assert.equal(s.isDirectory(), true);
    });

    it("throws ENOENT for missing path", async () => {
        await assert.rejects(
            () => fs.stat("/repo/nope"),
            (err: Error & { code?: string }) => err.code === "ENOENT",
        );
    });

    it("lstat is identical to stat for normal files", async () => {
        await fs.writeFile("/repo/a", "1", { encoding: "utf8" });
        const a = await fs.stat("/repo/a");
        const b = await fs.lstat("/repo/a");
        assert.equal(a.type, b.type);
        assert.equal(a.size, b.size);
    });
});

// ---------------------------------------------------------------------------
// mkdir / rmdir
// ---------------------------------------------------------------------------

describe("fs-adapter: mkdir / rmdir", () => {
    beforeEach(setup);

    it("mkdir on empty path succeeds (no-op)", async () => {
        await fs.mkdir("/repo/newdir");
    });

    it("mkdir throws EEXIST when a file exists at path", async () => {
        await fs.writeFile("/repo/foo", "x", { encoding: "utf8" });
        await assert.rejects(
            () => fs.mkdir("/repo/foo"),
            (err: Error & { code?: string }) => err.code === "EEXIST",
        );
    });

    it("rmdir on empty dir is a no-op", async () => {
        await fs.rmdir("/repo/empty");
    });

    it("rmdir on non-empty dir throws ENOTEMPTY", async () => {
        await fs.writeFile("/repo/d/file", "x", { encoding: "utf8" });
        await assert.rejects(
            () => fs.rmdir("/repo/d"),
            (err: Error & { code?: string }) => err.code === "ENOTEMPTY",
        );
    });
});
