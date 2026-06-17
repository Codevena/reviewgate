// src/stats/aggregate.ts
import type { DecisionOutcome } from "../schemas/audit-event.ts";
import type { LoadedRun } from "./load.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StatsReport {
  window: {
    runCount: number;
    firstTs: string | null;
    lastTs: string | null;
    bySource: { panel: number; cache: number; skipped: number; checks: number };
  };
  verdicts: { PASS: number; "SOFT-PASS": number; FAIL: number; ERROR: number }; // over ALL runs
  escalationRate: number; // escalationCount / runCount (0 when no runs)
  cost: { total: number; avgPerRun: number; perProvider: Record<string, number> }; // panel runs only
  providers: {
    provider: string;
    runs: number;
    findings: number;
    demoteRate: number; // Σdemoted/Σfindings (0 if no findings)
    errorRate: number; // Σerrors/Σruns   (0 if no runs)
    avgDurationMs: number; // ΣdurationMs/Σruns — per-run mean (0 if no runs)
    cost: number;
  }[]; // panel runs only, sorted by provider name
  topSignatures: { signature: string; count: number }[]; // panel runs only, desc by count, top 10
  fpLedger: {
    active: number;
    sticky: number;
    candidate: number;
    perProviderConfirmed: Record<string, number>;
  };
  brain: { byStatus: Record<string, number>; byType: Record<string, number> };
  // #6 instrumentation: uncited project/house-rule findings across panel runs (the F-004
  // class). The measurable signal for the rule-citation directive's effect over time.
  // Optional for back-compat with hand-built StatsReport fixtures; aggregate() always sets it.
  ruleCitation?: { uncitedTotal: number; panelRuns: number };
  precision: {
    overall: PrecisionCell;
    bySeverity: { CRITICAL: PrecisionCell; WARN: PrecisionCell };
    byProvider: Record<string, PrecisionCell>;
  };
}

export interface PrecisionCell {
  tp: number;
  fp: number;
  declined: number;
  precision: number | null; // tp/(tp+fp); null when tp+fp === 0
}

export interface FpEntryLite {
  stage: string;
  rejects: { provider: string }[];
}

export interface BrainEntryLite {
  status: string;
  type: string;
}

// ---------------------------------------------------------------------------
// Pure aggregation
// ---------------------------------------------------------------------------

export function aggregate(
  runs: LoadedRun[],
  escalationCount: number,
  fpEntries: FpEntryLite[],
  brainEntries: BrainEntryLite[],
  decisions: DecisionOutcome[] = [],
): StatsReport {
  // ------------------------------------------------------------------
  // window
  // ------------------------------------------------------------------
  const runCount = runs.length;
  const sortedTs = runs.map((r) => r.ts).sort();
  const firstTs = sortedTs.length > 0 ? (sortedTs[0] ?? null) : null;
  const lastTs = sortedTs.length > 0 ? (sortedTs[sortedTs.length - 1] ?? null) : null;

  const bySource = { panel: 0, cache: 0, skipped: 0, checks: 0 };
  for (const r of runs) {
    bySource[r.summary.source] += 1;
  }

  // ------------------------------------------------------------------
  // verdicts — ALL runs
  // ------------------------------------------------------------------
  const verdicts = { PASS: 0, "SOFT-PASS": 0, FAIL: 0, ERROR: 0 };
  for (const r of runs) {
    verdicts[r.summary.verdict] += 1;
  }

  // ------------------------------------------------------------------
  // escalationRate
  // ------------------------------------------------------------------
  const escalationRate = runCount > 0 ? escalationCount / runCount : 0;

  // ------------------------------------------------------------------
  // Panel-only data
  // ------------------------------------------------------------------
  const panel = runs.filter((r) => r.summary.source === "panel");
  const panelCount = panel.length;

  // -- cost --
  let costTotal = 0;
  const costPerProvider: Record<string, number> = {};
  for (const r of panel) {
    costTotal += r.summary.cost_usd;
    for (const ps of r.summary.providers) {
      costPerProvider[ps.provider] = (costPerProvider[ps.provider] ?? 0) + ps.cost_usd;
    }
  }
  const costAvgPerRun = panelCount > 0 ? costTotal / panelCount : 0;

  // -- per-provider aggregation --
  interface ProviderAcc {
    runs: number;
    errors: number;
    findings: number;
    demoted: number;
    cost: number;
    totalDurationMs: number;
  }
  const providerMap = new Map<string, ProviderAcc>();

  for (const r of panel) {
    for (const ps of r.summary.providers) {
      let acc = providerMap.get(ps.provider);
      if (acc === undefined) {
        acc = {
          runs: 0,
          errors: 0,
          findings: 0,
          demoted: 0,
          cost: 0,
          totalDurationMs: 0,
        };
        providerMap.set(ps.provider, acc);
      }
      acc.runs += ps.runs;
      acc.errors += ps.errors;
      acc.findings += ps.findings;
      acc.demoted += ps.demoted;
      acc.cost += ps.cost_usd;
      acc.totalDurationMs += ps.duration_ms;
    }
  }

  const providers = [...providerMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([provider, acc]) => ({
      provider,
      runs: acc.runs,
      findings: acc.findings,
      demoteRate: acc.findings > 0 ? acc.demoted / acc.findings : 0,
      errorRate: acc.runs > 0 ? acc.errors / acc.runs : 0,
      // Per-run mean, on the same basis as the displayed `runs` column
      // (Σruns, which includes failover retries) — not per panel appearance.
      avgDurationMs: acc.runs > 0 ? acc.totalDurationMs / acc.runs : 0,
      cost: acc.cost,
    }));

  // -- top signatures --
  const sigCounts = new Map<string, number>();
  for (const r of panel) {
    for (const sig of r.summary.signatures) {
      sigCounts.set(sig, (sigCounts.get(sig) ?? 0) + 1);
    }
  }
  const topSignatures = [...sigCounts.entries()]
    .sort(([sigA, cntA], [sigB, cntB]) => {
      if (cntB !== cntA) return cntB - cntA;
      return sigA < sigB ? -1 : sigA > sigB ? 1 : 0;
    })
    .slice(0, 10)
    .map(([signature, count]) => ({ signature, count }));

  // ------------------------------------------------------------------
  // FP-ledger
  // ------------------------------------------------------------------
  let fpActive = 0;
  let fpSticky = 0;
  let fpCandidate = 0;
  const perProviderConfirmed: Record<string, number> = {};

  for (const entry of fpEntries) {
    if (entry.stage === "active") fpActive += 1;
    else if (entry.stage === "sticky") fpSticky += 1;
    else if (entry.stage === "candidate") fpCandidate += 1;

    for (const rej of entry.rejects) {
      perProviderConfirmed[rej.provider] = (perProviderConfirmed[rej.provider] ?? 0) + 1;
    }
  }

  // ------------------------------------------------------------------
  // Brain
  // ------------------------------------------------------------------
  const byStatus: Record<string, number> = {};
  const byType: Record<string, number> = {};

  for (const entry of brainEntries) {
    byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
    byType[entry.type] = (byType[entry.type] ?? 0) + 1;
  }

  // ------------------------------------------------------------------
  // Precision — count events directly; NEVER dedup by finding_id (it is
  // iteration-local and reused across cycles). Each event is one decision.
  // ------------------------------------------------------------------
  const newCell = (): PrecisionCell => ({ tp: 0, fp: 0, declined: 0, precision: null });
  const finalize = (c: PrecisionCell): void => {
    c.precision = c.tp + c.fp === 0 ? null : c.tp / (c.tp + c.fp);
  };
  const overall = newCell();
  const bySeverity = { CRITICAL: newCell(), WARN: newCell() };
  const byProvider: Record<string, PrecisionCell> = {};
  for (const d of decisions) {
    // Precision is about BLOCKING findings only — INFO is non-blocking and
    // requires no decision, so it is excluded from EVERY precision tally.
    if (d.severity === "INFO") continue;
    overall[d.bucket] += 1;
    if (d.severity === "CRITICAL") bySeverity.CRITICAL[d.bucket] += 1;
    else bySeverity.WARN[d.bucket] += 1;
    for (const p of d.providers) {
      if (byProvider[p] === undefined) byProvider[p] = newCell();
      // biome-ignore lint/style/noNonNullAssertion: just set above
      byProvider[p]![d.bucket] += 1;
    }
  }
  finalize(overall);
  finalize(bySeverity.CRITICAL);
  finalize(bySeverity.WARN);
  for (const cell of Object.values(byProvider)) finalize(cell);

  // ------------------------------------------------------------------
  // Assemble
  // ------------------------------------------------------------------
  return {
    window: {
      runCount,
      firstTs,
      lastTs,
      bySource,
    },
    verdicts,
    escalationRate,
    cost: {
      total: costTotal,
      avgPerRun: costAvgPerRun,
      perProvider: costPerProvider,
    },
    providers,
    topSignatures,
    fpLedger: {
      active: fpActive,
      sticky: fpSticky,
      candidate: fpCandidate,
      perProviderConfirmed,
    },
    brain: {
      byStatus,
      byType,
    },
    precision: { overall, bySeverity, byProvider },
    // #6 instrumentation: sum the per-run uncited rule-claim counts over panel runs.
    ruleCitation: {
      uncitedTotal: panel.reduce((sum, r) => sum + (r.summary.rule_uncited ?? 0), 0),
      panelRuns: panelCount,
    },
  };
}
