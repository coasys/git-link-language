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
 *   - `revert-to`, `tag`, and `pull-now` interactions.
 *
 * Remote sync uses GitHub's JSON REST API (refs / commits / trees /
 * blobs) because the executor's `httpFetch` UTF-8-decodes response
 * bodies and would corrupt binary Git pack files. The pull loop is an
 * in-language `setTimeout` chain (default 60 s, configurable via
 * `PULL_INTERVAL_MS`) that calls `pullOnce()` and applies any diff
 * locally. Conditional `If-None-Match` requests turn idle polling into
 * 304s that do not count against GitHub's rate limit. See spec §11.2
 * for the gap that this design closes.
 */

import { agentDid, hash } from "@coasys/ad4m-ldk";

import {
    initStorage,
    initTransport,
    initRuntime,
    initSigning,
    getStorage,
    getTransport,
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
import { GitHubProvider, parseGitHubUrl } from "./src/providers/github.js";
import {
    pullOnce,
    startRemoteSync,
    type RemoteSyncHandle,
} from "./src/remote-sync.js";
import { parseMergePolicy, type MergePolicy } from "./src/merge.js";
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

//!@ad4m-template-variable
const PULL_INTERVAL_MS = "60000";

// MERGE_POLICY resolves concurrent add-vs-remove of the same link hash
// during divergent-history convergence (see src/merge.ts). It is parsed
// once at init and threaded into every pull. PUSH_DEBOUNCE_MS is reserved
// for the write-back path.
void PUSH_DEBOUNCE_MS;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let myDid: string = "";
let fs: GitFs | null = null;
let remoteProvider: GitHubProvider | null = null;
let remoteSyncHandle: RemoteSyncHandle | null = null;
let mergePolicy: MergePolicy = "add-wins";

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
    mergePolicy = parseMergePolicy(MERGE_POLICY);
    fs = createFsAdapter(getStorage());
    await ops.boot({ fs, defaultBranch: DEFAULT_BRANCH });

    // Detect a supported remote provider from REMOTE_URL. When set,
    // both the background timer (if PULL_INTERVAL_MS > 0) and the
    // standard `perspective-sync.sync()` capability route through this
    // provider. PULL_INTERVAL_MS=0 disables the timer but leaves the
    // manual sync RPC fully functional — apps trigger pulls via
    // `perspective.pullLinks` / `perspective.sync()` whenever they
    // want fresh state (e.g. on a user "refresh" action).
    remoteProvider = detectProvider();

    if (remoteProvider) {
        const intervalMs = Number.parseInt(PULL_INTERVAL_MS, 10);
        remoteSyncHandle = startRemoteSync({
            provider: remoteProvider,
            branch: DEFAULT_BRANCH,
            intervalMs,
            fs: getFs(),
            agentDid: myDid,
            mergePolicy,
        });
    }
}

function detectProvider(): GitHubProvider | null {
    if (!REMOTE_URL || REMOTE_URL === "<to-be-filled>") return null;
    const ghRef = parseGitHubUrl(REMOTE_URL);
    if (!ghRef) return null;
    return new GitHubProvider(getTransport(), ghRef, AUTH_TOKEN);
}

function buildPullStrategy(): (() => Promise<PerspectiveDiff>) | null {
    if (!remoteProvider || !fs) return null;
    const provider = remoteProvider;
    const targetFs = fs;
    const did = myDid;
    return () =>
        pullOnce({
            provider,
            branch: DEFAULT_BRANCH,
            intervalMs: 0,
            fs: targetFs,
            agentDid: did,
            mergePolicy,
        });
}

export async function teardown(): Promise<void> {
    if (remoteSyncHandle) {
        remoteSyncHandle.stop();
        remoteSyncHandle = null;
    }
    remoteProvider = null;
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
    return await ops.sync({ fs: getFs(), pull: buildPullStrategy() });
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
    "PULL_INTERVAL_MS",
];
