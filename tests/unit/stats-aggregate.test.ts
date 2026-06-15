// tests/unit/stats-aggregate.test.ts
import { describe, expect, it } from "bun:test";
import type { DecisionOutcome } from "../../src/schemas/audit-event.ts";
import { aggregate } from "../../src/stats/aggregate.ts";
import type { BrainEntryLite, FpEntryLite } from "../../src/stats/aggregate.ts";
import type { LoadedRun } from "../../src/stats/load.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const panelFailRun: LoadedRun = {
  ts: "2026-01-01T10:00:00.000Z",
  run_id: "run-1",
  iter: 1,
  summary: {
    verdict: "FAIL",
    source: "panel",
    counts: { critical: 1, warn: 1, info: 0 },
    cost_usd: 0.02,
    duration_ms: 100,
    demoted: 1,
    signatures: ["sigA", "sigB"],
    providers: [
      {
        provider: "codex",
        personas: ["security"],
        runs: 1,
        errors: 0,
        findings: 2,
        demoted: 1,
        cost_usd: 0.02,
        duration_ms: 100,
      },
    ],
  },
};

const panelPassRun: LoadedRun = {
  ts: "2026-01-01T11:00:00.000Z",
  run_id: "run-2",
  iter: 2,
  summary: {
    verdict: "PASS",
    source: "panel",
    counts: { critical: 0, warn: 0, info: 0 },
    cost_usd: 0,
    duration_ms: 50,
    demoted: 0,
    signatures: [],
    providers: [
      {
        provider: "codex",
        personas: [],
        runs: 1,
        errors: 1,
        findings: 0,
        demoted: 0,
        cost_usd: 0,
        duration_ms: 50,
      },
    ],
  },
};

const cachePassRun: LoadedRun = {
  ts: "2026-01-01T12:00:00.000Z",
  run_id: "run-3",
  iter: 3,
  summary: {
    verdict: "PASS",
    source: "cache",
    counts: { critical: 0, warn: 0, info: 0 },
    cost_usd: 0,
    duration_ms: 0,
    demoted: 0,
    signatures: [],
    providers: [],
  },
};

const skippedRun: LoadedRun = {
  ts: "2026-01-01T13:00:00.000Z",
  run_id: "run-4",
  iter: 4,
  summary: {
    verdict: "PASS",
    source: "skipped",
    counts: { critical: 0, warn: 0, info: 0 },
    cost_usd: 0,
    duration_ms: 0,
    demoted: 0,
    signatures: [],
    providers: [],
  },
};

const allRuns: LoadedRun[] = [panelFailRun, panelPassRun, cachePassRun, skippedRun];

const fpEntries: FpEntryLite[] = [
  { stage: "active", rejects: [{ provider: "codex" }, { provider: "codex" }] },
  { stage: "sticky", rejects: [{ provider: "openrouter" }] },
];

const brainEntries: BrainEntryLite[] = [
  { status: "active", type: "convention" },
  { status: "candidate", type: "convention" },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("aggregate", () => {
  describe("window", () => {
    it("runCount is total across all sources", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      expect(report.window.runCount).toBe(4);
    });

    it("bySource breakdown is correct", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      expect(report.window.bySource).toEqual({ panel: 2, cache: 1, skipped: 1, checks: 0 });
    });

    it("firstTs is the earliest ts", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      expect(report.window.firstTs).toBe("2026-01-01T10:00:00.000Z");
    });

    it("lastTs is the latest ts", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      expect(report.window.lastTs).toBe("2026-01-01T13:00:00.000Z");
    });

    it("firstTs/lastTs are null when no runs", () => {
      const report = aggregate([], 0, [], []);
      expect(report.window.firstTs).toBeNull();
      expect(report.window.lastTs).toBeNull();
    });
  });

  describe("verdicts", () => {
    it("counts verdicts over ALL runs", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      expect(report.verdicts).toEqual({
        PASS: 3,
        "SOFT-PASS": 0,
        FAIL: 1,
        ERROR: 0,
      });
    });
  });

  describe("escalationRate", () => {
    it("is escalationCount / runCount", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      expect(report.escalationRate).toBeCloseTo(0.25);
    });

    it("is 0 when no runs", () => {
      const report = aggregate([], 0, [], []);
      expect(report.escalationRate).toBe(0);
    });
  });

  describe("cost (panel runs only)", () => {
    it("total equals sum of panel run costs", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      expect(report.cost.total).toBeCloseTo(0.02);
    });

    it("avgPerRun is total / panel run count", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      expect(report.cost.avgPerRun).toBeCloseTo(0.01);
    });

    it("perProvider sums codex cost across panel runs", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      expect(report.cost.perProvider.codex).toBeCloseTo(0.02);
    });

    it("total is 0 when no runs", () => {
      const report = aggregate([], 0, [], []);
      expect(report.cost.total).toBe(0);
      expect(report.cost.avgPerRun).toBe(0);
    });
  });

  describe("providers (panel runs only)", () => {
    it("has one codex entry", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      expect(report.providers).toHaveLength(1);
      expect(report.providers[0]?.provider).toBe("codex");
    });

    it("runs = total runs across panel runs", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      expect(report.providers[0]?.runs).toBe(2);
    });

    it("findings = sum across panel runs", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      expect(report.providers[0]?.findings).toBe(2);
    });

    it("demoteRate = Σdemoted / Σfindings", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      // demoted=1, findings=2 → 0.5
      expect(report.providers[0]?.demoteRate).toBeCloseTo(0.5);
    });

    it("errorRate = Σerrors / Σruns", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      // errors=1, runs=2 → 0.5
      expect(report.providers[0]?.errorRate).toBeCloseTo(0.5);
    });

    it("avgDurationMs is mean across panel runs", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      // (100 + 50) / 2 = 75
      expect(report.providers[0]?.avgDurationMs).toBeCloseTo(75);
    });

    it("cost is total codex cost", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      expect(report.providers[0]?.cost).toBeCloseTo(0.02);
    });

    it("avgDurationMs is per-run (Σduration / Σruns), consistent with the displayed runs column", () => {
      // Failover scenario from F-054: one appearance failed over twice
      // (runs=3, duration=90000), the other ran once (runs=1, duration=30000).
      // Displayed runs = 4; per-run mean must be 120000/4 = 30000,
      // NOT the per-appearance mean of (90000+30000)/2 = 60000.
      const failoverRunA: LoadedRun = {
        ts: "2026-03-01T10:00:00.000Z",
        run_id: "fo-1",
        iter: 1,
        summary: {
          verdict: "PASS",
          source: "panel",
          counts: { critical: 0, warn: 0, info: 0 },
          cost_usd: 0,
          duration_ms: 90000,
          demoted: 0,
          signatures: [],
          providers: [
            {
              provider: "codex",
              personas: [],
              runs: 3,
              errors: 0,
              findings: 0,
              demoted: 0,
              cost_usd: 0,
              duration_ms: 90000,
            },
          ],
        },
      };
      const failoverRunB: LoadedRun = {
        ts: "2026-03-01T11:00:00.000Z",
        run_id: "fo-2",
        iter: 2,
        summary: {
          verdict: "PASS",
          source: "panel",
          counts: { critical: 0, warn: 0, info: 0 },
          cost_usd: 0,
          duration_ms: 30000,
          demoted: 0,
          signatures: [],
          providers: [
            {
              provider: "codex",
              personas: [],
              runs: 1,
              errors: 0,
              findings: 0,
              demoted: 0,
              cost_usd: 0,
              duration_ms: 30000,
            },
          ],
        },
      };
      const report = aggregate([failoverRunA, failoverRunB], 0, [], []);
      const codex = report.providers.find((p) => p.provider === "codex");
      expect(codex?.runs).toBe(4);
      expect(codex?.avgDurationMs).toBeCloseTo(30000);
    });

    it("avgDurationMs is 0 when a provider has zero runs (no divide-by-zero)", () => {
      const zeroRunsRun: LoadedRun = {
        ts: "2026-03-02T10:00:00.000Z",
        run_id: "zr-1",
        iter: 1,
        summary: {
          verdict: "PASS",
          source: "panel",
          counts: { critical: 0, warn: 0, info: 0 },
          cost_usd: 0,
          duration_ms: 0,
          demoted: 0,
          signatures: [],
          providers: [
            {
              provider: "codex",
              personas: [],
              runs: 0,
              errors: 0,
              findings: 0,
              demoted: 0,
              cost_usd: 0,
              duration_ms: 0,
            },
          ],
        },
      };
      const report = aggregate([zeroRunsRun], 0, [], []);
      const codex = report.providers.find((p) => p.provider === "codex");
      expect(codex?.avgDurationMs).toBe(0);
    });

    it("providers is sorted by name", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      const names = report.providers.map((p) => p.provider);
      expect(names).toEqual([...names].sort());
    });

    it("demoteRate is 0 when no findings", () => {
      const noFindRun: LoadedRun = {
        ts: "2026-01-01T09:00:00.000Z",
        run_id: "run-0",
        iter: 0,
        summary: {
          verdict: "PASS",
          source: "panel",
          counts: { critical: 0, warn: 0, info: 0 },
          cost_usd: 0,
          duration_ms: 0,
          demoted: 0,
          signatures: [],
          providers: [
            {
              provider: "gemini",
              personas: [],
              runs: 1,
              errors: 0,
              findings: 0,
              demoted: 0,
              cost_usd: 0,
              duration_ms: 0,
            },
          ],
        },
      };
      const report = aggregate([noFindRun], 0, [], []);
      const gemini = report.providers.find((p) => p.provider === "gemini");
      expect(gemini?.demoteRate).toBe(0);
    });

    it("providers is empty when no runs", () => {
      const report = aggregate([], 0, [], []);
      expect(report.providers).toEqual([]);
    });
  });

  describe("topSignatures (panel runs only)", () => {
    it("counts occurrences across panel runs", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      expect(report.topSignatures).toHaveLength(2);
      const sigs = report.topSignatures.map((s) => s.signature);
      expect(sigs).toContain("sigA");
      expect(sigs).toContain("sigB");
      expect(report.topSignatures.find((s) => s.signature === "sigA")?.count).toBe(1);
    });

    it("is sorted descending by count, top 10", () => {
      // Build a run with 11 distinct signatures + one repeated
      const sigs = Array.from({ length: 11 }, (_, i) => `sig${i}`);
      const bigRun: LoadedRun = {
        ts: "2026-02-01T00:00:00.000Z",
        run_id: "big",
        iter: 1,
        summary: {
          verdict: "PASS",
          source: "panel",
          counts: { critical: 0, warn: 0, info: 0 },
          cost_usd: 0,
          duration_ms: 0,
          demoted: 0,
          signatures: sigs,
          providers: [],
        },
      };
      const bigRun2: LoadedRun = {
        ts: "2026-02-01T01:00:00.000Z",
        run_id: "big2",
        iter: 2,
        summary: {
          verdict: "PASS",
          source: "panel",
          counts: { critical: 0, warn: 0, info: 0 },
          cost_usd: 0,
          duration_ms: 0,
          demoted: 0,
          signatures: ["sig0"], // sig0 now has count=2
          providers: [],
        },
      };
      const report = aggregate([bigRun, bigRun2], 0, [], []);
      // Must be capped at 10
      expect(report.topSignatures.length).toBeLessThanOrEqual(10);
      // sig0 (count 2) must be first
      expect(report.topSignatures[0]?.signature).toBe("sig0");
      expect(report.topSignatures[0]?.count).toBe(2);
    });

    it("is empty when no runs", () => {
      const report = aggregate([], 0, [], []);
      expect(report.topSignatures).toEqual([]);
    });
  });

  describe("fpLedger", () => {
    it("active count equals number of entries with stage=active", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      expect(report.fpLedger.active).toBe(1);
    });

    it("sticky count equals number of entries with stage=sticky", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      expect(report.fpLedger.sticky).toBe(1);
    });

    it("candidate count equals number of entries with stage=candidate", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      expect(report.fpLedger.candidate).toBe(0);
    });

    it("perProviderConfirmed counts all rejects across entries", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      expect(report.fpLedger.perProviderConfirmed).toEqual({
        codex: 2,
        openrouter: 1,
      });
    });

    it("is zeroed when no entries", () => {
      const report = aggregate(allRuns, 1, [], brainEntries);
      expect(report.fpLedger.active).toBe(0);
      expect(report.fpLedger.sticky).toBe(0);
      expect(report.fpLedger.candidate).toBe(0);
      expect(report.fpLedger.perProviderConfirmed).toEqual({});
    });
  });

  describe("brain", () => {
    it("byStatus groups by status", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      expect(report.brain.byStatus).toEqual({ active: 1, candidate: 1 });
    });

    it("byType groups by type", () => {
      const report = aggregate(allRuns, 1, fpEntries, brainEntries);
      expect(report.brain.byType).toEqual({ convention: 2 });
    });

    it("is empty when no brain entries", () => {
      const report = aggregate(allRuns, 1, fpEntries, []);
      expect(report.brain.byStatus).toEqual({});
      expect(report.brain.byType).toEqual({});
    });
  });

  describe("edge cases", () => {
    it("does not throw on empty input", () => {
      expect(() => aggregate([], 0, [], [])).not.toThrow();
    });

    it("empty input gives sensible zero state", () => {
      const report = aggregate([], 0, [], []);
      expect(report.window.runCount).toBe(0);
      expect(report.escalationRate).toBe(0);
      expect(report.providers).toEqual([]);
      expect(report.cost.total).toBe(0);
      expect(report.topSignatures).toEqual([]);
    });
  });
});

describe("precision", () => {
  const decisions: DecisionOutcome[] = [
    { finding_id: "F-1", severity: "CRITICAL", bucket: "tp", providers: ["codex"] },
    {
      finding_id: "F-2",
      severity: "CRITICAL",
      bucket: "fp",
      reviewer_was_wrong: true,
      providers: ["codex", "gemini"],
    },
    { finding_id: "F-3", severity: "WARN", bucket: "declined", providers: ["gemini"] },
    { finding_id: "F-4", severity: "INFO", bucket: "tp", providers: ["codex"] },
  ];

  it("computes overall precision = tp/(tp+fp), counting events (no finding_id dedup; INFO excluded)", () => {
    const r = aggregate(allRuns, 1, fpEntries, brainEntries, decisions);
    expect(r.precision.overall.tp).toBe(1);
    expect(r.precision.overall.fp).toBe(1);
    expect(r.precision.overall.declined).toBe(1);
    expect(r.precision.overall.precision).toBeCloseTo(0.5);
  });

  it("splits by severity (INFO excluded)", () => {
    const r = aggregate(allRuns, 1, fpEntries, brainEntries, decisions);
    expect(r.precision.bySeverity.CRITICAL).toEqual({ tp: 1, fp: 1, declined: 0, precision: 0.5 });
    expect(r.precision.bySeverity.WARN.declined).toBe(1);
    expect("INFO" in r.precision.bySeverity).toBe(false);
  });

  it("attributes a multi-provider fp to each provider (INFO excluded from byProvider)", () => {
    const r = aggregate(allRuns, 1, fpEntries, brainEntries, decisions);
    expect(r.precision.byProvider.gemini?.fp).toBe(1);
    // F-4 (INFO tp, codex) is excluded; only F-1 (CRITICAL tp, codex) remains
    expect(r.precision.byProvider.codex?.tp).toBe(1);
    expect(r.precision.byProvider.codex?.fp).toBe(1);
  });

  it("returns null precision when there are no tp/fp", () => {
    const r = aggregate(allRuns, 1, fpEntries, brainEntries, []);
    expect(r.precision.overall.precision).toBeNull();
  });
});
