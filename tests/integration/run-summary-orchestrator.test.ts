// tests/integration/run-summary-orchestrator.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";

const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";
const finding: Finding = {
  id: "F-1",
  signature: "sigX",
  severity: "CRITICAL",
  category: "security",
  rule_id: "r",
  file: "a.ts",
  line_start: 1,
  line_end: 1,
  message: "m",
  details: "d",
  reviewer: { provider: "codex", model: "m", persona: "security" },
  confidence: 0.9,
  consensus: "singleton",
};
function stub(findings: Finding[]): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      return {
        reviewerId: inp.reviewerId,
        verdict: findings.length ? "FAIL" : "PASS",
        findings,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.02, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        rawText: "",
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}
const config = {
  ...defaultConfig,
  cache: { enabled: false, reviewTtlDays: 7 },
  phases: {
    ...defaultConfig.phases,
    review: { reviewers: [{ provider: "codex" as const, persona: "security" }], scopeToDiff: true },
    critic: null,
    triage: null,
  },
};

describe("orchestrator IterationResult.summary", () => {
  it("returns a run summary with the verdict, source=panel, and per-provider findings", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-summ-"));
    const orch = new Orchestrator({
      repoRoot: repo,
      config,
      adapters: { codex: stub([finding]) },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
    });
    const result = await orch.runIteration({ runId: "RUN", iter: 1 });
    expect(result.summary.verdict).toBe(result.verdict);
    expect(result.summary.source).toBe("panel");
    expect(result.summary.providers.find((p) => p.provider === "codex")?.findings).toBe(1);
    expect(result.summary.cost_usd).toBeCloseTo(0.02);
  });

  it("a triage-skip (doc-only diff) returns source=skipped, empty providers", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-summ2-"));
    const orch = new Orchestrator({
      repoRoot: repo,
      config,
      adapters: { codex: stub([]) },
      sandboxMode: "off",
      hostTier: "opus",
      diff: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-x\n+y\n",
      reasonOnFailEnabled: true,
    });
    const result = await orch.runIteration({ runId: "RUN", iter: 1 });
    expect(result.summary.source).toBe("skipped");
    expect(result.summary.providers).toEqual([]);
  });
});
