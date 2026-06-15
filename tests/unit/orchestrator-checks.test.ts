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

  it("a failing check is NOT skipped by a prior cached PASS (checks run before the cache read)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-orch-chk-cache-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const sentinel = join(repo, "FAIL_SENTINEL");
    const state = { calls: 0 };
    // The check passes while the sentinel is ABSENT, fails once it EXISTS — same
    // command string both runs, so the diff+config cache key is identical.
    const run = `test ! -f ${sentinel}`;

    // Run 1: sentinel absent → check passes → panel runs → PASS gets cached.
    const r1 = await orch(repo, state, run).runIteration({ runId: "R", iter: 1 });
    expect(r1.verdict).toBe("PASS");
    expect(state.calls).toBe(1);

    // Control: an identical run is a cache HIT (panel NOT re-invoked) — proves the
    // PASS really was cached, so the next assertion is meaningful.
    const rHit = await orch(repo, state, run).runIteration({ runId: "R", iter: 2 });
    expect(rHit.verdict).toBe("PASS");
    expect(state.calls).toBe(1); // still 1 → cache hit, panel skipped

    // Now make the check FAIL on the SAME diff+config. If the checks tier ran AFTER
    // the cache read, the cached PASS would short-circuit and this would wrongly PASS.
    // Because checks run BEFORE the cache read, it must FAIL — fail-closed.
    writeFileSync(sentinel, "1");
    const r2 = await orch(repo, state, run).runIteration({ runId: "R", iter: 3 });
    expect(r2.verdict).toBe("FAIL");
    expect(state.calls).toBe(1); // panel still not re-invoked (short-circuited by failed check)
  });
});
