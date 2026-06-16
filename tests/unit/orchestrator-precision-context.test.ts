// tests/unit/orchestrator-precision-context.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import { auditDir } from "../../src/utils/paths.ts";

const DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

function critFinding(): Finding {
  return {
    id: "F",
    signature: "real-sig",
    severity: "CRITICAL",
    category: "security",
    rule_id: "r",
    file: "foo.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
  };
}

function stub(): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      return {
        reviewerId: inp.reviewerId,
        verdict: "FAIL",
        findings: [critFinding()],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

async function seedDecisions(repo: string, provider: string, tp: number, fp: number) {
  const audit = new AuditLogger(auditDir(repo));
  for (let i = 0; i < tp; i++)
    await audit.append({
      event: "decision.applied",
      run_id: "seed",
      iter: 1,
      trigger: "stop-hook",
      decision_outcome: {
        finding_id: `T${i}`,
        severity: "CRITICAL",
        bucket: "tp",
        providers: [provider],
      },
    });
  for (let i = 0; i < fp; i++)
    await audit.append({
      event: "decision.applied",
      run_id: "seed",
      iter: 1,
      trigger: "stop-hook",
      decision_outcome: {
        finding_id: `P${i}`,
        severity: "CRITICAL",
        bucket: "fp",
        providers: [provider],
      },
    });
}

function makeConfig(providerPrecisionContext: boolean) {
  return {
    ...defaultConfig,
    phases: {
      ...defaultConfig.phases,
      review: {
        reviewers: [{ provider: "codex" as const, persona: "security" }],
        providerPrecisionContext,
      },
      critic: null,
      triage: null,
    },
  };
}

describe("orchestrator annotates findings with provider precision (#8)", () => {
  it("renders the track-record line when the toggle is on and history exists", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-pp-orch-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    await seedDecisions(repo, "codex", 5, 2); // 5 TP / 2 FP → 71%, 7 samples ≥ 5
    const orch = new Orchestrator({
      repoRoot: repo,
      config: makeConfig(true),
      adapters: { codex: stub() },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
    });
    await orch.runIteration({ runId: "RUN", iter: 1 });
    const md = readFileSync(join(repo, ".reviewgate", "pending.md"), "utf8");
    expect(md).toContain("Reviewer track record:");
    expect(md).toContain("codex 71% (5 TP / 2 FP)");
  });

  it("does NOT annotate when the toggle is off", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-pp-orch-off-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    await seedDecisions(repo, "codex", 5, 2);
    const orch = new Orchestrator({
      repoRoot: repo,
      config: makeConfig(false),
      adapters: { codex: stub() },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
    });
    await orch.runIteration({ runId: "RUN", iter: 1 });
    const md = readFileSync(join(repo, ".reviewgate", "pending.md"), "utf8");
    expect(md).not.toContain("Reviewer track record:");
  });
});
