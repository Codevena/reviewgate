// src/schemas/triage.ts
import { z } from "zod";

export const RiskClass = z.enum(["trivial", "minimal", "standard", "sensitive", "default"]);
export type RiskClass = z.infer<typeof RiskClass>;

export const TriageDecisionSchema = z.object({
  schema: z.literal("reviewgate.triage.v1"),
  riskClass: RiskClass,
  runReview: z.boolean(),
  budgetTier: z.enum(["trivial", "minimal", "standard", "expanded"]),
  loopCap: z.number().int().positive(),
  reviewerHint: z.array(z.string()),
  justification: z.string(),
});
export type TriageDecision = z.infer<typeof TriageDecisionSchema>;
