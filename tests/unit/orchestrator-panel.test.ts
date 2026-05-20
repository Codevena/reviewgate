// tests/unit/orchestrator-panel.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";

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

function f(sig: string, provider: string, persona: string): Finding {
  return {
    id: "F-1",
    signature: sig,
    severity: "WARN",
    category: "security",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider, model: "m", persona },
    confidence: 0.8,
    consensus: "singleton",
  };
}

describe("Orchestrator panel", () => {
  it("runs two reviewers in parallel and marks a shared finding as majority", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-panel-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const config = {
      ...defaultConfig,
      providers: {
        ...defaultConfig.providers,
        gemini: { enabled: true, auth: "oauth" as const, model: "gemini-3-pro", timeoutMs: 1000 },
      },
      phases: {
        review: {
          reviewers: [
            { provider: "codex" as const, persona: "security" },
            { provider: "gemini" as const, persona: "architecture" },
          ],
        },
        critic: null,
      },
    };
    const orch = new Orchestrator({
      repoRoot: repo,
      config,
      adapters: {
        codex: stub("codex", [f("shared", "codex", "security")]),
        gemini: stub("gemini", [f("shared", "gemini", "architecture")]),
      },
      sandboxMode: "off",
      hostTier: "opus",
      diff: "--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n",
      reasonOnFailEnabled: true,
    });
    const result = await orch.runIteration({ runId: "RUN", iter: 1 });
    expect(["FAIL", "SOFT-PASS"]).toContain(result.verdict);
    expect(existsSync(join(repo, ".reviewgate", "pending.json"))).toBe(true);
    const report = JSON.parse(readFileSync(join(repo, ".reviewgate", "pending.json"), "utf8"));
    expect(report.reviewers.length).toBe(2);
    expect(report.findings[0].consensus).toBe("majority");
  });
});
