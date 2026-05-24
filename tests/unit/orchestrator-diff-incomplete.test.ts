// tests/unit/orchestrator-diff-incomplete.test.ts
// Phase 4 #3 — when the collected diff is partial (truncated/timed-out), the
// reviewer must be told so as TRUSTED context (BEFORE the untrusted-diff fence),
// not buried inside the fence where it reads as inert data to be ignored.
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

const diff = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

function orch(repo: string, seen: { prompt?: string }, diffIncomplete: boolean) {
  return new Orchestrator({
    repoRoot: repo,
    config: defineConfig({
      cache: { enabled: false, reviewTtlDays: 7 },
      phases: { triage: null },
    }),
    adapters: { codex: recordingStub(seen) },
    sandboxMode: "off",
    hostTier: "opus",
    diff,
    reasonOnFailEnabled: true,
    diffIncomplete,
  });
}

describe("Orchestrator diff-incompleteness warning", () => {
  it("injects a TRUSTED partial-diff warning BEFORE the untrusted fence", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-incomplete-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const seen: { prompt?: string } = {};
    await orch(repo, seen, true).runIteration({ runId: "RUN", iter: 1 });
    const prompt = seen.prompt ?? "";
    expect(prompt).toContain("Diff completeness");
    expect(prompt).toContain("INCOMPLETE");
    // Must appear BEFORE the untrusted-diff fence (so it isn't "inert data").
    const warnIdx = prompt.indexOf("Diff completeness");
    const fenceIdx = prompt.indexOf("<<UNTRUSTED_DIFF>>");
    expect(warnIdx).toBeGreaterThanOrEqual(0);
    expect(fenceIdx).toBeGreaterThanOrEqual(0);
    expect(warnIdx).toBeLessThan(fenceIdx);
  });

  it("omits the warning when the diff is complete", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-complete-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const seen: { prompt?: string } = {};
    await orch(repo, seen, false).runIteration({ runId: "RUN", iter: 1 });
    expect(seen.prompt ?? "").not.toContain("Diff completeness");
  });
});
