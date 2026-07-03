// tests/unit/contested-breaker.test.ts
//
// T6/R6 + T7/R7 (field report 2026-07-03). T6: the reject-rate-high breaker also
// fires on the CONTESTED rate (plain rejections + verified-not-applicable +
// suppressed region re-raises), not only reviewer_was_wrong rejections — which
// starved it through the field's ~8 FP-dominated rounds. T7: an FP-dominated
// round earns no convergence churn-credit, and the hard cap is maxIter+2.
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import type { ReviewgateConfig } from "../../src/config/define-config.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import type { IterationResult } from "../../src/core/orchestrator.ts";
import { StateStore } from "../../src/core/state-store.ts";
import type { RunSummary } from "../../src/schemas/audit-event.ts";
import { auditDir, decisionsPath, dirtyFlagPath, pendingJsonPath } from "../../src/utils/paths.ts";

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-contested-"));
  writeFileSync(join(dir, "a.ts"), "x");
  return dir;
}

function writeDirty(repo: string): void {
  writeFileSync(
    dirtyFlagPath(repo),
    JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
  );
}

const plainRejected = (id: string) => ({
  schema: "reviewgate.decision.v1",
  finding_id: id,
  verdict: "rejected",
  reason: "valid concern but does not apply here",
});
const vna = (id: string) => ({
  schema: "reviewgate.decision.v1",
  finding_id: id,
  verdict: "accepted",
  action: "verified-not-applicable",
  reason: "verified: the typed constant exists in lib/credits.ts",
});
const fixed = (id: string) => ({
  schema: "reviewgate.decision.v1",
  finding_id: id,
  verdict: "accepted",
  action: "fixed",
});

function writeIteration(repo: string, iter: number, decisions: object[]): void {
  writeFileSync(
    pendingJsonPath(repo),
    JSON.stringify({
      findings: decisions.map((d) => ({
        id: (d as { finding_id: string }).finding_id,
        severity: "WARN",
      })),
    }),
  );
  const dp = decisionsPath(repo, iter);
  mkdirSync(dirname(dp), { recursive: true });
  writeFileSync(dp, `${decisions.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

const failResult = (): IterationResult => ({
  verdict: "FAIL",
  costUsd: 0,
  durationMs: 1,
  signaturesThisIter: ["sig-x"],
  locationsThisIter: [],
  summary: {
    verdict: "FAIL",
    source: "panel",
    counts: { critical: 0, warn: 1, info: 0 },
    cost_usd: 0,
    duration_ms: 1,
    demoted: 0,
    from_critical_demoted: 0,
    signatures: [],
    providers: [],
  } as unknown as RunSummary,
});

function driverFor(repo: string, state: StateStore, config: ReviewgateConfig = defaultConfig) {
  return new LoopDriver({
    repoRoot: repo,
    config,
    state,
    audit: new AuditLogger(auditDir(repo)),
    orchestrator: { runIteration: async () => failResult() },
    stopHookActive: false,
    freshHeadSha: async () => null, // S3b: unused stub for pre-existing fixtures
  });
}

describe("contested-rate breaker (T6/R6)", () => {
  it("fires on 4 plain rejections (no reviewer_was_wrong flag) — rate 1.0 ≥ 0.7", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXCON1");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    writeIteration(repo, 1, [
      plainRejected("F-001"),
      plainRejected("F-002"),
      vna("F-003"),
      plainRejected("F-004"),
    ]);
    const decision = await driverFor(repo, state).run();
    expect(decision.reason).toContain("reject-rate-high");
    expect((await state.load()).escalation_reason).toBe("reject-rate-high");
  });

  it("fires at 3 contested of 4 (0.75 ≥ 0.7 default)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXCON2");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    writeIteration(repo, 1, [
      plainRejected("F-001"),
      plainRejected("F-002"),
      vna("F-003"),
      fixed("F-004"),
    ]);
    const decision = await driverFor(repo, state).run();
    expect(decision.reason).toContain("reject-rate-high");
  });

  it("stays silent at 2 contested of 4 (0.5 < 0.7)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXCON3");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    writeIteration(repo, 1, [
      plainRejected("F-001"),
      plainRejected("F-002"),
      fixed("F-003"),
      fixed("F-004"),
    ]);
    const decision = await driverFor(repo, state).run();
    expect(decision.reason).not.toContain("reject-rate-high");
  });

  it("region-suppression hits feed numerator AND denominator (suppression cannot starve the breaker)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXCON4");
    // Only 2 decisions this round (below the 4-sample floor) — but 3 suppressed
    // region re-raises this cycle push the combined sample to 5 and the rate to
    // (2+3)/(2+3) = 1.0 → fires. Without the hits it would stay silent.
    await state.update((cur) => ({ ...cur, iteration: 1, region_suppressed_hits: 3 }));
    writeDirty(repo);
    writeIteration(repo, 1, [plainRejected("F-001"), plainRejected("F-002")]);
    const decision = await driverFor(repo, state).run();
    expect(decision.reason).toContain("reject-rate-high");
  });

  it("flag off → old reviewer_was_wrong-only behavior (plain rejections stay silent)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXCON5");
    await state.update((cur) => ({ ...cur, iteration: 1 }));
    writeDirty(repo);
    writeIteration(repo, 1, [
      plainRejected("F-001"),
      plainRejected("F-002"),
      plainRejected("F-003"),
      plainRejected("F-004"),
    ]);
    const config = {
      ...defaultConfig,
      loop: { ...defaultConfig.loop, rejectRateCountsAllRejects: false },
    };
    const decision = await driverFor(repo, state, config).run();
    expect(decision.reason).not.toContain("reject-rate-high");
  });
});

describe("FP-churn guard + hard cap (T7/R7)", () => {
  // Reaching the convergence block needs iteration >= maxIter with histories set.
  function convergenceState(over: Record<string, unknown>) {
    return {
      iteration: 3, // == maxIterations default
      // 3 reviewed rounds with DIFFERENT signatures each (churn pattern).
      signature_history: [
        ["s1", "s2"],
        ["s3", "s4"],
        ["s5", "s6"],
      ],
      location_history: [["f:10"], ["f:20"], ["f:99"]], // latest has a NEW region
      iteration_stats: [
        { critical: 0, warn: 2, info: 0, cost_usd: 0, verdict: "FAIL" },
        { critical: 0, warn: 2, info: 0, cost_usd: 0, verdict: "FAIL" },
        { critical: 0, warn: 2, info: 0, cost_usd: 0, verdict: "FAIL" },
      ],
      fp_rejects_history: [0, 0],
      ...over,
    };
  }

  it("an FP-dominated MIXED round earns no churn credit → escalates at maxIter", async () => {
    // The pure churn signals: lastReal == prevReal (no signal 1), flat severity
    // (no signal 2), zero recurring signatures + a new region (signal 3 WOULD
    // grant churn credit) — but half the round's blocking findings were confirmed
    // FPs → fpChurnGuard denies the credit → max-iterations escalates at the cap.
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXCHURN1");
    await state.update((cur) => ({
      ...cur,
      ...convergenceState({
        signature_history: [
          ["s1", "s2"],
          ["s3", "s4"],
          ["s5", "s6", "s7", "s8"],
        ],
        iteration_stats: [
          { critical: 0, warn: 2, info: 0, cost_usd: 0, verdict: "FAIL" },
          { critical: 0, warn: 2, info: 0, cost_usd: 0, verdict: "FAIL" },
          { critical: 0, warn: 4, info: 0, cost_usd: 0, verdict: "FAIL" },
        ],
      }),
    }));
    writeDirty(repo);
    // Latest round: 4 blocking; 2 rejected reviewer_was_wrong + 2 fixed →
    // latestWrong (2) >= ceil(4/2) → FP-dominated; lastReal = 4-2 = 2 = prevReal.
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          { id: "F-001", severity: "WARN" },
          { id: "F-002", severity: "WARN" },
          { id: "F-003", severity: "WARN" },
          { id: "F-004", severity: "WARN" },
        ],
      }),
    );
    const dp = decisionsPath(repo, 3);
    mkdirSync(dirname(dp), { recursive: true });
    const wrong = (id: string) => ({
      schema: "reviewgate.decision.v1",
      finding_id: id,
      verdict: "rejected",
      reason: "hallucinated: the code path does not exist",
      reviewer_was_wrong: true,
    });
    writeFileSync(
      dp,
      `${[wrong("F-001"), wrong("F-002"), fixed("F-003"), fixed("F-004")].map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
    const decision = await driverFor(repo, state).run();
    expect(decision.reason).toContain("ESCALATED");
    expect((await state.load()).escalation_reason).toBe("max-iterations");
  });

  it("the same MIXED round with fpChurnGuard off keeps the churn credit (loop extends)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXCHURN1B");
    await state.update((cur) => ({
      ...cur,
      ...convergenceState({
        signature_history: [
          ["s1", "s2"],
          ["s3", "s4"],
          ["s5", "s6", "s7", "s8"],
        ],
        iteration_stats: [
          { critical: 0, warn: 2, info: 0, cost_usd: 0, verdict: "FAIL" },
          { critical: 0, warn: 2, info: 0, cost_usd: 0, verdict: "FAIL" },
          { critical: 0, warn: 4, info: 0, cost_usd: 0, verdict: "FAIL" },
        ],
      }),
    }));
    writeDirty(repo);
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          { id: "F-001", severity: "WARN" },
          { id: "F-002", severity: "WARN" },
          { id: "F-003", severity: "WARN" },
          { id: "F-004", severity: "WARN" },
        ],
      }),
    );
    const dp = decisionsPath(repo, 3);
    mkdirSync(dirname(dp), { recursive: true });
    const wrong = (id: string) => ({
      schema: "reviewgate.decision.v1",
      finding_id: id,
      verdict: "rejected",
      reason: "hallucinated: the code path does not exist",
      reviewer_was_wrong: true,
    });
    writeFileSync(
      dp,
      `${[wrong("F-001"), wrong("F-002"), fixed("F-003"), fixed("F-004")].map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
    const config = { ...defaultConfig, loop: { ...defaultConfig.loop, fpChurnGuard: false } };
    const decision = await driverFor(repo, state, config).run();
    expect((await state.load()).escalation_reason).toBeNull();
  });

  it("the same churn round with 0 FP rejects still earns credit (loop extends)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXCHURN2");
    await state.update((cur) => ({ ...cur, ...convergenceState({}) }));
    writeDirty(repo);
    // Latest round's findings both FIXED — real churn progress, no FP domination.
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          { id: "F-001", severity: "WARN" },
          { id: "F-002", severity: "WARN" },
        ],
      }),
    );
    const dp = decisionsPath(repo, 3);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(
      dp,
      `${[fixed("F-001"), fixed("F-002")].map((l) => JSON.stringify(l)).join("\n")}\n`,
    );
    const decision = await driverFor(repo, state).run();
    // No escalation — the run proceeds to a (stub) review round instead.
    expect((await state.load()).escalation_reason).toBeNull();
  });

  it("hard cap is maxIter+2: iteration 5 escalates even while churn-progressing", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXCHURN3");
    await state.update((cur) => ({
      ...cur,
      ...convergenceState({
        iteration: 5, // maxIter(3) + 2
        signature_history: [["s1"], ["s2"], ["s3"], ["s4"], ["s5"]],
        location_history: [["f:10"], ["f:20"], ["f:30"], ["f:40"], ["f:99"]],
        iteration_stats: Array.from({ length: 5 }, () => ({
          critical: 0,
          warn: 1,
          info: 0,
          cost_usd: 0,
          verdict: "FAIL",
        })),
        fp_rejects_history: [0, 0, 0, 0],
      }),
    }));
    writeDirty(repo);
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({ findings: [{ id: "F-001", severity: "WARN" }] }),
    );
    const dp = decisionsPath(repo, 5);
    mkdirSync(dirname(dp), { recursive: true });
    writeFileSync(dp, `${JSON.stringify(fixed("F-001"))}\n`);
    const decision = await driverFor(repo, state).run();
    expect(decision.reason).toContain("ESCALATED");
    expect((await state.load()).escalation_reason).toBe("max-iterations");
    const fs = await import("node:fs");
    const esc = fs.readFileSync(join(repo, ".reviewgate", "ESCALATION.md"), "utf8");
    expect(esc).toContain("hard cap of 5");
  });
});
