// tests/integration/cassette-pipeline.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReplayAdapter } from "../../src/cassette/replay-adapter.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { CassetteEntry } from "../../src/schemas/cassette.ts";

const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";

function cassetteEntry(): CassetteEntry {
  return {
    schema: "reviewgate.cassette.entry.v1",
    provider: "codex",
    key: "codex-security",
    method: "review",
    promptSha256: "0".repeat(64),
    result: {
      reviewerId: "codex-security",
      verdict: "FAIL",
      findings: [
        {
          id: "F-1",
          signature: "sigOOD",
          severity: "CRITICAL",
          category: "security",
          rule_id: "r",
          file: "a.ts",
          line_start: 50,
          line_end: 50,
          message: "m",
          details: "d",
          reviewer: { provider: "codex", model: "m", persona: "security" },
          confidence: 0.9,
          consensus: "singleton",
        },
      ],
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
      durationMs: 1,
      exitCode: 0,
      rawEventsPath: "",
      status: "ok",
    },
  };
}

describe("cassette → orchestrator pipeline (deterministic)", () => {
  it("Phase-A demotes a recorded out-of-diff finding to INFO (no LLM)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-caspipe-"));
    const config = {
      ...defaultConfig,
      cache: { enabled: false, reviewTtlDays: 7 },
      phases: {
        review: {
          reviewers: [{ provider: "codex" as const, persona: "security" }],
          scopeToDiff: true,
        },
        critic: null,
        triage: null,
      },
    };
    const orch = new Orchestrator({
      repoRoot: repo,
      config,
      adapters: { codex: new ReplayAdapter([cassetteEntry()], "codex") },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
    });
    const result = await orch.runIteration({ runId: "RUN", iter: 1 });
    expect(result.verdict).toBe("PASS"); // CRITICAL demoted to INFO → no blocking findings
    const report = JSON.parse(readFileSync(join(repo, ".reviewgate", "pending.json"), "utf8"));
    expect(report.findings[0].severity).toBe("INFO");
  });
});
