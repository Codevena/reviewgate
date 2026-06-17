// tests/unit/orchestrator-unsettled.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";

const DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

function stub(): ProviderAdapter {
  const f: Finding = {
    id: "F",
    signature: "s",
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
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      return {
        reviewerId: inp.reviewerId,
        verdict: "FAIL",
        findings: [f],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

describe("orchestrator passes workspaceUnsettled into the report (#7)", () => {
  it("renders the not-quiescent banner when given workspaceUnsettled", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-orch-uns-"));
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
      adapters: { codex: stub() },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
      workspaceUnsettled: { last_write_ms_ago: 80, waited_ms: 1500 },
    });
    await orch.runIteration({ runId: "RUN", iter: 1 });
    const md = readFileSync(join(repo, ".reviewgate", "pending.md"), "utf8");
    expect(md).toContain("Workspace not quiescent");
    expect(md).toContain("80ms");
  });
});
