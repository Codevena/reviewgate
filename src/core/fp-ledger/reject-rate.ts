import { existsSync, readFileSync } from "node:fs";
import { decisionsPath } from "../../utils/paths.ts";
import { foldLastDecisions } from "./decision-fold.ts";

export interface RejectRate {
  total: number;
  wrongRejects: number;
  rate: number;
  // T6/R6 (field report 2026-07-03): decisions that CONTESTED a real blocking
  // finding without acting on it — verdict:"rejected" REGARDLESS of the
  // reviewer_was_wrong flag, plus accepted/action:"verified-not-applicable"
  // (same >= 20-char evidence bar; the field's dominant disposition class).
  // Feeds ONLY the widened reject-rate-high escalation — suppressors/learners
  // (fp-ledger, reputation, fp-streak) stay keyed to reviewer_was_wrong.
  contested: number;
}

const EMPTY: RejectRate = { total: 0, wrongRejects: 0, rate: 0, contested: 0 };

// Reject rate over the iteration's decisions for the REAL blocking findings only:
// (rejected & reviewer_was_wrong) / (decisions addressing an expected id).
// `expectedIds` is the set of CRITICAL/WARN finding ids the reviewers actually
// raised (from pending.json) — NOT agent-authored. Restricting to it (plus
// per-finding dedup) means the agent, which authors the decisions file, cannot
// pad duplicate or unrelated reviewer_was_wrong lines to manufacture this
// escape-hatch escalation; it can only move the rate by rejecting REAL findings,
// which is exactly the panel-noise signal this circuit-breaker is meant to catch.
//
// SCOPE — single iteration (deliberate, design-approved): the rate is computed
// over the CURRENT iteration's decisions, not accumulated across the whole cycle.
// A fabrication-proof cross-iteration rate would require persisting each past
// iteration's real-finding-id set (pending.json is overwritten every iteration),
// which is disproportionate machinery for a circuit-breaker that `max-iterations`
// already backstops: confirmed FPs that accumulate below this iteration's sample
// still drive the loop to the iteration cap and escalate there (as
// `max-iterations` rather than `reject-rate-high`). Security (no fabricated-id
// padding) was chosen over spec-literal cross-iteration accumulation. See the
// M5 design spec, Part B / Phase B2b note.
export function computeRejectRate(
  repoRoot: string,
  iter: number,
  expectedIds: Iterable<string>,
): RejectRate {
  const allowed = new Set(expectedIds);
  const p = decisionsPath(repoRoot, iter);
  if (allowed.size === 0 || !existsSync(p)) return EMPTY;

  // F-03: fold to the LAST valid decision per finding_id (the decisions-file
  // contract everywhere else — see loop-driver's lastDecisionsById), then count
  // each real finding once from its FINAL disposition. The anti-padding
  // guarantees are unchanged: still at most one count per real (allowed) id, and
  // the agent gains nothing from line order it could not get from a single line.
  // A retracted rejection (rejected → later accepted) must NOT inflate the
  // reject-rate-high / reviewer-fp-streak escalation counters.
  let total = 0;
  let wrongRejects = 0;
  let contested = 0;
  for (const [id, d] of foldLastDecisions(readFileSync(p, "utf8"))) {
    if (!allowed.has(id)) continue; // real findings only, once each (Map = unique ids)
    total++;
    if (d.verdict === "rejected" && d.reviewer_was_wrong === true) wrongRejects++;
    if (
      d.verdict === "rejected" ||
      (d.verdict === "accepted" && d.action === "verified-not-applicable")
    ) {
      contested++;
    }
  }
  return { total, wrongRejects, rate: total === 0 ? 0 : wrongRejects / total, contested };
}
