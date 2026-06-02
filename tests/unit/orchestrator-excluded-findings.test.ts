// tests/unit/orchestrator-excluded-findings.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function fin(file: string, signature: string): Finding {
  return {
    id: "F",
    signature,
    severity: "CRITICAL",
    category: "security",
    rule_id: "r",
    file,
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
  };
}

function stub(findings: Finding[]): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      return {
        reviewerId: inp.reviewerId,
        verdict: "FAIL",
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

const DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

describe("orchestrator drops reviewer findings on excluded paths", () => {
  it("never surfaces a finding about .reviewgate/ (the gate's own infra)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-excl-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const config = {
      ...defaultConfig,
      phases: {
        ...defaultConfig.phases,
        review: { reviewers: [{ provider: "codex" as const, persona: "security" }] },
        critic: null,
        triage: null,
      },
    };
    const orch = new Orchestrator({
      repoRoot: repo,
      config,
      adapters: {
        codex: stub([fin("foo.ts", "real-sig"), fin(".reviewgate/bin/trigger", "infra-sig")]),
      },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
    });
    await orch.runIteration({ runId: "RUN", iter: 1 });
    const report = JSON.parse(readFileSync(join(repo, ".reviewgate", "pending.json"), "utf8")) as {
      findings: Array<{ file: string }>;
    };
    const files = report.findings.map((f) => f.file);
    expect(files).not.toContain(".reviewgate/bin/trigger"); // gate's own infra — dropped
    expect(files).toContain("foo.ts"); // the real finding survives
  });
});
