// tests/unit/orchestrator-triage.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";

function stub(id: ProviderAdapter["id"]): ProviderAdapter {
  return {
    id,
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
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
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

describe("Orchestrator triage/research", () => {
  it("skips review for a doc-only diff (PASS, no reviewers)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-tri-"));
    writeFileSync(join(repo, "README.md"), "x");
    const orch = new Orchestrator({
      repoRoot: repo,
      config: defaultConfig,
      adapters: { codex: stub("codex") },
      sandboxMode: "off",
      hostTier: "opus",
      diff: "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n",
      reasonOnFailEnabled: true,
    });
    const r = await orch.runIteration({ runId: "RUN", iter: 1 });
    expect(r.verdict).toBe("PASS");
  });

  it("writes research.md for a code diff", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-tri2-"));
    writeFileSync(join(repo, "x.ts"), "export function f(){return 1;}");
    const orch = new Orchestrator({
      repoRoot: repo,
      config: defaultConfig,
      adapters: { codex: stub("codex") },
      sandboxMode: "off",
      hostTier: "opus",
      diff: "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n",
      reasonOnFailEnabled: true,
    });
    await orch.runIteration({ runId: "RUN", iter: 1 });
    expect(existsSync(join(repo, ".reviewgate", "research.md"))).toBe(true);
  });
});
