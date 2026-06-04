// tests/unit/orchestrator-ui-analysis.test.ts
// N7: with phases.review.uiAnalysis enabled, the reviewer prompt carries a static
// UI/CSS facts block resolving the changed file's Tailwind classes (gap-3 → 12px), so
// the reviewer reads computed values instead of guessing. OFF by default → no block.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "../../src/config/define-config.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";

function recordingStub(seen: { prompt?: string }): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      seen.prompt = readFileSync(inp.promptFile, "utf8");
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

const diff =
  "diff --git a/Widget.tsx b/Widget.tsx\n--- a/Widget.tsx\n+++ b/Widget.tsx\n@@ -1 +1 @@\n-a\n+b\n";

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "rg-uiorch-"));
  writeFileSync(
    join(repo, "Widget.tsx"),
    'export const W = () => <div className="flex gap-3 h-screen" />;\n',
  );
  return repo;
}

function orch(repo: string, seen: { prompt?: string }, enabled: boolean) {
  return new Orchestrator({
    repoRoot: repo,
    config: defineConfig({
      cache: { enabled: false, reviewTtlDays: 7 },
      phases: { triage: null, review: enabled ? { uiAnalysis: { enabled: true } } : {} },
    }),
    adapters: { codex: recordingStub(seen) },
    sandboxMode: "off",
    hostTier: "opus",
    diff,
    reasonOnFailEnabled: true,
  });
}

describe("Orchestrator UI analysis (N7)", () => {
  it("injects resolved Tailwind facts when enabled", async () => {
    const repo = makeRepo();
    const seen: { prompt?: string } = {};
    await orch(repo, seen, true).runIteration({ runId: "RUN", iter: 1 });
    const prompt = seen.prompt ?? "";
    expect(prompt).toContain("UI/CSS facts");
    expect(prompt).toContain("gap-3 → gap: 0.75rem (12px)");
  });

  it("omits the UI facts block when disabled (default)", async () => {
    const repo = makeRepo();
    const seen: { prompt?: string } = {};
    await orch(repo, seen, false).runIteration({ runId: "RUN", iter: 1 });
    expect(seen.prompt ?? "").not.toContain("UI/CSS facts");
  });
});
