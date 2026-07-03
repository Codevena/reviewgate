// tests/unit/stats-render.test.ts
import { describe, expect, it } from "bun:test";
import type { PrecisionCell, StatsReport } from "../../src/stats/aggregate.ts";
import { renderStats } from "../../src/stats/render.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FULL_REPORT: StatsReport = {
  window: {
    runCount: 3,
    firstTs: "2026-01-01T10:00:00.000Z",
    lastTs: "2026-01-03T12:00:00.000Z",
    bySource: { panel: 2, cache: 1, skipped: 0, checks: 0, "content-cache": 0 },
  },
  verdicts: { PASS: 1, "SOFT-PASS": 1, FAIL: 1, ERROR: 0 },
  escalationRate: 0.333,
  cost: {
    total: 0.0234,
    avgPerRun: 0.0117,
    perProvider: { codex: 0.0234 },
  },
  providers: [
    {
      provider: "codex",
      runs: 2,
      findings: 4,
      demoteRate: 0.25,
      errorRate: 0.0,
      avgDurationMs: 8200,
      cost: 0.0234,
    },
  ],
  topSignatures: [
    { signature: "no-unused-vars:src/foo.ts:42", count: 2 },
    { signature: "no-console:src/bar.ts:7", count: 1 },
  ],
  fpLedger: {
    active: 2,
    sticky: 1,
    candidate: 3,
    perProviderConfirmed: { codex: 5 },
  },
  brain: {
    byStatus: { active: 4, revoked: 1 },
    byType: { convention: 3, pattern: 2 },
  },
  precision: {
    overall: { tp: 0, fp: 0, declined: 0, precision: null },
    bySeverity: {
      CRITICAL: { tp: 0, fp: 0, declined: 0, precision: null },
      WARN: { tp: 0, fp: 0, declined: 0, precision: null },
    },
    byProvider: {},
  },
};

const EMPTY_REPORT: StatsReport = {
  window: {
    runCount: 0,
    firstTs: null,
    lastTs: null,
    bySource: { panel: 0, cache: 0, skipped: 0, checks: 0, "content-cache": 0 },
  },
  verdicts: { PASS: 0, "SOFT-PASS": 0, FAIL: 0, ERROR: 0 },
  escalationRate: 0,
  cost: { total: 0, avgPerRun: 0, perProvider: {} },
  providers: [],
  topSignatures: [],
  fpLedger: { active: 0, sticky: 0, candidate: 0, perProviderConfirmed: {} },
  brain: { byStatus: {}, byType: {} },
  precision: {
    overall: { tp: 0, fp: 0, declined: 0, precision: null },
    bySeverity: {
      CRITICAL: { tp: 0, fp: 0, declined: 0, precision: null },
      WARN: { tp: 0, fp: 0, declined: 0, precision: null },
    },
    byProvider: {},
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("renderStats", () => {
  describe("full report", () => {
    it("contains all section headers", () => {
      const out = renderStats(FULL_REPORT);
      expect(out).toContain("Verdicts");
      expect(out).toContain("Cost");
      expect(out).toContain("Reviewers");
      expect(out).toContain("Findings");
      expect(out).toContain("Brain");
    });

    it("shows run count", () => {
      const out = renderStats(FULL_REPORT);
      expect(out).toContain("3");
    });

    it("shows the provider name in the reviewer section", () => {
      const out = renderStats(FULL_REPORT);
      expect(out).toContain("codex");
    });

    it("shows total cost formatted to 4 decimal places", () => {
      const out = renderStats(FULL_REPORT);
      // $0.0234 — at least 4 decimal places worth of precision
      expect(out).toMatch(/0\.023[0-9]/);
    });

    it("shows a verdict count", () => {
      const out = renderStats(FULL_REPORT);
      // PASS: 1
      expect(out).toMatch(/PASS.*1|1.*PASS/);
    });

    it("shows FAIL count", () => {
      const out = renderStats(FULL_REPORT);
      expect(out).toMatch(/FAIL.*1|1.*FAIL/);
    });

    it("shows a top signature", () => {
      const out = renderStats(FULL_REPORT);
      expect(out).toContain("no-unused-vars:src/foo.ts:42");
    });

    it("shows fp-ledger active/sticky/candidate counts", () => {
      const out = renderStats(FULL_REPORT);
      // active: 2, sticky: 1, candidate: 3
      expect(out).toContain("2"); // active
      expect(out).toContain("1"); // sticky
      expect(out).toContain("3"); // candidate
    });

    it("shows brain byStatus entries", () => {
      const out = renderStats(FULL_REPORT);
      expect(out).toContain("active");
      expect(out).toContain("4");
    });

    it("shows escalation rate", () => {
      const out = renderStats(FULL_REPORT);
      // 33.3% or similar
      expect(out).toMatch(/33\.|escalat/i);
    });
  });

  describe("empty report", () => {
    it("returns a string containing 'no review history' (case-insensitive)", () => {
      const out = renderStats(EMPTY_REPORT);
      expect(out.toLowerCase()).toContain("no review history");
    });

    it("does not contain section headers when empty", () => {
      const out = renderStats(EMPTY_REPORT);
      expect(out).not.toContain("Verdicts");
      expect(out).not.toContain("Reviewers");
    });
  });
});

function reportWith(precision: StatsReport["precision"]): StatsReport {
  return {
    window: {
      runCount: 1,
      firstTs: "2026-06-01T00:00:00Z",
      lastTs: "2026-06-01T00:00:00Z",
      bySource: { panel: 1, cache: 0, skipped: 0, checks: 0, "content-cache": 0 },
    },
    verdicts: { PASS: 1, "SOFT-PASS": 0, FAIL: 0, ERROR: 0 },
    escalationRate: 0,
    cost: { total: 0, avgPerRun: 0, perProvider: {} },
    providers: [],
    topSignatures: [],
    fpLedger: { active: 0, sticky: 0, candidate: 0, perProviderConfirmed: {} },
    brain: { byStatus: {}, byType: {} },
    precision,
  };
}

describe("renderStats precision", () => {
  it("renders a percentage when tp+fp > 0", () => {
    const out = renderStats(
      reportWith({
        overall: { tp: 2, fp: 1, declined: 1, precision: 2 / 3 },
        bySeverity: {
          CRITICAL: { tp: 1, fp: 1, declined: 0, precision: 0.5 },
          WARN: { tp: 1, fp: 0, declined: 1, precision: 1 },
        },
        byProvider: { codex: { tp: 2, fp: 1, declined: 0, precision: 2 / 3 } },
      }),
    );
    expect(out).toContain("Precision");
    expect(out).toContain("66.7%");
    expect(out).toContain("codex");
  });

  it("renders an em dash when precision is null", () => {
    const out = renderStats(
      reportWith({
        overall: { tp: 0, fp: 0, declined: 0, precision: null },
        bySeverity: {
          CRITICAL: { tp: 0, fp: 0, declined: 0, precision: null },
          WARN: { tp: 0, fp: 0, declined: 0, precision: null },
        },
        byProvider: {},
      }),
    );
    expect(out).toContain("—");
    expect(out).toContain("no decisions recorded yet");
  });
});
