// src/schemas/triage.ts
import { z } from "zod";

export const RiskClass = z.enum(["trivial", "minimal", "standard", "sensitive", "default", "docs"]);
export type RiskClass = z.infer<typeof RiskClass>;

export const TriageDecisionSchema = z.object({
  schema: z.literal("reviewgate.triage.v1"),
  riskClass: RiskClass,
  runReview: z.boolean(),
  budgetTier: z.enum(["trivial", "minimal", "standard", "expanded"]),
  loopCap: z.number().int().positive(),
  reviewerHint: z.array(z.string()),
  // N1: when non-null, the soft iteration cap for THIS diff is min(config, this).
  // Set for small, low-risk diffs so a trivial fix isn't forced through the full
  // 3-round adversarial loop. null ⇒ use the global config cap (sensitive / large /
  // doc diffs). The hard cap (2× soft) and all other escalation breakers still apply.
  maxIterationsOverride: z.number().int().positive().nullable(),
  justification: z.string(),
});
export type TriageDecision = z.infer<typeof TriageDecisionSchema>;
