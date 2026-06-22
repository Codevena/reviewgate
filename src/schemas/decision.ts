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
  // P2 (field report 2026-06-22): "out-of-scope" is the honest "not mine" disposition for a
  // finding on a file THIS session did not author (a parallel agent's / pre-existing work in a
  // shared checkout). It is NOT a false-positive claim (the reviewer may be RIGHT) and NOT a
  // verification ("doesn't apply") — it is "correct, but not my code to touch". REQUIRES a
  // `reason` >= 20 (the union superRefine below). The decisions-gate accepts it ONLY when the
  // finding is flagged `foreign_to_session` (Slice A's ownership snapshot) — so it can never be
  // used to wave away a finding on the agent's OWN code (fail-CLOSED without that flag). It is
  // reputation-NEUTRAL (excluded in reputation/learn.ts) and never pins an FP.
  // S2 (field report 2026-06-23): "out-of-session" is the honest "this whole change-set is not my
  // session's work" disposition for the COMMITTED-foreign case — a parallel agent's already-merged
  // commits that entered this session's reviewed diff in a shared checkout (which P2's byte-identity
  // baseline can NOT tag foreign_to_session, because committed files were never working-tree-dirty).
  // The decisions-gate accepts it ONLY when the finding is NOT session-attributable AND the WHOLE
  // diff has zero session-attributable files (the session produced no uncommitted work) — so it can
  // never wave away a finding on the agent's OWN live work. It ALWAYS routes a human ESCALATION
  // (session-disowned, ALLOW_STOP) — it never fakes a PASS. REQUIRES a `reason` >= 20 (union
  // superRefine below). reputation-NEUTRAL (excluded in reputation/learn.ts) and never pins an FP.
  action: z.enum([
    "fixed",
    "addressed-elsewhere",
    "deferred-with-followup",
    "acknowledged-low-value",
    "verified-not-applicable",
    "out-of-scope",
    "out-of-session",
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
    // P6: a verified-not-applicable disposition must carry the verification evidence —
    // >= 20 NON-whitespace chars (20 spaces is not evidence and must not unblock a
    // CRITICAL/security finding, codex DoD). Missing/blank → invalid → stays blocking.
    if (d.verdict === "accepted" && d.action === "verified-not-applicable") {
      if (typeof d.reason !== "string" || d.reason.trim().length < 20) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reason"],
          message:
            "verified-not-applicable requires a reason of >= 20 non-whitespace chars documenting why the finding does not apply here",
        });
      }
    }
    // P2: out-of-scope must carry a substantive reason (>= 20 non-whitespace chars) naming why
    // this file isn't yours / who owns it — a bare disposition must not silence a foreign finding.
    if (d.verdict === "accepted" && d.action === "out-of-scope") {
      if (typeof d.reason !== "string" || d.reason.trim().length < 20) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reason"],
          message:
            "out-of-scope requires a reason of >= 20 non-whitespace chars (why this file is not yours / who owns it)",
        });
      }
    }
    // S2: out-of-session must carry a substantive reason (>= 20 non-whitespace chars) naming why the
    // whole change-set isn't this session's work — a bare disposition must not release the turn.
    if (d.verdict === "accepted" && d.action === "out-of-session") {
      if (typeof d.reason !== "string" || d.reason.trim().length < 20) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["reason"],
          message:
            "out-of-session requires a reason of >= 20 non-whitespace chars (why this whole change-set is not your session's work)",
        });
      }
    }
    // A rejection reason must be substantive too: a 20-space string passes .min(20) but (with
    // reviewer_was_wrong) would pin a REAL finding as a false positive in the FP-ledger.
    if (d.verdict === "rejected" && d.reason.trim().length < 20) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "reason must be >= 20 non-whitespace chars",
      });
    }
  });
export type DecisionEntry = z.infer<typeof DecisionEntrySchema>;
