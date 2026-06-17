// src/core/provider-precision.ts
// #8: advisory per-provider precision context. Aggregates historical precision
// (tp/(tp+fp)) from decision.applied audit events and attaches it to findings as
// pure metadata. NEVER affects severity/verdict — see the design spec.
//
// The tp/(tp+fp) arithmetic deliberately parallels src/stats/aggregate.ts's
// byProvider precision cell (same DecisionOutcome source); it is NOT factored into
// a shared helper because the stats loop bundles declined/severity bookkeeping that
// the gate path does not need.
import type { DecisionOutcome } from "../schemas/audit-event.ts";
import type { Finding } from "../schemas/finding.ts";
import { loadAuditWindow } from "../stats/load.ts";
import { normalizeProviders } from "./decision-outcome.ts";

export const PROVIDER_PRECISION_WINDOW_DAYS = 90;
export const PROVIDER_PRECISION_MIN_DECISIONS = 5;
// #4: a reviewer is "high track record" (protected from the soft demoters) at precision
// >= floor with >= minDecisions blocking-decision samples. The sample floor (8, mirroring
// reputation.minSamples) keeps a 1/1=100% newcomer from being mislabeled trusted; precision
// is a decayed, NON-gameable signal (unlike a reviewer's self-reported confidence).
export const HIGH_PRECISION_FLOOR = 0.7;
export const PROTECT_MIN_DECISIONS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ProviderPrecision {
  tp: number;
  fp: number;
  precision: number | null; // tp/(tp+fp); null when tp+fp === 0
}

// Pure: count tp/fp per base provider. INFO is excluded (non-blocking, needs no
// decision); `declined` is ignored (neither a true nor a false positive).
export function perProviderPrecision(decisions: DecisionOutcome[]): Map<string, ProviderPrecision> {
  const acc = new Map<string, { tp: number; fp: number }>();
  for (const d of decisions) {
    if (d.severity === "INFO") continue;
    if (d.bucket !== "tp" && d.bucket !== "fp") continue;
    for (const p of d.providers) {
      const cur = acc.get(p) ?? { tp: 0, fp: 0 };
      if (d.bucket === "tp") cur.tp += 1;
      else cur.fp += 1;
      acc.set(p, cur);
    }
  }
  const out = new Map<string, ProviderPrecision>();
  for (const [p, { tp, fp }] of acc) {
    out.set(p, { tp, fp, precision: tp + fp === 0 ? null : tp / (tp + fp) });
  }
  return out;
}

// Best-effort gate-time load over [now − windowDays, now]. BOTH since and until
// are passed so loadAuditWindow uses the bounded day-dir scan. Empty map on ANY
// error (advisory only — never throws).
export function loadProviderPrecision(
  repoRoot: string,
  opts: { windowDays: number; now: Date },
): Map<string, ProviderPrecision> {
  try {
    const since = new Date(opts.now.getTime() - opts.windowDays * DAY_MS).toISOString();
    const until = opts.now.toISOString();
    const { decisions } = loadAuditWindow(repoRoot, { since, until });
    return perProviderPrecision(decisions);
  } catch {
    return new Map();
  }
}

// #4: base-provider keys whose precision is >= floor with >= minDecisions samples — the
// "high track record" set whose findings the soft demoters (critic likely_fp / confidence-
// floor) must NOT silently downgrade. Anti-suppression: membership only PREVENTS a demote.
export function highPrecisionProviders(
  precision: Map<string, ProviderPrecision>,
  opts: { floor: number; minDecisions: number },
): Set<string> {
  const out = new Set<string>();
  for (const [p, pr] of precision) {
    if (pr.precision !== null && pr.tp + pr.fp >= opts.minDecisions && pr.precision >= opts.floor) {
      out.add(p);
    }
  }
  return out;
}

// Attach reviewer_precision to each finding for its contributing base providers
// (normalizeProviders) that have >= minDecisions samples (tp+fp). Immutable: a
// finding with no qualifying provider is returned unchanged.
export function annotateFindingsWithPrecision(
  findings: Finding[],
  precision: Map<string, ProviderPrecision>,
  opts: { minDecisions: number },
): Finding[] {
  if (precision.size === 0) return findings;
  return findings.map((f) => {
    const cells: NonNullable<Finding["reviewer_precision"]> = [];
    for (const p of normalizeProviders(f)) {
      const pr = precision.get(p);
      if (pr && pr.tp + pr.fp >= opts.minDecisions) {
        cells.push({ provider: p, tp: pr.tp, fp: pr.fp, precision: pr.precision });
      }
    }
    return cells.length > 0 ? { ...f, reviewer_precision: cells } : f;
  });
}
