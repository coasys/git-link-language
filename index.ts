/**
 * # Git Link Language
 *
 * AD4M Link Language backing Perspectives with a real Git repository.
 *
 * The local Git substrate provides:
 *
 *   - One commit per PerspectiveDiff, signed at the link layer by the
 *     agent's DID and authored under a DID-derived committer identity.
 *   - Full local history available through custom `git-history`,
 *     `git-state-at`, and `git-blame` query kinds.
 *   - Standard `link-pattern` queries against an in-memory cache for
 *     fast SDNA-driven traversal.
 *   - `revert-to` and `tag` interactions for history navigation.
 *
 * Remote sync via `git fetch`/`git push` is NOT wired in v1: the
 * executor's `httpFetch` returns response bodies as UTF-8 strings,
 * which mangles binary Git pack files. Sync therefore detects HEAD
 * movement applied externally (via the host's Git CLI or via shared
 * storage) and emits the resulting PerspectiveDiff. See spec §11.2.
 */

import { agentDid, hash } from "@coasys/ad4m-ldk";

import {
    initStorage,
    initTransport,
    initRuntime,
    initSigning,
    getStorage,
} from "./src/adapters.js";
import {
    DenoStorageAdapter,
    DenoTransport,
    DenoRuntime,
    DenoSigningAdapter,
} from "./src/adapters-deno.js";

import { createFsAdapter, type GitFs } from "./src/fs-adapter.js";
import * as ops from "./src/operations.js";
import * as queries from "./src/queries.js";
import * as store from "./src/store.js";
import { buildInteractions } from "./src/interactions.js";
import type { PerspectiveDiff } from "./src/types.js";

// ---------------------------------------------------------------------------
// Template variables (replaced at publish time by the executor)
// ---------------------------------------------------------------------------

//!@ad4m-template-variable
const REMOTE_URL = "<to-be-filled>";

//!@ad4m-template-variable
const DEFAULT_BRANCH = "main";

//!@ad4m-template-variable
const AUTH_TOKEN = "";

//!@ad4m-template-variable
const MERGE_POLICY = "add-wins";

//!@ad4m-template-variable
const PUSH_DEBOUNCE_MS = "5000";

// These template variables are captured for forward compatibility with
// the remote sync path (gated by binary HTTP, see spec §11.2). v1 does
// not read them at runtime, but they must appear in the bundle so the
// executor can replace them at publish time.
void REMOTE_URL;
void AUTH_TOKEN;
void MERGE_POLICY;
void PUSH_DEBOUNCE_MS;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let myDid: string = "";
let fs: GitFs | null = null;

function getFs(): GitFs {
    if (!fs) {
        throw new Error("Language not initialised; call init() first.");
    }
    return fs;
}

// ---------------------------------------------------------------------------
// Language capabilities (flat exports — matches the ALDK convention)
// ---------------------------------------------------------------------------

export const name = "git-link-language";
export const version = "0.1.0";

export function isPublic(): boolean {
    return true;
}

export async function init(): Promise<void> {
    initStorage(new DenoStorageAdapter());
    initTransport(new DenoTransport());
    initRuntime(new DenoRuntime());
    initSigning(new DenoSigningAdapter());
    store.initStore(hash);
    myDid = agentDid();
    fs = createFsAdapter(getStorage());
    await ops.boot({ fs, defaultBranch: DEFAULT_BRANCH });
}

export async function teardown(): Promise<void> {
    myDid = "";
    fs = null;
}

export function interactions(_address: string) {
    const ctx = { fs: getFs(), agentDid: myDid };
    return buildInteractions(ctx);
}

// ----- perspective-commit ---------------------------------------------------

export async function perspectiveCommit(
    diff: PerspectiveDiff,
): Promise<string> {
    return await ops.commit({
        fs: getFs(),
        diff,
        authorDid: myDid,
    });
}

// ----- perspective-sync -----------------------------------------------------

export async function perspectiveSyncSync(): Promise<PerspectiveDiff> {
    return await ops.sync({ fs: getFs() });
}

export async function perspectiveSyncRender() {
    return ops.render();
}

export async function perspectiveSyncCurrentRevision(): Promise<string> {
    return await ops.currentRevision(getFs());
}

// ----- perspective-query ----------------------------------------------------

export function perspectiveQuerySupportedKinds(): string[] {
    return [...queries.QUERY_KINDS];
}

export async function perspectiveQueryRun(
    req: { kind: string; payload: unknown },
): Promise<{ kind: string; payload: unknown }> {
    return await queries.runQuery(req, getFs());
}

// ---------------------------------------------------------------------------
// Default export — bundles the flat surface
// ---------------------------------------------------------------------------

const language = {
    name,
    version,
    isPublic,
    init,
    teardown,
    interactions,
    perspectiveCommit,
    perspectiveSyncSync,
    perspectiveSyncRender,
    perspectiveSyncCurrentRevision,
    perspectiveQuerySupportedKinds,
    perspectiveQueryRun,
};

export default language;

// ---------------------------------------------------------------------------
// Template params metadata (for language.publish / LanguageMeta)
// ---------------------------------------------------------------------------

export const possibleTemplateParams: string[] = [
    "REMOTE_URL",
    "DEFAULT_BRANCH",
    "AUTH_TOKEN",
    "MERGE_POLICY",
    "PUSH_DEBOUNCE_MS",
];
