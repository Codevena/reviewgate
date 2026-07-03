// tests/unit/gate-deadline.test.ts
//
// The gate must give itself a deadline strictly below the Stop-hook timeout. If
// a review can't finish in time it aborts the in-flight work and FAILS CLOSED
// (block "review did not complete — re-run") instead of being killed silently by
// Claude Code (which is non-blocking → fail-open). Repeated incompletes escalate.
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import type { IterationResult } from "../../src/core/orchestrator.ts";
import { StateStore } from "../../src/core/state-store.ts";
import type { RunSummary } from "../../src/schemas/audit-event.ts";
import { auditDir, dirtyFlagPath, pendingJsonPath, pendingMdPath } from "../../src/utils/paths.ts";

const PASS_SUMMARY: RunSummary = {
  verdict: "PASS",
  source: "panel",
  counts: { critical: 0, warn: 0, info: 0 },
  cost_usd: 0,
  duration_ms: 1,
  demoted: 0,
  signatures: [],
  providers: [],
};

const PASS_RESULT: IterationResult = {
  verdict: "PASS",
  costUsd: 0,
  durationMs: 1,
  signaturesThisIter: [],
  summary: PASS_SUMMARY,
};

// runIteration takes `delayMs`, but rejects promptly when its AbortSignal fires —
// so the deadline race can cut it short and we can assert it was actually aborted.
class SlowOrchestrator {
  aborted = false;
  constructor(private readonly delayMs: number) {}
  runIteration(opts: {
    runId: string;
    iter: number;
    signal?: AbortSignal;
  }): Promise<IterationResult> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve(PASS_RESULT), this.delayMs);
      opts.signal?.addEventListener("abort", () => {
        this.aborted = true;
        clearTimeout(t);
        reject(new Error("aborted"));
      });
    });
  }
}

// Models a run whose panel + writeReport COMPLETED, with only bounded
// post-verdict bookkeeping (curator/cache) overrunning the deadline: it ignores
// the abort and resolves a real verdict slightly after the deadline fired.
// A COMPLETED, FULL-COVERAGE PASS (the configured codex reviewer actually ran ok), so the
// pass is NOT labelled PRELIMINARY — distinct from PASS_SUMMARY's empty providers (which the
// timeout/incomplete tests reuse). This makes the stub match this test's stated intent ("the
// review actually completed") so the P4 preliminary "did not complete" WHY does not fire.
const PASS_RESULT_COVERED: IterationResult = {
  ...PASS_RESULT,
  summary: {
    ...PASS_SUMMARY,
    providers: [
      {
        provider: "codex",
        personas: ["security"],
        runs: 1,
        errors: 0,
        findings: 0,
        demoted: 0,
        cost_usd: 0,
        duration_ms: 1,
      },
    ],
  },
};

class VerdictDoneOrchestrator {
  async runIteration(_opts: {
    runId: string;
    iter: number;
    signal?: AbortSignal;
  }): Promise<IterationResult> {
    await new Promise((r) => setTimeout(r, 120));
    return PASS_RESULT_COVERED;
  }
}

class FastOrchestrator {
  runIteration(_opts: {
    runId: string;
    iter: number;
    signal?: AbortSignal;
  }): Promise<IterationResult> {
    return Promise.resolve(PASS_RESULT);
  }
}

// Models the worst case: a run that IGNORES the abort signal and NEVER settles
// (a reviewer subprocess that won't die, or unbounded post-verdict work). Without
// a post-abort settle cap, `await runP` hangs past the OS Stop-hook kill = silent
// fail-open. The cap must convert this into a fail-closed "did not complete".
class HungOrchestrator {
  runIteration(_opts: {
    runId: string;
    iter: number;
    signal?: AbortSignal;
  }): Promise<IterationResult> {
    return new Promise(() => {}); // never resolves, never rejects, ignores abort
  }
}

function repoWithDirty(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-deadline-"));
  return dir;
}

function withDeadline(ms: number) {
  return { ...defaultConfig, loop: { ...defaultConfig.loop, runTimeoutMs: ms } };
}

function writeDirty(repo: string): void {
  writeFileSync(
    dirtyFlagPath(repo),
    JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
  );
}

describe("LoopDriver self-deadline (fail-closed on incomplete review)", () => {
  it("blocks and aborts the review when it exceeds runTimeoutMs", async () => {
    const repo = repoWithDirty();
    const state = new StateStore(repo);
    await state.initialise("01HXQDL1");
    writeDirty(repo);
    const orch = new SlowOrchestrator(10_000);
    const driver = new LoopDriver({
      repoRoot: repo,
      config: withDeadline(50),
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: orch,
      stopHookActive: false,
      freshHeadSha: async () => null, // S3b: unused stub for pre-existing fixtures
    });
    const decision = await driver.run();
    expect(decision.kind).toBe("block");
    expect(decision.reason.toLowerCase()).toContain("did not complete");
    // Sub-second deadlines must read as "50ms", not a rounded-down "0s".
    expect(decision.reason).toContain("50ms");
    expect(orch.aborted).toBe(true);
    const st = await state.load();
    expect(st.incomplete_runs).toBe(1);
    // No review round happened → iteration must NOT advance.
    expect(st.iteration).toBe(0);
    // dirty.flag kept so the next stop re-reviews the SAME diff.
    expect(existsSync(dirtyFlagPath(repo))).toBe(true);
  });

  it("escalates (review-timeout) on the 2nd consecutive incomplete review", async () => {
    const repo = repoWithDirty();
    const state = new StateStore(repo);
    await state.initialise("01HXQDL2");
    await state.update((cur) => ({ ...cur, incomplete_runs: 1 }));
    writeDirty(repo);
    const driver = new LoopDriver({
      repoRoot: repo,
      config: withDeadline(50),
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: new SlowOrchestrator(10_000),
      stopHookActive: false,
      freshHeadSha: async () => null, // S3b: unused stub for pre-existing fixtures
    });
    const decision = await driver.run();
    expect(decision.reason).toContain("ESCALATED");
    expect(decision.reason).toContain("review-timeout");
    const st = await state.load();
    expect(st.escalated).toBe(true);
    expect(st.escalation_reason).toBe("review-timeout");
  });

  it("resets incomplete_runs to 0 once a review completes", async () => {
    const repo = repoWithDirty();
    const state = new StateStore(repo);
    await state.initialise("01HXQDL3");
    await state.update((cur) => ({ ...cur, incomplete_runs: 1 }));
    writeDirty(repo);
    const driver = new LoopDriver({
      repoRoot: repo,
      config: withDeadline(5_000),
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: new FastOrchestrator(),
      stopHookActive: false,
      freshHeadSha: async () => null, // S3b: unused stub for pre-existing fixtures
    });
    await driver.run();
    const st = await state.load();
    expect(st.incomplete_runs).toBe(0);
  });

  it("clears any pending report on an incomplete run (no stale 'completed' report)", async () => {
    const repo = repoWithDirty();
    const state = new StateStore(repo);
    await state.initialise("01HXQDL6");
    writeDirty(repo);
    // A completed report from before the timed-out re-review must not linger,
    // or the gate says "incomplete — re-run" while a full report sits on disk.
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({ findings: [], counts: { critical: 0, warn: 0, info: 0 } }),
    );
    writeFileSync(pendingMdPath(repo), "# stale completed report\n");
    const driver = new LoopDriver({
      repoRoot: repo,
      config: withDeadline(50),
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: new SlowOrchestrator(10_000),
      stopHookActive: false,
      freshHeadSha: async () => null, // S3b: unused stub for pre-existing fixtures
    });
    await driver.run();
    expect(existsSync(pendingJsonPath(repo))).toBe(false);
    expect(existsSync(pendingMdPath(repo))).toBe(false);
  });

  it("does not instantly re-escalate after a commit recovers a review-timeout escalation", async () => {
    const repo = repoWithDirty();
    const state = new StateStore(repo);
    await state.initialise("01HXQDL7");
    await state.update((cur) => ({
      ...cur,
      escalated: true,
      escalation_reason: "review-timeout" as const,
      escalation_announced: true,
      incomplete_runs: 2,
      last_reviewed_head_sha: "0000000000000000000000000000000000000000",
    }));
    writeDirty(repo);
    const driver = new LoopDriver({
      repoRoot: repo,
      config: withDeadline(50),
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: new SlowOrchestrator(10_000),
      stopHookActive: false,
      freshHeadSha: async () => null, // S3b: unused stub for pre-existing fixtures
      headSha: "1111111111111111111111111111111111111111",
    });
    const decision = await driver.run();
    // The commit re-armed the budget → the FIRST timeout in the new cycle must
    // BLOCK (re-run), not jump straight back to escalation on a stale counter.
    expect(decision.reason).not.toContain("ESCALATED");
    expect(decision.reason.toLowerCase()).toContain("did not complete");
    const st = await state.load();
    expect(st.incomplete_runs).toBe(1);
  });

  it("honors a verdict that completed even if post-verdict work overran the deadline", async () => {
    const repo = repoWithDirty();
    const state = new StateStore(repo);
    await state.initialise("01HXQDL8");
    writeDirty(repo);
    const driver = new LoopDriver({
      repoRoot: repo,
      config: withDeadline(50),
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: new VerdictDoneOrchestrator(),
      stopHookActive: false,
      freshHeadSha: async () => null, // S3b: unused stub for pre-existing fixtures
    });
    const decision = await driver.run();
    // The review actually completed (PASS) — only bounded gravy overran. It must
    // NOT be reclassified as "did not complete".
    expect(decision.kind).toBe("allow_stop");
    expect(decision.reason).not.toContain("did not complete");
    const st = await state.load();
    expect(st.incomplete_runs).toBe(0);
    expect(existsSync(dirtyFlagPath(repo))).toBe(false);
  });

  it("fails closed if the run never settles after abort (post-abort settle cap, M-A0.3)", async () => {
    const repo = repoWithDirty();
    const state = new StateStore(repo);
    await state.initialise("01HXQDLA");
    writeDirty(repo);
    const driver = new LoopDriver({
      repoRoot: repo,
      config: withDeadline(50),
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: new HungOrchestrator(),
      stopHookActive: false,
      freshHeadSha: async () => null, // S3b: unused stub for pre-existing fixtures
      // Tiny cap so the test doesn't wait the 30s default.
      postAbortSettleMs: 60,
    });
    const decision = await driver.run();
    expect(decision.kind).toBe("block");
    expect(decision.reason.toLowerCase()).toContain("did not complete");
    const st = await state.load();
    expect(st.incomplete_runs).toBe(1);
  }, 5_000);

  it("imposes no deadline when runTimeoutMs is 0 (disabled)", async () => {
    const repo = repoWithDirty();
    const state = new StateStore(repo);
    await state.initialise("01HXQDL4");
    writeDirty(repo);
    const orch = new SlowOrchestrator(80);
    const driver = new LoopDriver({
      repoRoot: repo,
      config: withDeadline(0),
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: orch,
      stopHookActive: false,
      freshHeadSha: async () => null, // S3b: unused stub for pre-existing fixtures
    });
    const decision = await driver.run();
    expect(orch.aborted).toBe(false);
    expect(decision.kind).toBe("allow_stop");
  });
});
