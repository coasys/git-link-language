/**
 * Filesystem adapter for isomorphic-git, backed by the executor's
 * storage KV (`storageGet`/`storagePut`/`storageDelete`/`storageListKeys`).
 *
 * isomorphic-git treats this object as its filesystem: every Git
 * object, ref, and working-tree file is read and written through
 * here. The KV stores file contents base64-encoded; directories are
 * implicit (a directory "exists" iff any key has it as a prefix).
 *
 * Binary support is essential — Git objects (loose blobs, pack files,
 * trees, commits) contain arbitrary bytes. Base64 encoding is the
 * unavoidable cost of routing everything through a UTF-8 KV.
 */

import type { StorageAdapter } from "./adapters.js";
import {
    base64ToBytes,
    bytesToBase64,
    bytesToUtf8,
    utf8ToBytes,
} from "./encoding.js";

// ---------------------------------------------------------------------------
// Stats shape
// ---------------------------------------------------------------------------

export interface FsStats {
    type: "file" | "dir" | "symlink";
    mode: number;
    size: number;
    ino: number;
    mtimeMs: number;
    ctimeMs: number;
    uid: number;
    gid: number;
    dev: number;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
}

function makeFileStats(size: number): FsStats {
    return {
        type: "file",
        mode: 0o100644,
        size,
        ino: 0,
        mtimeMs: 0,
        ctimeMs: 0,
        uid: 0,
        gid: 0,
        dev: 0,
        isFile: () => true,
        isDirectory: () => false,
        isSymbolicLink: () => false,
    };
}

function makeDirStats(): FsStats {
    return {
        type: "dir",
        mode: 0o040755,
        size: 0,
        ino: 0,
        mtimeMs: 0,
        ctimeMs: 0,
        uid: 0,
        gid: 0,
        dev: 0,
        isFile: () => false,
        isDirectory: () => true,
        isSymbolicLink: () => false,
    };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

interface FsError extends Error {
    code: string;
    errno: number;
    syscall: string;
    path: string;
}

function fsError(
    code: string,
    errno: number,
    syscall: string,
    path: string,
    message: string,
): FsError {
    const err = new Error(`${code}: ${message}, ${syscall} '${path}'`) as FsError;
    err.code = code;
    err.errno = errno;
    err.syscall = syscall;
    err.path = path;
    return err;
}

const enoent = (syscall: string, path: string) =>
    fsError("ENOENT", -2, syscall, path, "no such file or directory");
const enotdir = (syscall: string, path: string) =>
    fsError("ENOTDIR", -20, syscall, path, "not a directory");
const eisdir = (syscall: string, path: string) =>
    fsError("EISDIR", -21, syscall, path, "illegal operation on a directory");
const eexist = (syscall: string, path: string) =>
    fsError("EEXIST", -17, syscall, path, "file already exists");
const enotempty = (syscall: string, path: string) =>
    fsError("ENOTEMPTY", -39, syscall, path, "directory not empty");

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function normalize(p: string): string {
    if (p === "") return "/";
    let out = p;
    while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
    return out;
}

function dirPrefix(p: string): string {
    const n = normalize(p);
    return n === "/" ? "/" : `${n}/`;
}

// ---------------------------------------------------------------------------
// FS adapter
// ---------------------------------------------------------------------------

export interface FsReadOpts {
    encoding?: "utf8" | "utf-8";
}

export interface FsWriteOpts {
    encoding?: "utf8" | "utf-8";
    mode?: number;
}

export interface FsMkdirOpts {
    recursive?: boolean;
    mode?: number;
}

/**
 * Build the `fs` object that isomorphic-git accepts. The object is
 * intentionally flat — iso-git calls methods directly on it.
 *
 * Construct with the storage adapter the language has initialised
 * during `init()`. Construct once per Language instance and reuse.
 */
export function createFsAdapter(storage: StorageAdapter): GitFs {
    return new GitFs(storage);
}

export class GitFs {
    constructor(private readonly storage: StorageAdapter) {}

    /**
     * Underlying KV-style fs object that iso-git treats as its
     * filesystem. iso-git's API expects a `.promises` namespace
     * holding the async methods.
     */
    public readonly promises = {
        readFile: this.readFile.bind(this),
        writeFile: this.writeFile.bind(this),
        unlink: this.unlink.bind(this),
        readdir: this.readdir.bind(this),
        mkdir: this.mkdir.bind(this),
        rmdir: this.rmdir.bind(this),
        stat: this.stat.bind(this),
        lstat: this.lstat.bind(this),
        readlink: this.readlink.bind(this),
        symlink: this.symlink.bind(this),
        chmod: this.chmod.bind(this),
    };

    async readFile(filepath: string, opts?: FsReadOpts): Promise<Uint8Array | string> {
        const path = normalize(filepath);
        const encoded = this.storage.get(path);
        if (encoded === null) {
            // Directory case: iso-git sometimes stat-then-reads; we surface ENOENT
            throw enoent("open", path);
        }
        const bytes = base64ToBytes(encoded);
        if (opts?.encoding === "utf8" || opts?.encoding === "utf-8") {
            return bytesToUtf8(bytes);
        }
        return bytes;
    }

    async writeFile(
        filepath: string,
        data: Uint8Array | string,
        opts?: FsWriteOpts,
    ): Promise<void> {
        const path = normalize(filepath);
        let bytes: Uint8Array;
        if (typeof data === "string") {
            bytes = utf8ToBytes(data);
        } else {
            bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        }
        this.storage.put(path, bytesToBase64(bytes));
    }

    async unlink(filepath: string): Promise<void> {
        const path = normalize(filepath);
        const existing = this.storage.get(path);
        if (existing === null) throw enoent("unlink", path);
        this.storage.delete(path);
    }

    async readdir(filepath: string): Promise<string[]> {
        const path = normalize(filepath);
        // Verify it really is a directory: either it has children, or
        // we treat the root as always a directory.
        const prefix = dirPrefix(path);
        const allKeys = this.storage.listKeys(prefix);
        if (allKeys.length === 0 && path !== "/" && this.storage.get(path) !== null) {
            throw enotdir("readdir", path);
        }
        const entries = new Set<string>();
        for (const key of allKeys) {
            const rest = key.slice(prefix.length);
            if (rest === "") continue;
            const slashIdx = rest.indexOf("/");
            const first = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
            if (first) entries.add(first);
        }
        return [...entries].sort();
    }

    async mkdir(filepath: string, opts?: FsMkdirOpts): Promise<void> {
        const path = normalize(filepath);
        // If it's already a file → EEXIST
        if (this.storage.get(path) !== null) {
            throw eexist("mkdir", path);
        }
        // If it's already a directory and recursive=false → EEXIST
        const childKeys = this.storage.listKeys(dirPrefix(path));
        if (childKeys.length > 0 && !opts?.recursive) {
            throw eexist("mkdir", path);
        }
        // Directories are implicit in our KV; nothing to write.
    }

    async rmdir(filepath: string): Promise<void> {
        const path = normalize(filepath);
        const prefix = dirPrefix(path);
        const childKeys = this.storage.listKeys(prefix);
        if (childKeys.length > 0) throw enotempty("rmdir", path);
        // Directories are implicit; nothing to delete.
    }

    async stat(filepath: string): Promise<FsStats> {
        const path = normalize(filepath);
        const fileData = this.storage.get(path);
        if (fileData !== null) {
            const size = base64ToBytes(fileData).length;
            return makeFileStats(size);
        }
        // Directory case: any child key with this prefix counts.
        const prefix = dirPrefix(path);
        const childKeys = this.storage.listKeys(prefix);
        if (childKeys.length > 0 || path === "/") {
            return makeDirStats();
        }
        throw enoent("stat", path);
    }

    async lstat(filepath: string): Promise<FsStats> {
        // No symlinks in our store; lstat == stat.
        return this.stat(filepath);
    }

    async readlink(filepath: string): Promise<string> {
        throw fsError(
            "EINVAL",
            -22,
            "readlink",
            normalize(filepath),
            "not a symbolic link (no symlinks in this filesystem)",
        );
    }

    async symlink(_target: string, filepath: string): Promise<void> {
        throw fsError(
            "ENOSYS",
            -38,
            "symlink",
            normalize(filepath),
            "symlinks are not supported",
        );
    }

    async chmod(_filepath: string, _mode: number): Promise<void> {
        // KV has no permissions model; chmod is a no-op.
    }
}
