/**
 * Adapter interfaces and singletons for cross-runtime abstraction.
 *
 * Combines Transport, Storage, Runtime, and Signing interfaces + init/get singletons.
 * No ad4m:host imports. Safe for cross-runtime testing.
 * Deno-specific implementations are in adapters-deno.ts.
 */

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface TransportResponse {
    status: number;
    headers: Record<string, string>;
    body: string;
}

export interface Transport {
    fetch(
        url: string,
        method: string,
        headers: Record<string, string>,
        body: string,
    ): Promise<TransportResponse>;
}

let _transport: Transport | null = null;

export function initTransport(transport: Transport): void {
    _transport = transport;
}

export function getTransport(): Transport {
    if (!_transport) {
        throw new Error(
            "Transport not initialized. Call initTransport() during language init().",
        );
    }
    return _transport;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export interface StorageAdapter {
    get(key: string): string | null;
    put(key: string, value: string): void;
    delete(key: string): void;
    listKeys(prefix?: string): string[];
}

let _storage: StorageAdapter | null = null;

export function initStorage(adapter: StorageAdapter): void {
    _storage = adapter;
}

export function getStorage(): StorageAdapter {
    if (!_storage) {
        throw new Error(
            "StorageAdapter not initialized. Call initStorage() during language init().",
        );
    }
    return _storage;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export interface RuntimeAdapter {
    hash(data: string): string;
    emitSignal(data: string): void;
    emitPerspectiveDiff(diff: unknown): void;
}

let _runtime: RuntimeAdapter | null = null;

export function initRuntime(adapter: RuntimeAdapter): void {
    _runtime = adapter;
}

export function getRuntime(): RuntimeAdapter {
    if (!_runtime) {
        throw new Error(
            "RuntimeAdapter not initialized. Call initRuntime() during language init().",
        );
    }
    return _runtime;
}

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export interface SigningAdapter {
    signStringHex(payload: string): string;
    signingKeyId(): string;
}

let _signing: SigningAdapter | null = null;

export function initSigning(adapter: SigningAdapter): void {
    _signing = adapter;
}

export function getSigning(): SigningAdapter {
    if (!_signing) {
        throw new Error(
            "SigningAdapter not initialized. Call initSigning() during language init().",
        );
    }
    return _signing;
}
