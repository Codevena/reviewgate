// tests/unit/loop-driver-region-harvest.test.ts
//
// T3 / R4 (field report 2026-07-03): the loop-driver harvests this iteration's
// dispositions into cycle-scoped region memory BEFORE spawning the next panel,
// passes it to runIteration (→ aggregate's region-rejection pass), accumulates
// the aggregator's suppression counter, and clears everything on re-arm.
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import type { IterationResult } from "../../src/core/orchestrator.ts";
import type { CycleRegion } from "../../src/core/region-memory.ts";
import { StateStore } from "../../src/core/state-store.ts";
import type { RunSummary } from "../../src/schemas/audit-event.ts";
import { auditDir, decisionsPath, dirtyFlagPath, pendingJsonPath } from "../../src/utils/paths.ts";

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-regionharvest-"));
  writeFileSync(join(dir, "a.ts"), "x");
  return dir;
}

function summary(verdict: string): RunSummary {
  return {
    verdict,
    source: "panel",
    counts: { critical: 0, warn: verdict === "FAIL" ? 1 : 0, info: 0 },
    cost_usd: 0,
    duration_ms: 1,
    demoted: 0,
    from_critical_demoted: 0,
    signatures: [],
    providers: [],
  } as unknown as RunSummary;
}

const PENDING_FINDING = {
  id: "F-001",
  severity: "WARN",
  category: "correctness",
  rule_id: "stale-effect-dependency",
  file: "app/content.tsx",
  line_start: 100,
  line_end: 104,
  message: "stale dep",
  details: "details",
  reviewer: { provider: "openrouter", model: "m", persona: "quality" },
  confidence: 0.9,
  consensus: "singleton",
  signature: "sig-old",
};

function writeIterationArtifacts(repo: string, iter: number): void {
  writeFileSync(
    pendingJsonPath(repo),
    JSON.stringify({ findings: [PENDING_FINDING], counts: { critical: 0, warn: 1, info: 0 } }),
  );
  const dp = decisionsPath(repo, iter);
  mkdirSync(dirname(dp), { recursive: true });
  writeFileSync(
    dp,
    `${JSON.stringify({
      schema: "reviewgate.decision.v1",
      finding_id: "F-001",
      verdict: "rejected",
      reason: "the cleanup above already clears the param — reviewer misread it",
      reviewer_was_wrong: true,
    })}\n`,
  );
}

describe("loop-driver region harvest wiring", () => {
  it("harvests a rejection into cycle_rejected_regions and passes it to runIteration", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXRH1");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeFileSync(
      dirtyFlagPath(repo),
      JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
    );
    writeIterationArtifacts(repo, 1);

    let received: CycleRegion[] | undefined;
    const stub = {
      runIteration: async (opts: { cycleRejectedRegions?: CycleRegion[] }) => {
        received = opts.cycleRejectedRegions;
        return {
          verdict: "FAIL" as const,
          costUsd: 0,
          durationMs: 1,
          signaturesThisIter: ["sig-new"],
          locationsThisIter: [],
          regionSuppressedThisIter: 2,
          summary: summary("FAIL"),
        } satisfies IterationResult;
      },
    };
    await new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: stub,
      stopHookActive: false,
    }).run();

    expect(received?.length).toBe(1);
    expect(received?.[0]).toMatchObject({
      file: "app/content.tsx",
      start_line: 100,
      end_line: 104,
      severity: "WARN",
      distinct_count: 1,
    });
    const st = await state.load();
    expect(st.cycle_rejected_dispositions.length).toBe(1);
    expect(st.cycle_rejected_dispositions[0]?.key).toBe("1:F-001");
    // Per-iteration semantics: the counter records the LATEST round's suppressions.
    expect(st.region_suppressed_hits).toBe(2);
  });

  it("a PASS re-arm clears the harvested regions and the suppression counter", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXRH2");
    // Pre-seed region memory + ONE suppression hit. Deliberately below the
    // contested-breaker thresholds (a rejection here would put contested+hits at
    // 4/4 = 1.0 and correctly escalate before the review — its own test): the
    // prior finding is dispositioned FIXED, so contested = 0+1 of 1+1 = 0.5 < 0.7.
    await state.update((cur) => ({
      ...cur,
      iteration: 1,
      region_suppressed_hits: 1,
      cycle_rejected_dispositions: [
        {
          key: "0:F-009",
          file: "app/content.tsx",
          start_line: 100,
          end_line: 104,
          severity: "WARN" as const,
          categories: ["correctness" as const],
          reason: "seeded disposition from an earlier iteration",
        },
      ],
    }));
    writeFileSync(
      dirtyFlagPath(repo),
      JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
    );
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({ findings: [PENDING_FINDING], counts: { critical: 0, warn: 1, info: 0 } }),
    );
    const dp = decisionsPath(repo, 1);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(
      dp,
      `${JSON.stringify({
        schema: "reviewgate.decision.v1",
        finding_id: "F-001",
        verdict: "accepted",
        action: "fixed",
      })}\n`,
    );
    const stub = {
      runIteration: async () => ({
        verdict: "PASS" as const,
        costUsd: 0,
        durationMs: 1,
        signaturesThisIter: [],
        locationsThisIter: [],
        summary: summary("PASS"),
      }),
    };
    await new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: stub,
      stopHookActive: false,
    }).run();
    const st = await state.load();
    expect(st.cycle_rejected_dispositions).toEqual([]);
    expect(st.cycle_addressed_dispositions).toEqual([]);
    expect(st.region_suppressed_hits).toBe(0);
  });
});
