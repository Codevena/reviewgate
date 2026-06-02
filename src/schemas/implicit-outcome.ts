import { z } from "zod";

export const DEMOTE_REASONS = [
  "scope_demoted",
  "fp_ledger_match",
  "low_confidence",
  "reputation_demoted",
  "critic_likely_fp",
  "critic_dropped",
] as const;

export const ImplicitOutcomeSchema = z.object({
  schema: z.literal("reviewgate.implicit_outcome.v1"),
  signature: z.string(),
  reviewer_key: z.string(),
  category: z.string(),
  demote_reason: z.enum(DEMOTE_REASONS),
  run_id: z.string(),
  iter: z.number().int().nonnegative(),
  created_at: z.string(),
});

export type ImplicitOutcome = z.infer<typeof ImplicitOutcomeSchema>;
export type DemoteReason = (typeof DEMOTE_REASONS)[number];
