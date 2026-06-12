// tests/unit/weekly-render.test.ts
import { describe, expect, it } from "bun:test";
import { renderWeeklyMarkdown } from "../../src/stats/weekly-render.ts";
import type { WeeklyReport } from "../../src/stats/weekly.ts";

function baseReport(overrides: Partial<WeeklyReport> = {}): WeeklyReport {
  const emptyStats = {
    window: {
      runCount: 12,
      firstTs: null,
      lastTs: null,
      bySource: { panel: 12, cache: 0, skipped: 0 },
    },
    verdicts: { PASS: 10, "SOFT-PASS": 0, FAIL: 2, ERROR: 0 },
    escalationRate: 0.1,
    cost: { total: 0.84, avgPerRun: 0.07, perProvider: { codex: 0.84 } },
    providers: [
      {
        provider: "codex",
        runs: 12,
        findings: 4,
        demoteRate: 0,
        errorRate: 0,
        avgDurationMs: 1000,
        cost: 0.84,
      },
    ],
    topSignatures: [],
    fpLedger: { active: 1, sticky: 0, candidate: 0, perProviderConfirmed: {} },
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
  return {
    meta: {
      generatedAt: "2026-05-25T09:00:00.000Z",
      fpBrainReflect: "generation-time",
      status: "complete",
      generatedThrough: null,
    },
    week: { iso: "2026-W20", since: "2026-05-11T00:00:00.000Z", until: "2026-05-18T00:00:00.000Z" },
    previousWeek: { iso: "2026-W19" },
    current: emptyStats,
    trend: {
      runCount: { current: 12, previous: 15, abs: -3 },
      cost: { current: 0.84, previous: 0.71, abs: 0.13 },
      escalationRate: { current: 0.1, previous: 0.06, abs: 0.04 },
      verdicts: {
        PASS: { current: 10, previous: 14, abs: -4 },
        "SOFT-PASS": { current: 0, previous: 0, abs: 0 },
        FAIL: { current: 2, previous: 1, abs: 1 },
        ERROR: { current: 0, previous: 0, abs: 0 },
      },
      providerErrorRate: [{ provider: "codex", delta: { current: 0, previous: 0, abs: 0 } }],
    },
    highlights: {
      newFpSignatures: [],
      newBrainEntries: [],
      topCostProviders: [{ provider: "codex", cost: 0.84 }],
      newSignatures: [],
    },
    ...overrides,
  };
}

describe("renderWeeklyMarkdown", () => {
  it("renders a header, summary table with trend arrows, and the FP/brain caveat", () => {
    const md = renderWeeklyMarkdown(baseReport());
    expect(md).toContain("# Reviewgate Weekly Report — 2026-W20");
    expect(md).toContain("▼"); // runCount decreased
    expect(md).toContain("▲"); // cost increased
    expect(md.toLowerCase()).toContain("reflect current state");
  });

  it("renders a first-report note and omits the trend when previousWeek is null", () => {
    const md = renderWeeklyMarkdown(baseReport({ previousWeek: null, trend: null }));
    expect(md.toLowerCase()).toContain("first report");
    expect(md).not.toContain("▼");
  });

  it("renders an in-progress banner for a partial week", () => {
    const md = renderWeeklyMarkdown(
      baseReport({
        meta: {
          generatedAt: "2026-05-14T12:00:00.000Z",
          fpBrainReflect: "generation-time",
          status: "partial",
          generatedThrough: "2026-05-14T12:00:00.000Z",
        },
      }),
    );
    expect(md).toContain("in progress");
    expect(md).toContain("2026-05-14T12:00:00.000Z");
  });

  it("renders a zero-run note for an empty/future week", () => {
    const zero = baseReport({
      current: {
        ...baseReport().current,
        window: {
          runCount: 0,
          firstTs: null,
          lastTs: null,
          bySource: { panel: 0, cache: 0, skipped: 0 },
        },
      },
      meta: {
        generatedAt: "2026-01-01T00:00:00.000Z",
        fpBrainReflect: "generation-time",
        status: "future",
        generatedThrough: null,
      },
      previousWeek: null,
      trend: null,
    });
    expect(renderWeeklyMarkdown(zero)).toContain("no runs in 2026-W20");
  });
});
