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
import type { GitProvider } from "./src/providers/types.js";
import { selectProvider } from "./src/providers/select.js";
import {
    pullOnce,
    pushOnce,
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
const REMOTE_KIND = "auto";

//!@ad4m-template-variable
const DEFAULT_BRANCH = "main";

//!@ad4m-template-variable
const AUTH_TOKEN = "";

//!@ad4m-template-variable
const GIT_API_BASE = "";

//!@ad4m-template-variable
const MERGE_POLICY = "add-wins";

//!@ad4m-template-variable
const PUSH_DEBOUNCE_MS = "5000";

//!@ad4m-template-variable
const PULL_INTERVAL_MS = "60000";

// REMOTE_KIND selects the provider ("auto" | "github" | "radicle"); "auto"
// infers it from REMOTE_URL (see detectProvider). GIT_API_BASE, when non-empty,
// points the GitHub-REST provider at a custom base (GitHub Enterprise, a
// self-hosted git-data server, or a test rig) and takes owner/repo from the
// REMOTE_URL path instead of requiring a github.com host. MERGE_POLICY resolves
// concurrent add-vs-remove of the same link hash during divergent-history
// convergence (see src/merge.ts); it is parsed once at init and threaded
// into every pull. PUSH_DEBOUNCE_MS coalesces bursty local commits into one
// trailing-edge push (see schedulePush).

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let myDid: string = "";
let fs: GitFs | null = null;
let remoteProvider: GitProvider | null = null;
let remoteSyncHandle: RemoteSyncHandle | null = null;
let mergePolicy: MergePolicy = "add-wins";

// Trailing-edge push debounce: a burst of local commits schedules a single
// push PUSH_DEBOUNCE_MS after the last one, so we do not POST once per link.
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pushInFlight: Promise<void> | null = null;

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

/**
 * Resolve the configured remote (`REMOTE_KIND × REMOTE_URL`) into a
 * provider, or null when no supported remote is set. See
 * {@link selectProvider} for the selection rules.
 */
function detectProvider(): GitProvider | null {
    return selectProvider({
        url: REMOTE_URL,
        kind: REMOTE_KIND,
        transport: getTransport(),
        authToken: AUTH_TOKEN,
        apiBase: GIT_API_BASE,
    });
}

/**
 * Schedule a trailing-edge debounced push. Called after each successful
 * local commit; coalesces a burst of commits into a single push fired
 * `PUSH_DEBOUNCE_MS` after the last one. A no-op when there is no provider,
 * the provider cannot push, or the debounce is disabled (<= 0). Errors are
 * swallowed so a push failure never breaks the commit path — the next
 * commit (or a manual sync) re-attempts.
 */
function schedulePush(): void {
    if (!remoteProvider || !remoteProvider.canPush || !fs) return;
    const debounceMs = Number.parseInt(PUSH_DEBOUNCE_MS, 10);
    const delay = Number.isFinite(debounceMs) && debounceMs > 0 ? debounceMs : 0;

    if (pushTimer !== null) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
        pushTimer = null;
        const provider = remoteProvider;
        const targetFs = fs;
        if (!provider || !targetFs) return;
        pushInFlight = (async () => {
            try {
                await pushOnce({
                    provider,
                    branch: DEFAULT_BRANCH,
                    intervalMs: 0,
                    fs: targetFs,
                    agentDid: myDid,
                    mergePolicy,
                });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                try {
                    console.warn(`[git-link-language] push failed: ${message}`);
                } catch (_e) {
                    // Never let the debounced push crash the runtime.
                }
            }
        })();
    }, delay);
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
    // Cancel a pending debounced push and let any in-flight push settle so a
    // teardown mid-burst does not leak a timer or a dangling POST.
    if (pushTimer !== null) {
        clearTimeout(pushTimer);
        pushTimer = null;
    }
    if (pushInFlight) {
        try {
            await pushInFlight;
        } catch (_e) {
            // Already logged at the push site.
        }
        pushInFlight = null;
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
    const sha = await ops.commit({
        fs: getFs(),
        diff,
        authorDid: myDid,
    });
    // Only a diff that actually changed something advances HEAD and needs a
    // push. A no-op commit returns the existing HEAD unchanged.
    if (diff.additions.length > 0 || diff.removals.length > 0) {
        schedulePush();
    }
    return sha;
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
    "REMOTE_KIND",
    "DEFAULT_BRANCH",
    "AUTH_TOKEN",
    "GIT_API_BASE",
    "MERGE_POLICY",
    "PUSH_DEBOUNCE_MS",
    "PULL_INTERVAL_MS",
];
