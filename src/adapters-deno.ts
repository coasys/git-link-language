/**
 * Deno-specific adapter implementations.
 * Wraps ad4m:host functions from @coasys/ad4m-ldk.
 *
 * Only imported by index.ts — never by core modules or tests.
 */

import {
    httpFetch,
    storageGet,
    storagePut,
    storageDelete,
    storageListKeys,
    hash,
    emitSignal,
    emitPerspectiveDiff,
    agentSignStringHex,
    agentSigningKeyId,
} from "@coasys/ad4m-ldk";

import type { Transport, TransportResponse, StorageAdapter, RuntimeAdapter, SigningAdapter } from "./adapters.js";

export class DenoTransport implements Transport {
    async fetch(
        url: string,
        method: string,
        headers: Record<string, string>,
        body: string,
    ): Promise<TransportResponse> {
        try {
            const responseText = await httpFetch(
                url,
                method,
                JSON.stringify(headers),
                body,
            );

            return {
                status: 200,
                headers: {},
                body: responseText || "",
            };
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            const match = errMsg.match(/http_fetch\s+\S+\s+\S+\s+->\s+(\d+):\s*(.*)?$/s);
            if (match) {
                return {
                    status: parseInt(match[1], 10),
                    headers: {},
                    body: match[2] || "",
                };
            }
            console.error(`[transport] httpFetch error: ${errMsg}`);
            return { status: 0, headers: {}, body: errMsg };
        }
    }
}

export class DenoStorageAdapter implements StorageAdapter {
    get(key: string): string | null {
        return storageGet(key);
    }

    put(key: string, value: string): void {
        storagePut(key, value);
    }

    delete(key: string): void {
        storageDelete(key);
    }

    listKeys(prefix?: string): string[] {
        return storageListKeys(prefix);
    }
}

export class DenoRuntime implements RuntimeAdapter {
    hash(data: string): string {
        return hash(data);
    }

    emitSignal(data: string): void {
        emitSignal(data);
    }

    emitPerspectiveDiff(diff: unknown): void {
        emitPerspectiveDiff(diff);
    }
}

export class DenoSigningAdapter implements SigningAdapter {
    signStringHex(payload: string): string {
        return agentSignStringHex(payload);
    }

    signingKeyId(): string {
        return agentSigningKeyId();
    }
}
