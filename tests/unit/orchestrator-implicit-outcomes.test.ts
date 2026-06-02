import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import { implicitOutcomesPath } from "../../src/utils/paths.ts";

function stub(id: ProviderAdapter["id"], findings: Finding[]): ProviderAdapter {
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
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

const outOfDiffFinding: Finding = {
  id: "F-1",
  signature: "ood-sig",
  severity: "WARN",
  category: "quality",
  rule_id: "r",
  file: "untouched.ts",
  line_start: 500,
  line_end: 500,
  message: "m",
  details: "d",
  reviewer: { provider: "codex", model: "m", persona: "security" },
  confidence: 0.9,
  consensus: "singleton",
};

function makeConfig(implicitEnabled: boolean) {
  return {
    ...defaultConfig,
    phases: {
      ...defaultConfig.phases,
      review: { reviewers: [{ provider: "codex" as const, persona: "security" }] },
      critic: null,
      triage: null,
      implicitOutcomes: { enabled: implicitEnabled, cap: 5000 },
    },
  };
}

const DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

describe("orchestrator implicit-outcomes side-write", () => {
  it("writes a scope_demoted outcome when enabled", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-io-orch-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const orch = new Orchestrator({
      repoRoot: repo,
      config: makeConfig(true),
      adapters: { codex: stub("codex", [outOfDiffFinding]) },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
    });
    await orch.runIteration({ runId: "RUN", iter: 1 });
    const lines = readFileSync(implicitOutcomesPath(repo), "utf8").trim().split("\n");
    const recs = lines.map((l) => JSON.parse(l));
    expect(recs.some((r) => r.signature === "ood-sig" && r.demote_reason === "scope_demoted")).toBe(
      true,
    );
    expect(recs[0].reviewer_key).toBe("codex:security");
  });

  it("writes NOTHING and leaves the verdict identical when disabled", async () => {
    const run = async (enabled: boolean) => {
      const repo = mkdtempSync(join(tmpdir(), `rg-io-orch-${enabled}-`));
      writeFileSync(join(repo, "foo.ts"), "x");
      const orch = new Orchestrator({
        repoRoot: repo,
        config: makeConfig(enabled),
        adapters: { codex: stub("codex", [outOfDiffFinding]) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: DIFF,
        reasonOnFailEnabled: true,
      });
      const res = await orch.runIteration({ runId: "RUN", iter: 1 });
      return { repo, verdict: res.verdict };
    };
    const off = await run(false);
    const on = await run(true);
    expect(existsSync(implicitOutcomesPath(off.repo))).toBe(false);
    expect(on.verdict).toBe(off.verdict);
  });
});
