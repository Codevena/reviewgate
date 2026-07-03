// tests/unit/loop-driver-defer-incomplete-runs.test.ts
//
// F-02: the defer paths (handleAllQuotaLocked, handleInfraUnavailable) returned
// early WITHOUT resetting incomplete_runs, although the review genuinely
// completed (verdict ERROR). The schema documents incomplete_runs as "Reset to 0
// whenever a review actually completes (any verdict)", so a sequence
// timeout → defer → timeout could escalate "review-timeout … for 2 consecutive
// runs" across runs that were NOT consecutive.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import type { IterationResult } from "../../src/core/orchestrator.ts";
import { StateStore } from "../../src/core/state-store.ts";
import type { RunSummary } from "../../src/schemas/audit-event.ts";
import { auditDir, dirtyFlagPath } from "../../src/utils/paths.ts";

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-defer-inc-"));
  writeFileSync(join(dir, "foo.ts"), "x");
  return dir;
}

function writeDirty(repo: string): void {
  writeFileSync(
    dirtyFlagPath(repo),
    JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
  );
}

const ERROR_SUMMARY: RunSummary = {
  verdict: "ERROR",
  source: "panel",
  counts: { critical: 0, warn: 0, info: 0 },
  cost_usd: 0,
  duration_ms: 1,
  demoted: 0,
  signatures: [],
  providers: [],
};

const errorStub = (extra: Partial<IterationResult>) => ({
  runIteration: async (): Promise<IterationResult> => ({
    verdict: "ERROR" as const,
    costUsd: 0,
    durationMs: 1,
    signaturesThisIter: [],
    summary: ERROR_SUMMARY,
    ...extra,
  }),
});

describe("defer paths reset the incomplete-run streak (F-02)", () => {
  it("all-quota-locked defer resets incomplete_runs (the review completed)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXF02QUOTA");
    // A prior turn timed out (incomplete_runs=1); this turn completes but is
    // all-quota-capped → defer. The completed run must break the streak.
    await state.update((cur) => ({ ...cur, iteration: 2, incomplete_runs: 1 }));
    writeDirty(repo);
    const decision = await new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: errorStub({ allReviewersQuotaLocked: true }),
      stopHookActive: false,
      freshHeadSha: async () => null, // S3b: unused stub for pre-existing fixtures
    }).run();
    expect(decision.kind).toBe("allow_stop");
    expect(decision.reason).toMatch(/quota/i);
    const st = await state.load();
    expect(st.incomplete_runs).toBe(0); // streak broken — pre-fix this stayed 1
    expect(st.iteration).toBe(2); // defer still does not advance the iteration
  });

  it("bounded infra-defer resets incomplete_runs (the review completed)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXF02INFRA");
    await state.update((cur) => ({ ...cur, iteration: 1, incomplete_runs: 1 }));
    writeDirty(repo);
    const decision = await new LoopDriver({
      repoRoot: repo,
      config: {
        ...defaultConfig,
        loop: { ...defaultConfig.loop, infraDeferMaxConsecutive: 2 },
      },
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: errorStub({ allReviewersInfraFailed: true }),
      stopHookActive: false,
      freshHeadSha: async () => null, // S3b: unused stub for pre-existing fixtures
    }).run();
    expect(decision.kind).toBe("allow_stop");
    expect(decision.reason).toMatch(/DEFERRED/i);
    const st = await state.load();
    expect(st.incomplete_runs).toBe(0); // streak broken — pre-fix this stayed 1
    expect(st.consecutive_infra_defers).toBe(1); // defer still counted
  });
});
