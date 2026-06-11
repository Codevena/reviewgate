// tests/unit/orchestrator-skip-fail-closed.test.ts
// F-12 — a diff-collection failure yields an empty (or marker-only) diff; triage
// then says runReview:false. The skip branch must NOT convert that into a silent
// PASS (the change would ship unreviewed — fail-open). Instead it returns ERROR
// with allReviewersInfraFailed, taking the LoopDriver's BOUNDED infra-defer path
// (keep dirty flag, no iteration burn, escalate after N consecutive defers) so a
// persistently failing `git diff` can never become an infinite block loop either.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "../../src/config/define-config.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";

function stub(calls: { n: number }): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      calls.n += 1;
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

function orch(repo: string, calls: { n: number }, diffIncomplete: boolean, diff = "") {
  return new Orchestrator({
    repoRoot: repo,
    config: defineConfig({ cache: { enabled: false, reviewTtlDays: 7 } }),
    adapters: { codex: stub(calls) },
    sandboxMode: "off",
    hostTier: "opus",
    diff,
    reasonOnFailEnabled: true,
    diffIncomplete,
  });
}

describe("Orchestrator triage-skip on an INCOMPLETE diff (F-12)", () => {
  it("fails CLOSED (ERROR + infra-defer flag), never a skip-PASS", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-skip-fc-"));
    const calls = { n: 0 };
    // Empty diff (the status-128 case: stdout discarded) + the gate's
    // diffIncomplete signal → triage parses zero files → runReview:false.
    const r = await orch(repo, calls, true).runIteration({ runId: "RUN", iter: 1 });
    expect(r.verdict).toBe("ERROR");
    // Bounded-defer posture (PR #63), NOT a hard block-loop:
    expect(r.allReviewersInfraFailed).toBe(true);
    expect(r.allReviewersQuotaLocked ?? false).toBe(false);
    expect(calls.n).toBe(0); // no reviewer was spawned on the empty diff
    // The report explains WHY (pending.md is what the agent/human reads).
    const pending = readFileSync(join(repo, ".reviewgate", "pending.md"), "utf8");
    expect(pending.toLowerCase()).toContain("incomplete");
  });

  it("still skip-PASSes a genuinely empty diff when collection was COMPLETE", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-skip-ok-"));
    const calls = { n: 0 };
    const r = await orch(repo, calls, false).runIteration({ runId: "RUN", iter: 1 });
    expect(r.verdict).toBe("PASS");
    expect(r.allReviewersInfraFailed ?? false).toBe(false);
    expect(calls.n).toBe(0);
  });
});
