/**
 * Tests for provider selection over REMOTE_KIND × REMOTE_URL
 * (src/providers/select.ts). No network: only the URL parsers and
 * constructors run, so a stub Transport suffices.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { Transport, TransportResponse } from "../src/adapters.js";
import { selectProvider } from "../src/providers/select.js";
import { GitHubProvider } from "../src/providers/github.js";
import { RadicleProvider } from "../src/providers/radicle.js";

const stubTransport: Transport = {
    fetch(): Promise<TransportResponse> {
        return Promise.resolve({ status: 200, headers: {}, body: "{}" });
    },
};

const GITHUB_URL = "https://github.com/coasys/git-link-language";
const RID = "rad:z4GypKmh1gkEfmkXtarcYnkvtFUfE";
const RADICLE_URL = `https://seed.example.com/api/v1/projects/${RID}`;

function select(url: string, kind: string) {
    return selectProvider({ url, kind, transport: stubTransport, authToken: "" });
}

/** Capture the URL of the first transport call a provider makes. */
class CapturingTransport implements Transport {
    public lastUrl = "";
    fetch(url: string): Promise<TransportResponse> {
        this.lastUrl = url;
        return Promise.resolve({ status: 200, headers: {}, body: '{"object":{"sha":"x"}}' });
    }
}

// ---------------------------------------------------------------------------
// auto
// ---------------------------------------------------------------------------

describe("selectProvider: auto", () => {
    it("picks GitHub for a github.com URL", () => {
        assert.ok(select(GITHUB_URL, "auto") instanceof GitHubProvider);
    });

    it("picks Radicle for a radicle-httpd URL", () => {
        assert.ok(select(RADICLE_URL, "auto") instanceof RadicleProvider);
    });

    it("picks Radicle for a bare RID", () => {
        assert.ok(select(RID, "auto") instanceof RadicleProvider);
    });

    it("returns null for an unrecognised URL", () => {
        assert.equal(select("https://gitlab.com/o/r", "auto"), null);
    });

    it("returns null for an unfilled/empty URL", () => {
        assert.equal(select("<to-be-filled>", "auto"), null);
        assert.equal(select("", "auto"), null);
    });

    it("treats an unknown kind as auto", () => {
        assert.ok(select(GITHUB_URL, "bogus") instanceof GitHubProvider);
    });
});

// ---------------------------------------------------------------------------
// explicit kind wins
// ---------------------------------------------------------------------------

describe("selectProvider: explicit kind", () => {
    it("kind=github selects GitHub for a github URL", () => {
        assert.ok(select(GITHUB_URL, "github") instanceof GitHubProvider);
    });

    it("kind=github returns null for a non-github URL (does not fall back)", () => {
        assert.equal(select(RADICLE_URL, "github"), null);
        assert.equal(select(RID, "github"), null);
    });

    it("kind=radicle selects Radicle for a radicle URL", () => {
        assert.ok(select(RADICLE_URL, "radicle") instanceof RadicleProvider);
    });

    it("kind=radicle selects Radicle for a bare RID", () => {
        assert.ok(select(RID, "radicle") instanceof RadicleProvider);
    });

    it("kind=radicle returns null for a github URL (does not fall back)", () => {
        assert.equal(select(GITHUB_URL, "radicle"), null);
    });

    it("kind is case-insensitive", () => {
        assert.ok(select(GITHUB_URL, "GitHub") instanceof GitHubProvider);
        assert.ok(select(RID, "RADICLE") instanceof RadicleProvider);
    });
});

// ---------------------------------------------------------------------------
// canPush surfaced through selection
// ---------------------------------------------------------------------------

describe("selectProvider: canPush reflects the chosen provider", () => {
    it("GitHub → canPush true", () => {
        const p = select(GITHUB_URL, "auto");
        assert.equal(p?.canPush, true);
    });
    it("Radicle → canPush false", () => {
        const p = select(RADICLE_URL, "auto");
        assert.equal(p?.canPush, false);
    });
});

// ---------------------------------------------------------------------------
// apiBase override (GIT_API_BASE) — GitHub-compatible base on any host
// ---------------------------------------------------------------------------

describe("selectProvider: apiBase override", () => {
    const API_BASE = "http://127.0.0.1:7792";
    const REPO_URL = "http://127.0.0.1:7792/c1/nh-abc";

    it("returns a GitHub provider for a non-github host when apiBase is set", () => {
        const p = selectProvider({
            url: REPO_URL,
            kind: "github",
            transport: stubTransport,
            authToken: "",
            apiBase: API_BASE,
        });
        assert.ok(p instanceof GitHubProvider);
        assert.equal(p?.canPush, true);
    });

    it("routes reads to the custom base (owner/repo from the path)", async () => {
        const transport = new CapturingTransport();
        const p = selectProvider({
            url: REPO_URL,
            kind: "auto",
            transport,
            authToken: "",
            apiBase: API_BASE,
        });
        assert.ok(p instanceof GitHubProvider);
        await p!.fetchRef("main");
        assert.equal(
            transport.lastUrl,
            "http://127.0.0.1:7792/repos/c1/nh-abc/git/refs/heads/main",
        );
    });

    it("wins even when the URL would not parse as a github.com repo", () => {
        // A bare host/path that parseGitHubUrl rejects still selects a provider
        // via the path parser once apiBase is configured.
        const p = selectProvider({
            url: REPO_URL,
            kind: "auto",
            transport: stubTransport,
            authToken: "",
            apiBase: API_BASE,
        });
        assert.ok(p instanceof GitHubProvider);
    });

    it("returns null when apiBase is set but the URL path lacks owner/repo", () => {
        const p = selectProvider({
            url: "http://127.0.0.1:7792/only-one",
            kind: "auto",
            transport: stubTransport,
            authToken: "",
            apiBase: API_BASE,
        });
        assert.equal(p, null);
    });

    it("is ignored when empty (falls back to host-based detection)", () => {
        const p = selectProvider({
            url: GITHUB_URL,
            kind: "auto",
            transport: stubTransport,
            authToken: "",
            apiBase: "",
        });
        assert.ok(p instanceof GitHubProvider);
    });
});
