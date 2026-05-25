// tests/integration/cli-judge-complete.test.ts
// Proves the orchestrator wires the contradiction judge to a CLI-provider
// curator's complete() correctly: the call-site FORWARDS the provider's auth,
// and a contradiction verdict flags the active FP entry (contradicts_brain_id)
// instead of pairing it. (That the REAL CLI adapters actually expose a working
// complete() — the "no longer a no-op" half — is proven by the per-adapter unit
// tests in Tasks 2–5. Here we use an in-memory codex adapter with complete() to
// isolate the call-site/auth wiring, which is the part that fails pre-change.)
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { BrainStore } from "../../src/core/brain/store.ts";
import { FpLedgerStore } from "../../src/core/fp-ledger/store.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type {
  CompleteOptions,
  Preflight,
  ProviderAdapter,
  ReviewResult,
} from "../../src/providers/adapter-base.ts";

const CODE_DIFF =
  "diff --git a/src/cart.ts b/src/cart.ts\n" +
  "--- a/src/cart.ts\n+++ b/src/cart.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n";

// A codex adapter that BOTH reviews (PASS, no proposals) AND judges via
// complete() — recording the opts it received so we can assert auth forwarding.
class CodexReviewerJudge implements ProviderAdapter {
  readonly id = "codex" as const;
  lastOpts: CompleteOptions | null = null;
  constructor(private readonly verdictJson: string) {}
  async preflight(): Promise<Preflight> {
    return { available: true, version: "x", authMode: "oauth", error: null };
  }
  async review(inp: { reviewerId: string }): Promise<ReviewResult> {
    return {
      reviewerId: inp.reviewerId,
      verdict: "PASS",
      findings: [],
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
      durationMs: 1,
      exitCode: 0,
      rawEventsPath: "",
      rawText: JSON.stringify({ verdict: "PASS", findings: [] }),
      status: "ok",
    };
  }
  async complete(_prompt: string, opts: CompleteOptions): Promise<string> {
    this.lastOpts = opts;
    return this.verdictJson;
  }
}

// Fake openrouter exposing embed() (orthogonal vectors → no accidental dedup).
function fakeOpenRouter(): ProviderAdapter & {
  embed(t: string, o: { model: string; apiKeyEnv: string }): Promise<number[]>;
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
      let h = 0;
      for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 9973;
      return [Math.cos(h), Math.sin(h), 1];
    },
  };
}

describe("CLI provider (codex) as brain curator judge via complete()", () => {
  it("forwards auth to complete() and flags the FP on a contradiction", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cli-judge-"));

    // Seed an ACTIVE FP entry (≥3 rejects across 2 distinct providers).
    const fpStore = new FpLedgerStore(repo);
    const fpMeta = {
      rule_id: "magic-number",
      category: "quality" as const,
      file: "src/cart.ts",
      symbol: "",
    };
    const t = "2026-05-22T00:00:00Z";
    await fpStore.recordReject(
      "sigM",
      fpMeta,
      { run_id: "r1", provider: "codex", reason: "intentional constant xx" },
      t,
    );
    await fpStore.recordReject(
      "sigM",
      fpMeta,
      { run_id: "r2", provider: "gemini", reason: "intentional constant xx" },
      t,
    );
    await fpStore.recordReject(
      "sigM",
      fpMeta,
      { run_id: "r3", provider: "codex", reason: "intentional constant xx" },
      t,
    );
    expect((await fpStore.snapshot()).entries[0]?.stage).toBe("active");

    // A CONTRADICTING active brain anti-pattern (magic-number IS real here).
    const bs = new BrainStore(repo);
    await bs.add({
      id: "B-900",
      type: "anti-pattern",
      scope: "this-repo",
      title: "magic-number is always real here",
      body: "never dismiss magic-number",
      tags: ["magic-number"],
      file_globs: ["src/cart.ts"],
      status: "active",
      referenced_count: 3,
      referencing_reviewers: ["codex", "gemini"],
      confidence: 0.95,
      embedding: null,
      evidence: [],
      created_at: t,
      source_run_id: "seed",
    });

    const judge = new CodexReviewerJudge(
      '{"contradicts":true,"brain_entry_id":"B-900","reason":"anti-pattern says it is real"}',
    );
    const config = {
      ...defaultConfig,
      providers: {
        ...defaultConfig.providers,
        // Curator provider is a CLI provider in APIKEY mode → the call-site must forward auth.
        codex: {
          ...defaultConfig.providers.codex,
          enabled: true,
          auth: "apikey" as const,
          apiKeyEnv: "RG_TEST_CURATOR_KEY",
        },
        openrouter: { ...defaultConfig.providers.openrouter, enabled: true },
      },
      phases: {
        ...defaultConfig.phases,
        review: { reviewers: [{ provider: "codex" as const, persona: "security" }] },
        critic: null,
        triage: null,
        fpLedger: { enabled: true },
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
          curator: { provider: "codex" as const, model: "x", persona: "fp-filter" },
        },
      },
    };
    const orch = new Orchestrator({
      repoRoot: repo,
      config,
      adapters: { codex: judge, openrouter: fakeOpenRouter() },
      sandboxMode: "off",
      hostTier: "opus",
      diff: CODE_DIFF,
      reasonOnFailEnabled: true,
    });
    await orch.runIteration({ runId: "RUN1", iter: 1 });

    // The judge ran through the CLI adapter's complete() with the provider's auth.
    expect(judge.lastOpts).not.toBeNull();
    expect(judge.lastOpts?.auth).toBe("apikey");
    // Contradiction flagged the FP instead of pairing it.
    const fp = (await fpStore.snapshot()).entries[0];
    expect(fp?.contradicts_brain_id).toBe("B-900");
    expect(fp?.linked_brain_id).toBeUndefined();
  });
});
