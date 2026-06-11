// src/core/fp-ledger/decision-fold.ts
import { type DecisionEntry, DecisionEntrySchema } from "../../schemas/decision.ts";

// LAST-valid-decision-per-finding_id fold over a decisions/<iter>.jsonl body.
//
// The decisions file is APPEND-ONLY and may carry a superseding disposition for
// a finding within one iteration (e.g. rejected → later accepted after a
// re-block of the same iteration). The loop-driver's sibling readers
// (priorIterationDecisionSignatures, priorAdjudications, lastDecisionsById) all
// fold LAST-wins so they reflect the agent's MOST RECENT intent. The learning
// consumers (fp-ledger learn, reputation learn, reject-rate) must apply the SAME
// contract — otherwise a retracted rejection is booked as a permanent
// FP-ledger / reputation / escalation-counter signal (F-19 / F-20 / F-03), and
// two readers of the same file disagree about what the agent decided.
//
// Unparseable / schema-invalid lines are skipped (never throw on a single bad
// line), mirroring the loop-driver fold. Read errors are the CALLER's concern —
// this helper is pure over the file body.
export function foldLastDecisions(content: string): Map<string, DecisionEntry> {
  const out = new Map<string, DecisionEntry>();
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const res = DecisionEntrySchema.safeParse(parsed);
    if (!res.success) continue;
    out.set(res.data.finding_id, res.data); // last valid line for an id wins
  }
  return out;
}
