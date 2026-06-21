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
  //
  // P6: "verified-not-applicable" is the honest verdict for "the reviewer was RIGHT to
  // raise the concern, but I VERIFIED (with evidence) it does not apply here" (e.g. a
  // code-default the reviewer feared a prod-DB row overrides — checked, it doesn't). It
  // REQUIRES a `reason` >= 20 (the verification evidence; enforced by the union superRefine
  // below) and — UNLIKE acknowledged-low-value — IS allowed on CRITICAL/security/correctness
  // (that is the point). It is reputation-NEUTRAL (the reviewer was neither validated-correct
  // nor wrong) and never pins an FP, so it can't be abused to punish a correct reviewer.
  action: z.enum([
    "fixed",
    "addressed-elsewhere",
    "deferred-with-followup",
    "acknowledged-low-value",
    "verified-not-applicable",
  ]),
  // Optional in the branch shape; REQUIRED (>= 20) only for "verified-not-applicable" via the
  // union superRefine. (A superRefine returns a ZodEffects, which z.discriminatedUnion's raw
  // ZodObject branch list cannot accept — so the refine MUST live on the union, not here.)
  reason: z.string().optional(),
  files_touched: z.array(z.string()).optional(),
  commit_message_hint: z.string().optional(),
});

const Rejected = Base.extend({
  verdict: z.literal("rejected"),
  reason: z.string().min(20),
  reviewer_was_wrong: z.boolean().optional(),
});

export const DecisionEntrySchema = z
  .discriminatedUnion("verdict", [Accepted, Rejected])
  .superRefine((d, ctx) => {
    // P6: a verified-not-applicable disposition must carry the verification evidence
    // (>= 20 chars), exactly like a rejection reason. Missing/short → invalid → the finding
    // stays blocking (fail-closed), so a lazy/empty "it's fine" can never unblock.
    if (d.verdict === "accepted" && d.action === "verified-not-applicable") {
      if (typeof d.reason !== "string" || d.reason.length < 20) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reason"],
          message:
            "verified-not-applicable requires a reason of >= 20 chars documenting why the finding does not apply here",
        });
      }
    }
  });
export type DecisionEntry = z.infer<typeof DecisionEntrySchema>;
