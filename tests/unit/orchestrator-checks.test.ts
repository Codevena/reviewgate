// tests/unit/orchestrator-checks.test.ts
//
// The deterministic checker tier runs fail-fast BEFORE the cache read, research,
// and the LLM panel. A failing check short-circuits to verdict FAIL with the
// captured output and NEVER invokes the panel; a passing check lets the panel run
// unchanged. Mirrors the orchestrator unit-test shape in
// orchestrator-cache-key-inputs.test.ts (constructor fields + countingStub).
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "../../src/config/define-config.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";

function countingStub(state: { calls: number }): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      state.calls++;
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

function orch(repo: string, state: { calls: number }, run: string) {
  return new Orchestrator({
    repoRoot: repo,
    config: defineConfig({
      phases: {
        review: { reviewers: [{ provider: "codex", persona: "security" }] },
        triage: null,
        checks: { commands: [{ name: "typecheck", run, timeoutMs: 10000 }] },
      },
    }),
    adapters: { codex: countingStub(state) },
    sandboxMode: "off",
    hostTier: "opus",
    diff,
    reasonOnFailEnabled: true,
  });
}

describe("orchestrator deterministic checks tier", () => {
  it("a failing check short-circuits to FAIL and never invokes the panel", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-orch-chk-fail-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const state = { calls: 0 };
    const res = await orch(repo, state, "exit 1").runIteration({ runId: "R", iter: 1 });
    expect(res.verdict).toBe("FAIL");
    expect(state.calls).toBe(0);
  });

  it("a passing check lets the panel run as usual", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-orch-chk-pass-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const state = { calls: 0 };
    const res = await orch(repo, state, "true").runIteration({ runId: "R", iter: 1 });
    expect(res.verdict).toBe("PASS");
    expect(state.calls).toBe(1);
  });
});
