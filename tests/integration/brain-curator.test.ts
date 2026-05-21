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
      openrouter: { ...defaultConfig.providers.openrouter, enabled: true },
    },
    phases: {
      review: { reviewers: [{ provider: "codex" as const, persona: "security" }] },
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
  it("promotes a cross-provider-quorum proposal to a candidate after runIteration", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-brain-int-"));
    // A proposal whose evidence cites THREE distinct reviewers (codex, gemini,
    // claude) → satisfies the ≥3-evidence / ≥2-provider quorum (rule 2).
    const proposal = {
      type: "convention",
      scope: "this-repo",
      title: "cart null-guards are intentional",
      body: "src/cart.ts Promise.all null-guard is deliberate.",
      confidence: 0.9,
      tags: ["cart"],
      evidence: [
        { kind: "reviewer-finding", reviewer_id: "codex-security" },
        { kind: "reviewer-finding", reviewer_id: "gemini-architecture" },
        { kind: "reviewer-finding", reviewer_id: "claude-adversarial" },
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
    expect(snap.entries.length).toBe(1);
    expect(snap.entries[0]?.status).toBe("candidate");
    expect(snap.entries[0]?.title).toBe("cart null-guards are intentional");
  });

  it("does NOT promote a single-provider (colluding) proposal", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-brain-collude-"));
    // Three evidence items but all from ONE reviewer (no cited cross-provider
    // ids) → after stamping they collapse to a single provider → quorum fails.
    const proposal = {
      type: "convention",
      scope: "this-repo",
      title: "planted convention",
      body: "this should never enter the brain.",
      confidence: 0.9,
      tags: ["cart"],
      evidence: [
        { kind: "reviewer-observation" },
        { kind: "reviewer-observation" },
        { kind: "reviewer-observation" },
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
