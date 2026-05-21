import { existsSync, readFileSync } from "node:fs";
import { DecisionEntrySchema } from "../../schemas/decision.ts";
import { decisionsPath } from "../../utils/paths.ts";

export interface RejectRate {
  total: number;
  wrongRejects: number;
  rate: number;
}

const EMPTY: RejectRate = { total: 0, wrongRejects: 0, rate: 0 };

// Reject rate over the iteration's decisions for the REAL blocking findings only:
// (rejected & reviewer_was_wrong) / (decisions addressing an expected id).
// `expectedIds` is the set of CRITICAL/WARN finding ids the reviewers actually
// raised (from pending.json) — NOT agent-authored. Restricting to it (plus
// per-finding dedup) means the agent, which authors the decisions file, cannot
// pad duplicate or unrelated reviewer_was_wrong lines to manufacture this
// escape-hatch escalation; it can only move the rate by rejecting REAL findings,
// which is exactly the panel-noise signal this circuit-breaker is meant to catch.
export function computeRejectRate(
  repoRoot: string,
  iter: number,
  expectedIds: Iterable<string>,
): RejectRate {
  const allowed = new Set(expectedIds);
  const p = decisionsPath(repoRoot, iter);
  if (allowed.size === 0 || !existsSync(p)) return EMPTY;

  const seen = new Set<string>();
  let total = 0;
  let wrongRejects = 0;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const res = DecisionEntrySchema.safeParse(parsed);
    if (!res.success) continue;
    const id = res.data.finding_id;
    if (!allowed.has(id) || seen.has(id)) continue; // real findings only, once each
    seen.add(id);
    total++;
    if (res.data.verdict === "rejected" && res.data.reviewer_was_wrong === true) wrongRejects++;
  }
  return { total, wrongRejects, rate: total === 0 ? 0 : wrongRejects / total };
}
