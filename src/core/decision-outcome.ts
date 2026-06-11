// src/core/decision-outcome.ts
// Pure classification of a human decision into a precision bucket, plus base-provider
// attribution. No I/O — emit/aggregation live in loop-driver / stats. See
// docs/superpowers/specs/2026-06-11-stats-precision-metric-design.md.
import type { DecisionOutcome } from "../schemas/audit-event.ts";
import type { DecisionEntry } from "../schemas/decision.ts";
import type { Finding } from "../schemas/finding.ts";

export type DecisionBucket = DecisionOutcome["bucket"];

// TP = the finding was real AND got fixed (anywhere); declined = valid but not fixed;
// FP = the reviewer was wrong.
export function classifyDecision(d: DecisionEntry): DecisionBucket {
  if (d.verdict === "accepted") {
    return d.action === "fixed" || d.action === "addressed-elsewhere" ? "tp" : "declined";
  }
  return d.reviewer_was_wrong === true ? "fp" : "declined";
}

// Base provider ids that raised the finding: reviewer.provider + every members[].provider,
// stripping any `provider:persona` suffix, de-duped and sorted for stable output.
export function normalizeProviders(f: Finding): string[] {
  const set = new Set<string>();
  const addBase = (v: string): void => {
    const i = v.indexOf(":");
    const base = i >= 0 ? v.slice(0, i) : v;
    if (base.length > 0) set.add(base);
  };
  addBase(f.reviewer.provider);
  for (const m of f.members ?? []) addBase(m.provider);
  return [...set].sort();
}

export function buildDecisionOutcome(d: DecisionEntry, f: Finding): DecisionOutcome {
  const base: DecisionOutcome = {
    finding_id: f.id,
    severity: f.severity,
    bucket: classifyDecision(d),
    providers: normalizeProviders(f),
  };
  if (d.verdict === "rejected" && d.reviewer_was_wrong !== undefined) {
    base.reviewer_was_wrong = d.reviewer_was_wrong;
  }
  return base;
}
