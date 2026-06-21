// tests/unit/orchestrator-failover-lastresort.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function quotaStub(id: ProviderAdapter["id"]): ProviderAdapter {
  return {
    id,
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      // Primary is quota-locked: it never produces a usable review.
      return {
        reviewerId: inp.reviewerId,
        verdict: "ERROR",
        findings: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: -1,
        rawEventsPath: "",
        status: "quota-exhausted",
        statusDetail: "usage limit reached",
      } satisfies ReviewResult;
    },
  };
}

function okStub(id: ProviderAdapter["id"], findings: Finding[]): ProviderAdapter {
  return {
    id,
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      return {
        reviewerId: inp.reviewerId,
        verdict: findings.length ? "FAIL" : "PASS",
        findings,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        rawText: "",
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

const DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

describe("orchestrator last-resort failover", () => {
  it("tries an enabled+available provider OUTSIDE the slot's declared fallback chain when the chain is exhausted", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lastresort-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const config = {
      ...defaultConfig,
      providers: {
        ...defaultConfig.providers,
        // claude-code is ENABLED and available, but NOT in codex's fallback chain.
        "claude-code": {
          enabled: true,
          auth: "oauth" as const,
          model: "claude-sonnet-4-6",
          timeoutMs: 1000,
        },
      },
      phases: {
        ...defaultConfig.phases,
        // codex is the only reviewer, with NO fallback chain → pre-fix this collapses to 0 okRuns.
        review: { reviewers: [{ provider: "codex" as const, persona: "security", fallback: [] }] },
        critic: null,
        triage: null,
      },
    };
    const orch = new Orchestrator({
      repoRoot: repo,
      config,
      adapters: {
        codex: quotaStub("codex"),
        "claude-code": okStub("claude-code", []),
      },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
      providerAvailable: () => true,
    });
    const result = await orch.runIteration({ runId: "RUN", iter: 1 });
    // Pre-fix: codex quota-locked + empty chain → 0 okRuns → verdict ERROR.
    // Post-fix: last-resort recruits the enabled+available claude-code → a real review.
    expect(result.verdict).not.toBe("ERROR");
    expect(result.summary.providers.some((p) => p.provider === "claude-code" && p.runs > 0)).toBe(
      true,
    );
  });

  it("does NOT auto-recruit openrouter as a last-resort reviewer (low-precision paid model; fail closed instead)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-lr-or-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const config = {
      ...defaultConfig,
      providers: {
        ...defaultConfig.providers,
        // openrouter ENABLED + available (it powers the brain's embeddings) but must NEVER be
        // pulled into the reviewer panel just for being enabled — only if explicitly declared.
        openrouter: {
          enabled: true,
          auth: "openrouter" as const,
          model: "deepseek/deepseek-v4-flash",
          apiKeyEnv: "OPENROUTER_API_KEY",
          timeoutMs: 1000,
        },
      },
      phases: {
        ...defaultConfig.phases,
        // codex only, no fallback; codex quota-locked; NO OAuth reviewer available.
        review: { reviewers: [{ provider: "codex" as const, persona: "security", fallback: [] }] },
        critic: null,
        triage: null,
      },
    };
    const orch = new Orchestrator({
      repoRoot: repo,
      config,
      adapters: {
        codex: quotaStub("codex"),
        openrouter: okStub("openrouter", []), // would produce a review IF (wrongly) recruited
      },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
      providerAvailable: () => true,
    });
    const result = await orch.runIteration({ runId: "RUN", iter: 1 });
    // openrouter must NOT be recruited → no usable reviewer → fail CLOSED (ERROR), not a paid 23% review.
    expect(result.summary.providers.some((p) => p.provider === "openrouter" && p.runs > 0)).toBe(
      false,
    );
    expect(result.verdict).toBe("ERROR");
  });
});
