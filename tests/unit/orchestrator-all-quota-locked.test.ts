// tests/unit/orchestrator-all-quota-locked.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";

function quotaStub(id: ProviderAdapter["id"]): ProviderAdapter {
  return {
    id,
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
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

const DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

describe("orchestrator all-reviewers-quota-locked signal", () => {
  it("flags allReviewersQuotaLocked when every reviewer is quota-exhausted (no working fallback)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-allquota-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const config = {
      ...defaultConfig,
      phases: {
        ...defaultConfig.phases,
        // Only codex configured/enabled → no last-resort provider available.
        review: { reviewers: [{ provider: "codex" as const, persona: "security", fallback: [] }] },
        critic: null,
        triage: null,
      },
    };
    const orch = new Orchestrator({
      repoRoot: repo,
      config,
      adapters: { codex: quotaStub("codex") },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
    });
    const result = await orch.runIteration({ runId: "RUN", iter: 1 });
    expect(result.verdict).toBe("ERROR");
    expect(result.allReviewersQuotaLocked).toBe(true);
  });
});
