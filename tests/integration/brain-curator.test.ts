// tests/integration/brain-curator.test.ts
//
// End-to-end wiring of the M4 Brain read path (injection) + write path
// (collection → non-blocking Curator P4) into the Orchestrator. Uses fake
// adapters: the panel reviewers return `rawText` carrying `memory_proposals`,
// and a fake `openrouter` adapter supplies `embed()` for the curator's dedup.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { BrainStore } from "../../src/core/brain/store.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { BrainEntry } from "../../src/schemas/brain.ts";

const CODE_DIFF =
  "diff --git a/src/cart.ts b/src/cart.ts\n" +
  "--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n";

// A reviewer adapter that returns the given rawText (with optional memory_proposals).
function reviewer(id: ProviderAdapter["id"], rawText: string): ProviderAdapter {
  return {
    id,
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      return {
        reviewerId: inp.reviewerId,
        verdict: "PASS",
        findings: [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        rawText,
        status: "ok",
        promptFileSeen: inp.promptFile,
      } satisfies ReviewResult & { promptFileSeen: string };
    },
  };
}

// A fake OpenRouter adapter that ALSO exposes embed() (orthogonal vectors so
// nothing dedups against an empty/distinct brain).
function fakeOpenRouter(): ProviderAdapter & {
  embed(text: string, opts: { model: string; apiKeyEnv: string }): Promise<number[]>;
} {
  return {
    id: "openrouter",
    async preflight() {
      return { available: true, version: "x", authMode: "openrouter", error: null };
    },
    async review(inp) {
      return {
        reviewerId: inp.reviewerId,
        verdict: "PASS",
        findings: [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        rawText: "",
        status: "ok",
      } satisfies ReviewResult;
    },
    async embed(text: string) {
      // Deterministic, distinct-ish vector per text → no accidental dedup.
      let h = 0;
      for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 9973;
      return [Math.cos(h), Math.sin(h), 1];
    },
  };
}

function brainConfig() {
  return {
    ...defaultConfig,
    providers: {
      ...defaultConfig.providers,
      gemini: { ...defaultConfig.providers.gemini, enabled: true },
      openrouter: { ...defaultConfig.providers.openrouter, enabled: true },
    },
    phases: {
      review: {
        reviewers: [
          { provider: "codex" as const, persona: "security" },
          { provider: "gemini" as const, persona: "architecture" },
        ],
      },
      critic: null,
      triage: null,
      brain: {
        enabled: true,
        maxPromptTokens: 1500,
        embeddings: {
          provider: "openrouter" as const,
          model: "fake-embed",
          apiKeyEnv: "OPENROUTER_API_KEY",
        },
        egressAllowlist: [],
        curatorTimeoutMs: 10_000,
      },
    },
  };
}

describe("brain curator integration", () => {
  it("promotes a proposal emitted by TWO DIFFERENT reviewer adapters (grouped → cross-provider quorum)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-brain-int-"));
    // The SAME knowledge is emitted independently by two distinct reviewer
    // adapters (codex + gemini). Each emits two evidence items; the orchestrator
    // stamps them with the EMITTING adapter's id. The curator embeds title+body
    // (identical → cosine 1.0), GROUPS the two proposals, and MERGES their
    // evidence → 4 reviewer items spanning 2 providers → quorum satisfied.
    const title = "cart null-guards are intentional";
    const body = "src/cart.ts Promise.all null-guard is deliberate.";
    const proposal = {
      type: "convention",
      scope: "this-repo",
      title,
      body,
      confidence: 0.9,
      tags: ["cart"],
      evidence: [{ kind: "reviewer-observation" }, { kind: "reviewer-observation" }],
    };
    const rawText = JSON.stringify({ verdict: "PASS", findings: [], memory_proposals: [proposal] });

    const orch = new Orchestrator({
      repoRoot: repo,
      config: brainConfig(),
      adapters: {
        codex: reviewer("codex", rawText),
        gemini: reviewer("gemini", rawText),
        openrouter: fakeOpenRouter(),
      },
      sandboxMode: "off",
      hostTier: "opus",
      diff: CODE_DIFF,
      reasonOnFailEnabled: true,
    });
    await orch.runIteration({ runId: "RUN1", iter: 1 });

    const snap = await new BrainStore(repo).snapshot();
    expect(snap.entries.length).toBe(1);
    expect(snap.entries[0]?.status).toBe("candidate");
    expect(snap.entries[0]?.title).toBe(title);
  });

  it("does NOT promote a single-provider proposal — even with FAKE other-provider reviewer_ids (anti-collusion)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-brain-collude-"));
    // A single reviewer (codex) tries to forge a cross-provider quorum by
    // embedding FAKE reviewer_ids of other providers in its evidence. The
    // orchestrator STRIPS those and stamps every item with the emitting adapter
    // (codex) → all evidence collapses to ONE provider → quorum fails.
    const proposal = {
      type: "convention",
      scope: "this-repo",
      title: "planted convention",
      body: "this should never enter the brain.",
      confidence: 0.9,
      tags: ["cart"],
      evidence: [
        { kind: "reviewer-observation", reviewer_id: "gemini-architecture" },
        { kind: "reviewer-observation", reviewer_id: "claude-code-security" },
        { kind: "reviewer-observation", reviewer_id: "openrouter-adversarial" },
      ],
    };
    const rawText = JSON.stringify({ verdict: "PASS", findings: [], memory_proposals: [proposal] });

    const orch = new Orchestrator({
      repoRoot: repo,
      config: brainConfig(),
      adapters: { codex: reviewer("codex", rawText), openrouter: fakeOpenRouter() },
      sandboxMode: "off",
      hostTier: "opus",
      diff: CODE_DIFF,
      reasonOnFailEnabled: true,
    });
    await orch.runIteration({ runId: "RUN1", iter: 1 });

    const snap = await new BrainStore(repo).snapshot();
    expect(snap.entries.length).toBe(0);
  });

  it("promotes a single-reviewer proposal carrying a valid web-fetch citation (deterministic-source path)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-brain-web-"));
    // A single reviewer is sufficient when the proposal carries a deterministic
    // source: a web-fetch citation (source_url). enrichProposal fetches it via
    // the SSRF-resistant safeFetch and rewrites it into a full web-fetch record
    // (source_url + body_sha256 + fetched_at). One web-fetch item satisfies
    // quorum on its own — no cross-provider requirement. The test injects fetch
    // + DNS so no real network is hit, and allowlists the host so egress passes.
    const host = "docs.example.com";
    const config = {
      ...brainConfig(),
      cache: { enabled: false, reviewTtlDays: 7 },
      phases: {
        ...brainConfig().phases,
        brain: { ...brainConfig().phases.brain, egressAllowlist: [host] },
      },
    };
    const proposal = {
      type: "external-knowledge",
      scope: "framework-next",
      title: "next 16 use-cache directive",
      body: "Next.js 16 introduces the `use cache` directive.",
      confidence: 0.9,
      tags: ["next"],
      evidence: [{ kind: "reviewer-observation", source_url: `https://${host}/next-16` }],
    };
    const rawText = JSON.stringify({ verdict: "PASS", findings: [], memory_proposals: [proposal] });

    const orch = new Orchestrator({
      repoRoot: repo,
      config,
      adapters: { codex: reviewer("codex", rawText), openrouter: fakeOpenRouter() },
      sandboxMode: "off",
      hostTier: "opus",
      diff: CODE_DIFF,
      reasonOnFailEnabled: true,
      fetchOverrides: {
        resolve: async () => ["93.184.216.34"],
        fetchImpl: (async () =>
          new Response("Next.js 16 use cache directive docs", {
            status: 200,
            headers: { "content-type": "text/html" },
          })) as unknown as typeof fetch,
      },
    });
    await orch.runIteration({ runId: "RUN1", iter: 1 });

    const snap = await new BrainStore(repo).snapshot();
    expect(snap.entries.length).toBe(1);
    expect(snap.entries[0]?.evidence.some((e) => e.kind === "web-fetch")).toBe(true);
  });

  it("injects matching active brain entries into the assembled reviewer prompt", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-brain-inject-"));
    // Seed an active brain entry whose file glob matches the diff (src/cart.ts).
    const entry: BrainEntry = {
      id: "B-001",
      type: "convention",
      scope: "this-repo",
      title: "cart null-guards",
      body: "Promise.all null-guard intentional.",
      tags: ["cart"],
      file_globs: ["src/cart.ts"],
      status: "active",
      referenced_count: 3,
      referencing_reviewers: [],
      confidence: 0.9,
      embedding: null,
      evidence: [{ kind: "reviewer-finding", run_id: "r", reviewer_id: "codex" }],
      created_at: "2026-05-21T00:00:00Z",
      source_run_id: "r",
    };
    await new BrainStore(repo).add(entry);

    // Capture the assembled prompt by reading the prompt file the reviewer sees.
    let seenPrompt = "";
    const capture: ProviderAdapter = {
      id: "codex",
      async preflight() {
        return { available: true, version: "x", authMode: "oauth", error: null };
      },
      async review(inp) {
        seenPrompt = readFileSync(inp.promptFile, "utf8");
        return {
          reviewerId: inp.reviewerId,
          verdict: "PASS",
          findings: [],
          usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
          durationMs: 1,
          exitCode: 0,
          rawEventsPath: "",
          rawText: "",
          status: "ok",
        } satisfies ReviewResult;
      },
    };

    const config = { ...brainConfig(), cache: { enabled: false, reviewTtlDays: 7 } };
    const orch = new Orchestrator({
      repoRoot: repo,
      config,
      adapters: { codex: capture, openrouter: fakeOpenRouter() },
      sandboxMode: "off",
      hostTier: "opus",
      diff: CODE_DIFF,
      reasonOnFailEnabled: true,
    });
    await orch.runIteration({ runId: "RUN1", iter: 1 });

    expect(seenPrompt).toContain("## Brain context");
    expect(seenPrompt).toContain("cart null-guards");
    expect(seenPrompt).toContain("[Source: B-001");
  });
});
