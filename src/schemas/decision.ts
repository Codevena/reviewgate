import { z } from "zod";

const Base = z.object({
  schema: z.literal("reviewgate.decision.v1"),
  finding_id: z.string(),
});

const Accepted = Base.extend({
  verdict: z.literal("accepted"),
  // N2 off-ramp: "acknowledged-low-value" lets the agent disposition a cosmetic nit
  // it does not intend to fix (an alternative to lying with reviewer_was_wrong). The
  // decisions-gate (evaluateDecisions) accepts it ONLY for an INFO/WARN finding that
  // is NOT security/correctness — a CRITICAL or security/correctness finding can never
  // be acknowledged away and stays blocking. It is NOT an FP claim (no ledger pin /
  // reputation hit) and still counts toward the reject-rate/fp-streak denominators.
  action: z.enum([
    "fixed",
    "addressed-elsewhere",
    "deferred-with-followup",
    "acknowledged-low-value",
  ]),
  files_touched: z.array(z.string()).optional(),
  commit_message_hint: z.string().optional(),
});

const Rejected = Base.extend({
  verdict: z.literal("rejected"),
  reason: z.string().min(20),
  reviewer_was_wrong: z.boolean().optional(),
});

export const DecisionEntrySchema = z.discriminatedUnion("verdict", [Accepted, Rejected]);
export type DecisionEntry = z.infer<typeof DecisionEntrySchema>;
