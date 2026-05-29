import { z } from "zod";
import { FindingCategory } from "./finding.ts";

export const FpRejectSchema = z.object({
  run_id: z.string(),
  provider: z.string(), // base provider (Finding.reviewer.provider)
  ts: z.string(),
  reason: z.string(),
});
export type FpReject = z.infer<typeof FpRejectSchema>;

export const FpLedgerStage = z.enum(["candidate", "active", "sticky"]);
export type FpLedgerStage = z.infer<typeof FpLedgerStage>;

export const FpLedgerEntrySchema = z.object({
  id: z.string(),
  signature: z.string(), // the computeSignature match key
  rule_id: z.string(),
  category: FindingCategory,
  file: z.string(),
  symbol: z.string(),
  stage: FpLedgerStage,
  rejects: z.array(FpRejectSchema),
  distinct_providers: z.array(z.string()),
  first_seen_at: z.string(),
  last_seen_at: z.string(),
  pinned_by: z.string().optional(),
  linked_brain_id: z.string().optional(), // Phase B3
  // Phase B3b: set when the curator judge found this known-FP CONTRADICTS an
  // existing active brain entry. Records the conflicting entry for human review
  // and doubles as a "don't re-pair / don't re-check" marker.
  contradicts_brain_id: z.string().optional(),
  created_at: z.string(),
});
export type FpLedgerEntry = z.infer<typeof FpLedgerEntrySchema>;

export const FpLedgerIndexSchema = z.object({
  schema: z.literal("reviewgate.fpledger.v1"),
  entries: z.array(FpLedgerEntrySchema),
  // Monotonic high-water mark for id allocation. Persisted so a decayed entry's
  // id is NEVER reused even when the highest-numbered entry is the one removed
  // (a lingering pending.json pattern_id / brain linked_fp_id could still
  // reference it). Optional for backward compat with pre-existing ledgers.
  seq: z.number().int().nonnegative().optional(),
});
export type FpLedgerIndex = z.infer<typeof FpLedgerIndexSchema>;
