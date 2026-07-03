// tests/unit/weekly-aggregate.test.ts
import { describe, expect, it } from "bun:test";
import type { BrainEntry } from "../../src/schemas/brain.ts";
import type { FpLedgerEntry } from "../../src/schemas/fp-ledger.ts";
import type { StatsReport } from "../../src/stats/aggregate.ts";
import { buildWeeklyReport } from "../../src/stats/weekly.ts";
import type { WeeklyBuildArgs } from "../../src/stats/weekly.ts";

function emptyStats(overrides: Partial<StatsReport> = {}): StatsReport {
  return {
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
    ...overrides,
  };
}

function baseArgs(overrides: Partial<WeeklyBuildArgs> = {}): WeeklyBuildArgs {
  return {
    weekIso: "2026-W20",
    bounds: { since: "2026-05-11T00:00:00.000Z", until: "2026-05-18T00:00:00.000Z" },
    previousWeekIso: "2026-W19",
    currentSignatures: new Map(),
    previousSignatures: new Map(),
    windowedFpEntries: [],
    windowedBrainEntries: [],
    generatedAt: "2026-05-25T09:00:00.000Z",
    now: new Date("2026-05-25T09:00:00.000Z"),
    ...overrides,
  };
}

describe("buildWeeklyReport", () => {
  it("computes runCount/cost/escalation/verdict deltas vs previous week", () => {
    const current = emptyStats({
      window: {
        runCount: 12,
        firstTs: null,
        lastTs: null,
        bySource: { panel: 12, cache: 0, skipped: 0, checks: 0, "content-cache": 0 },
      },
      verdicts: { PASS: 10, "SOFT-PASS": 0, FAIL: 2, ERROR: 0 },
      escalationRate: 0.1,
      cost: { total: 0.84, avgPerRun: 0.07, perProvider: {} },
    });
    const previous = emptyStats({
      window: {
        runCount: 15,
        firstTs: null,
        lastTs: null,
        bySource: { panel: 15, cache: 0, skipped: 0, checks: 0, "content-cache": 0 },
      },
      verdicts: { PASS: 14, "SOFT-PASS": 0, FAIL: 1, ERROR: 0 },
      escalationRate: 0.06,
      cost: { total: 0.71, avgPerRun: 0.047, perProvider: {} },
    });
    const r = buildWeeklyReport(current, previous, baseArgs());
    expect(r.previousWeek).toEqual({ iso: "2026-W19" });
    expect(r.trend?.runCount).toEqual({ current: 12, previous: 15, abs: -3 });
    expect(r.trend?.cost.abs).toBeCloseTo(0.13, 5);
    expect(r.trend?.verdicts.FAIL).toEqual({ current: 2, previous: 1, abs: 1 });
    expect(r.meta.status).toBe("complete");
  });

  it("treats null previous as a first report (trend null)", () => {
    const r = buildWeeklyReport(
      emptyStats({
        window: {
          runCount: 3,
          firstTs: null,
          lastTs: null,
          bySource: { panel: 3, cache: 0, skipped: 0, checks: 0, "content-cache": 0 },
        },
      }),
      null,
      baseArgs(),
    );
    expect(r.previousWeek).toBeNull();
    expect(r.trend).toBeNull();
  });

  it("a zero-run previous week is a valid baseline (not first report)", () => {
    const current = emptyStats({
      window: {
        runCount: 12,
        firstTs: null,
        lastTs: null,
        bySource: { panel: 12, cache: 0, skipped: 0, checks: 0, "content-cache": 0 },
      },
    });
    const r = buildWeeklyReport(current, emptyStats(), baseArgs());
    expect(r.previousWeek).toEqual({ iso: "2026-W19" });
    expect(r.trend?.runCount).toEqual({ current: 12, previous: 0, abs: 12 });
  });

  it("providerErrorRate unions providers across both weeks", () => {
    const current = emptyStats({
      providers: [
        {
          provider: "codex",
          runs: 4,
          findings: 0,
          demoteRate: 0,
          errorRate: 0.25,
          avgDurationMs: 10,
          cost: 0,
        },
      ],
    });
    const previous = emptyStats({
      providers: [
        {
          provider: "gemini",
          runs: 2,
          findings: 0,
          demoteRate: 0,
          errorRate: 0.5,
          avgDurationMs: 10,
          cost: 0,
        },
      ],
    });
    const r = buildWeeklyReport(current, previous, baseArgs());
    const byProvider = Object.fromEntries(
      (r.trend?.providerErrorRate ?? []).map((p) => [p.provider, p.delta]),
    );
    expect(byProvider.codex).toEqual({ current: 0.25, previous: 0, abs: 0.25 });
    expect(byProvider.gemini).toEqual({ current: 0, previous: 0.5, abs: -0.5 });
  });

  it("newSignatures = current signatures absent from previous", () => {
    const current = new Map<string, number>([
      ["sig-new", 3],
      ["sig-old", 1],
    ]);
    const previous = new Map<string, number>([["sig-old", 5]]);
    const r = buildWeeklyReport(
      emptyStats({
        window: {
          runCount: 1,
          firstTs: null,
          lastTs: null,
          bySource: { panel: 1, cache: 0, skipped: 0, checks: 0, "content-cache": 0 },
        },
      }),
      emptyStats(),
      baseArgs({ currentSignatures: current, previousSignatures: previous }),
    );
    expect(r.highlights.newSignatures).toEqual([{ signature: "sig-new", count: 3 }]);
  });

  it("windows FP highlights by first_seen_at with distinct sorted providers", () => {
    const fp = (id: string, firstSeen: string, providers: string[]): FpLedgerEntry => ({
      id,
      signature: `sig-${id}`,
      rule_id: "r",
      category: "security",
      file: "a.ts",
      symbol: "f",
      stage: "active",
      rejects: providers.map((p) => ({ run_id: "x", provider: p, ts: firstSeen, reason: "r" })),
      distinct_providers: providers,
      first_seen_at: firstSeen,
      last_seen_at: firstSeen,
      created_at: firstSeen,
    });
    const inWeek = fp("1", "2026-05-12T00:00:00.000Z", ["gemini", "codex", "codex"]);
    const outWeek = fp("2", "2026-05-01T00:00:00.000Z", ["codex"]);
    const r = buildWeeklyReport(
      emptyStats({
        window: {
          runCount: 1,
          firstTs: null,
          lastTs: null,
          bySource: { panel: 1, cache: 0, skipped: 0, checks: 0, "content-cache": 0 },
        },
      }),
      emptyStats(),
      baseArgs({ windowedFpEntries: [inWeek, outWeek] }),
    );
    expect(r.highlights.newFpSignatures).toEqual([
      { signature: "sig-1", stage: "active", providers: ["codex", "gemini"] },
    ]);
  });

  it("status = partial when now is inside the week, with generatedThrough", () => {
    const r = buildWeeklyReport(
      emptyStats({
        window: {
          runCount: 2,
          firstTs: null,
          lastTs: null,
          bySource: { panel: 2, cache: 0, skipped: 0, checks: 0, "content-cache": 0 },
        },
      }),
      emptyStats(),
      baseArgs({
        now: new Date("2026-05-14T12:00:00.000Z"),
        generatedAt: "2026-05-14T12:00:00.000Z",
      }),
    );
    expect(r.meta.status).toBe("partial");
    expect(r.meta.generatedThrough).toBe("2026-05-14T12:00:00.000Z");
  });

  it("status = future when the week is entirely after now", () => {
    const r = buildWeeklyReport(
      emptyStats(),
      null,
      baseArgs({
        now: new Date("2026-01-01T00:00:00.000Z"),
        generatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    expect(r.meta.status).toBe("future");
    expect(r.meta.generatedThrough).toBeNull();
  });

  it("topCostProviders are sorted desc by cost and capped at 3", () => {
    const current = emptyStats({
      cost: { total: 9.5, avgPerRun: 0, perProvider: { a: 1, b: 5, c: 3, d: 0.5 } },
    });
    const r = buildWeeklyReport(current, emptyStats(), baseArgs());
    expect(r.highlights.topCostProviders).toEqual([
      { provider: "b", cost: 5 },
      { provider: "c", cost: 3 },
      { provider: "a", cost: 1 },
    ]);
  });

  it("windows newBrainEntries by created_at and sorts desc", () => {
    const brain = (id: string, createdAt: string): BrainEntry => ({
      id,
      type: "convention",
      scope: "global",
      title: `t-${id}`,
      body: "b",
      tags: [],
      file_globs: [],
      status: "active",
      referenced_count: 1,
      referencing_reviewers: [],
      confidence: 0.9,
      embedding: null,
      evidence: [],
      created_at: createdAt,
      source_run_id: "run-x",
    });
    const inEarly = brain("1", "2026-05-12T00:00:00.000Z");
    const inLate = brain("2", "2026-05-15T00:00:00.000Z");
    const outWeek = brain("3", "2026-05-01T00:00:00.000Z");
    const r = buildWeeklyReport(
      emptyStats(),
      emptyStats(),
      baseArgs({ windowedBrainEntries: [inEarly, inLate, outWeek] }),
    );
    expect(r.highlights.newBrainEntries).toEqual([
      { id: "2", type: "convention", status: "active" },
      { id: "1", type: "convention", status: "active" },
    ]);
  });

  it("newSignatures tie-break on equal counts is lexicographic asc", () => {
    const current = new Map<string, number>([
      ["sig-b", 2],
      ["sig-a", 2],
    ]);
    const r = buildWeeklyReport(
      emptyStats(),
      emptyStats(),
      baseArgs({ currentSignatures: current, previousSignatures: new Map() }),
    );
    expect(r.highlights.newSignatures).toEqual([
      { signature: "sig-a", count: 2 },
      { signature: "sig-b", count: 2 },
    ]);
  });

  it("caps newSignatures at HIGHLIGHT_CAP (20) in the report object, not just the renderer", () => {
    const current = new Map<string, number>();
    // 50 distinct new signatures, descending counts so order is deterministic
    for (let i = 0; i < 50; i++) {
      current.set(`sig-${String(i).padStart(3, "0")}`, 50 - i);
    }
    const r = buildWeeklyReport(
      emptyStats(),
      emptyStats(),
      baseArgs({ currentSignatures: current, previousSignatures: new Map() }),
    );
    expect(r.highlights.newSignatures).toHaveLength(20);
    // Highest-count signatures survive the cap (sig-000=50 … sig-019=31)
    expect(r.highlights.newSignatures[0]).toEqual({ signature: "sig-000", count: 50 });
    expect(r.highlights.newSignatures[19]).toEqual({ signature: "sig-019", count: 31 });
  });
});
