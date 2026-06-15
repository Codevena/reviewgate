import { z } from "zod";

export const DEMOTE_REASONS = [
  "scope_demoted",
  "fp_ledger_match",
  "low_confidence",
  "reputation_demoted",
  "critic_likely_fp",
  "critic_dropped",
  // Strong hallucination signals that previously produced NO learning outcome
  // because reasonOf() omitted them:
  //   - fp_cluster_match : matched a DERIVED active/sticky FP cluster
  //   - fact_invalid     : cited file:line provably absent from the working tree
  //   - grounding_demoted: cited a code token wholly absent from the corpus
  "fp_cluster_match",
  "fact_invalid",
  "grounding_demoted",
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
