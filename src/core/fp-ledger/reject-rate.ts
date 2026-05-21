import { existsSync, readFileSync } from "node:fs";
import { DecisionEntrySchema } from "../../schemas/decision.ts";
import { decisionsPath } from "../../utils/paths.ts";

export interface RejectRate {
  total: number;
  wrongRejects: number;
  rate: number;
}

// Reject rate across the CURRENT cycle's decisions (iterations 1..throughIter):
// (rejected & reviewer_was_wrong) / (all valid decisions). A panel-noise
// circuit-breaker — independent of the FP-ledger opt-in.
export function computeRejectRate(repoRoot: string, throughIter: number): RejectRate {
  let total = 0;
  let wrongRejects = 0;
  for (let iter = 1; iter <= throughIter; iter++) {
    const p = decisionsPath(repoRoot, iter);
    if (!existsSync(p)) continue;
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
      total++;
      if (res.data.verdict === "rejected" && res.data.reviewer_was_wrong === true) wrongRejects++;
    }
  }
  return { total, wrongRejects, rate: total === 0 ? 0 : wrongRejects / total };
}
