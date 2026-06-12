/**
 * isomorphic-git HttpClient implementation backed by the executor's
 * `httpFetch` host import.
 *
 * **Known limitation:** the host `httpFetch` returns response bodies
 * as UTF-8 strings, decoding non-UTF-8 bytes to the U+FFFD
 * replacement character. Git smart-protocol pack files are binary
 * and do not survive this round-trip. Until the host exposes a
 * binary HTTP primitive (`httpFetchBytes`, see successor spec), any
 * actual `git fetch` / `git push` call will fail on the response
 * parse. The wiring is present so that `sync()` returns clean errors
 * rather than silent corruption, and so the transport becomes
 * functional automatically once the host is binary-capable.
 *
 * v1 sync therefore never invokes this transport. It's exported for
 * the day the host contract supports binary, and for tests that want
 * to exercise the iso-git wiring against text-safe endpoints.
 */

import type { Transport } from "./adapters.js";

// ---------------------------------------------------------------------------
// isomorphic-git HttpClient shapes
// ---------------------------------------------------------------------------

export interface IsoGitHttpRequest {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: AsyncIterable<Uint8Array> | Iterable<Uint8Array>;
}

export interface IsoGitHttpResponse {
    url: string;
    method: string;
    statusCode: number;
    statusMessage: string;
    headers: Record<string, string>;
    body: AsyncIterable<Uint8Array>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function concatChunks(chunks: Uint8Array[]): Uint8Array {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

async function collectBody(
    body: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | undefined,
): Promise<Uint8Array> {
    if (!body) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
    }
    return concatChunks(chunks);
}

function bytesToLatin1String(bytes: Uint8Array): string {
    let out = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        out += String.fromCharCode.apply(null, Array.from(chunk));
    }
    return out;
}

function latin1StringToBytes(s: string): Uint8Array {
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) {
        bytes[i] = s.charCodeAt(i) & 0xff;
    }
    return bytes;
}

function oneShotIterable(bytes: Uint8Array): AsyncIterable<Uint8Array> {
    return {
        [Symbol.asyncIterator]() {
            let yielded = false;
            return {
                async next(): Promise<IteratorResult<Uint8Array>> {
                    if (yielded) return { value: undefined as never, done: true };
                    yielded = true;
                    return { value: bytes, done: false };
                },
            };
        },
    };
}

// ---------------------------------------------------------------------------
// HttpClient
// ---------------------------------------------------------------------------

export function createHttpClient(transport: Transport): {
    request: (req: IsoGitHttpRequest) => Promise<IsoGitHttpResponse>;
} {
    return {
        async request(req: IsoGitHttpRequest): Promise<IsoGitHttpResponse> {
            const method = (req.method ?? "GET").toUpperCase();
            const bodyBytes = await collectBody(req.body);
            const bodyStr = bytesToLatin1String(bodyBytes);

            const response = await transport.fetch(
                req.url,
                method,
                req.headers ?? {},
                bodyStr,
            );

            const respBytes = latin1StringToBytes(response.body);
            return {
                url: req.url,
                method,
                statusCode: response.status || 200,
                statusMessage: "",
                headers: response.headers ?? {},
                body: oneShotIterable(respBytes),
            };
        },
    };
}
