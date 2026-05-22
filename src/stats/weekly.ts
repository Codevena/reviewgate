import type { BrainEntry } from "../schemas/brain.ts";
import type { FpLedgerEntry } from "../schemas/fp-ledger.ts";
// src/stats/weekly.ts
// Pure weekly-report assembly: deltas + highlights. No I/O, no Date.now().
import type { StatsReport } from "./aggregate.ts";

export interface Delta {
  current: number;
  previous: number;
  abs: number;
}

export interface WeeklyReport {
  meta: {
    generatedAt: string;
    fpBrainReflect: "generation-time";
    status: "complete" | "partial" | "future";
    generatedThrough: string | null;
  };
  week: { iso: string; since: string; until: string };
  previousWeek: { iso: string } | null;
  current: StatsReport;
  trend: {
    runCount: Delta;
    cost: Delta;
    escalationRate: Delta;
    verdicts: Record<"PASS" | "SOFT-PASS" | "FAIL" | "ERROR", Delta>;
    providerErrorRate: { provider: string; delta: Delta }[];
  } | null;
  highlights: {
    newFpSignatures: { signature: string; stage: string; providers: string[] }[];
    newBrainEntries: { id: string; type: string; status: string }[];
    topCostProviders: { provider: string; cost: number }[];
    newSignatures: { signature: string; count: number }[];
  };
}

export interface WeeklyBuildArgs {
  weekIso: string;
  bounds: { since: string; until: string };
  previousWeekIso: string;
  currentSignatures: Map<string, number>;
  previousSignatures: Map<string, number>;
  windowedFpEntries: FpLedgerEntry[];
  windowedBrainEntries: BrainEntry[];
  generatedAt: string;
  now: Date;
}

const HIGHLIGHT_CAP = 20;

function delta(current: number, previous: number): Delta {
  return { current, previous, abs: current - previous };
}

function weekStatus(
  now: Date,
  bounds: { since: string; until: string },
  generatedAt: string,
): { status: "complete" | "partial" | "future"; generatedThrough: string | null } {
  const nowMs = now.getTime();
  const sinceMs = new Date(bounds.since).getTime();
  const untilMs = new Date(bounds.until).getTime();
  if (untilMs <= nowMs) return { status: "complete", generatedThrough: null };
  if (sinceMs <= nowMs) return { status: "partial", generatedThrough: generatedAt };
  return { status: "future", generatedThrough: null };
}

export function buildWeeklyReport(
  current: StatsReport,
  previous: StatsReport | null,
  args: WeeklyBuildArgs,
): WeeklyReport {
  const { status, generatedThrough } = weekStatus(args.now, args.bounds, args.generatedAt);

  let trend: WeeklyReport["trend"] = null;
  if (previous !== null) {
    const verdictKeys = ["PASS", "SOFT-PASS", "FAIL", "ERROR"] as const;
    const verdicts = Object.fromEntries(
      verdictKeys.map((k) => [k, delta(current.verdicts[k], previous.verdicts[k])]),
    ) as Record<(typeof verdictKeys)[number], Delta>;

    const errCur = new Map(current.providers.map((p) => [p.provider, p.errorRate]));
    const errPrev = new Map(previous.providers.map((p) => [p.provider, p.errorRate]));
    const providerErrorRate = [...new Set([...errCur.keys(), ...errPrev.keys()])]
      .sort()
      .map((provider) => ({
        provider,
        delta: delta(errCur.get(provider) ?? 0, errPrev.get(provider) ?? 0),
      }));

    trend = {
      runCount: delta(current.window.runCount, previous.window.runCount),
      cost: delta(current.cost.total, previous.cost.total),
      escalationRate: delta(current.escalationRate, previous.escalationRate),
      verdicts,
      providerErrorRate,
    };
  }

  const sinceMs = new Date(args.bounds.since).getTime();
  const untilMs = new Date(args.bounds.until).getTime();
  const inWindow = (ts: string): boolean => {
    const t = new Date(ts).getTime();
    return t >= sinceMs && t < untilMs;
  };

  const newFpSignatures = args.windowedFpEntries
    .filter((e) => inWindow(e.first_seen_at))
    .sort((a, b) =>
      a.first_seen_at < b.first_seen_at ? 1 : a.first_seen_at > b.first_seen_at ? -1 : 0,
    )
    .slice(0, HIGHLIGHT_CAP)
    .map((e) => ({
      signature: e.signature,
      stage: e.stage,
      providers: [...new Set(e.rejects.map((r) => r.provider))].sort(),
    }));

  const newBrainEntries = args.windowedBrainEntries
    .filter((e) => inWindow(e.created_at))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .slice(0, HIGHLIGHT_CAP)
    .map((e) => ({ id: e.id, type: e.type, status: e.status }));

  const topCostProviders = Object.entries(current.cost.perProvider)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([provider, cost]) => ({ provider, cost }));

  const newSignatures = [...args.currentSignatures.entries()]
    .filter(([sig]) => !args.previousSignatures.has(sig))
    .sort(([sigA, a], [sigB, b]) => (b !== a ? b - a : sigA < sigB ? -1 : 1))
    .map(([signature, count]) => ({ signature, count }));

  return {
    meta: {
      generatedAt: args.generatedAt,
      fpBrainReflect: "generation-time",
      status,
      generatedThrough,
    },
    week: { iso: args.weekIso, since: args.bounds.since, until: args.bounds.until },
    previousWeek: previous !== null ? { iso: args.previousWeekIso } : null,
    current,
    trend,
    highlights: { newFpSignatures, newBrainEntries, topCostProviders, newSignatures },
  };
}
