// src/schemas/state.ts
import { z } from "zod";

export const EscalationReason = z.enum([
  "max-iterations",
  "cost-cap",
  "stuck-signatures",
  "reject-rate-high",
  // A reviewer produced a streak of CONFIRMED false positives accumulated ACROSS
  // iterations (each a fresh, differently-phrased FP → signature-keyed defenses
  // and the single-iteration reject-rate all miss it). Surfaces a faulty reviewer.
  "reviewer-fp-streak",
  "decisions-unaddressed",
  // The review repeatedly could not finish within loop.runTimeoutMs (it would
  // otherwise be killed by the Stop-hook timeout). Surfaced to the human after
  // consecutive incomplete runs so a permanently-hanging provider can't loop.
  "review-timeout",
]);
export type EscalationReason = z.infer<typeof EscalationReason>;

export const ReviewgateStateSchema = z.object({
  schema: z.literal("reviewgate.state.v1"),
  session_id: z.string(),
  iteration: z.number().int().nonnegative(),
  cost_usd_so_far: z.number().nonnegative(),
  tokens_so_far: z.object({
    input: z.number().int().nonnegative(),
    output: z.number().int().nonnegative(),
  }),
  signature_history: z.array(z.array(z.string())),
  // Per-iteration severity counts + verdict + cost, kept length-aligned with
  // signature_history (appended and reset at the same points). Lets the escalation
  // report show ACCURATE CRIT/WARN per iteration instead of 0 for the non-final
  // rows. `.default([])` for back-compat with state.json written before this field.
  iteration_stats: z
    .array(
      z.object({
        critical: z.number().int().nonnegative(),
        warn: z.number().int().nonnegative(),
        info: z.number().int().nonnegative(),
        cost_usd: z.number().nonnegative(),
        verdict: z.string(),
      }),
    )
    .default([]),
  decision_history: z.array(
    z.object({
      iter: z.number().int().nonnegative(),
      accepted: z.array(z.string()),
      rejected: z.array(z.string()),
    }),
  ),
  // Cross-iteration confirmed-FP accumulator for the reviewer-fp-streak breaker.
  // `cumulative_fp_rejects` sums (reviewer_was_wrong) rejects of REAL findings over
  // the cycle; `fp_counted_through_iter` is the highest iteration already folded in
  // (idempotency guard so a re-stop of the same iteration can't double-count). Both
  // reset to 0 on re-arm (clean PASS / commit-recovery). `.default(0)` for back-compat.
  cumulative_fp_rejects: z.number().int().nonnegative().default(0),
  fp_counted_through_iter: z.number().int().nonnegative().default(0),
  last_diff_hash: z.string().nullable(),
  last_stop_ts: z.string().nullable(),
  last_pass_diff_hash: z.string().nullable(),
  // HEAD sha at the last review. Used to detect a commit (HEAD moved) between
  // stops, which re-arms the gate for the next batch of uncommitted changes.
  last_reviewed_head_sha: z.string().nullable().default(null),
  started_at: z.string(),
  escalated: z.boolean(),
  escalation_reason: EscalationReason.nullable(),
  // Whether the current escalation has already been surfaced to the agent via a
  // one-time block. Prevents the escalation block from looping; cleared on re-arm.
  escalation_announced: z.boolean().default(false),
  // Consecutive gate runs that hit loop.runTimeoutMs without completing. NOT a
  // review round (no findings produced), so it does not advance `iteration`;
  // tracked separately to escalate after repeated timeouts. Reset to 0 whenever
  // a review actually completes (any verdict).
  incomplete_runs: z.number().int().nonnegative().default(0),
  recovered_from: z.enum(["crash", "corruption"]).optional(),
});

export type ReviewgateState = z.infer<typeof ReviewgateStateSchema>;

export function initialState(sessionId: string): ReviewgateState {
  return {
    schema: "reviewgate.state.v1",
    session_id: sessionId,
    iteration: 0,
    cost_usd_so_far: 0,
    tokens_so_far: { input: 0, output: 0 },
    signature_history: [],
    iteration_stats: [],
    decision_history: [],
    cumulative_fp_rejects: 0,
    fp_counted_through_iter: 0,
    last_diff_hash: null,
    last_stop_ts: null,
    last_pass_diff_hash: null,
    last_reviewed_head_sha: null,
    started_at: new Date().toISOString(),
    escalated: false,
    escalation_reason: null,
    escalation_announced: false,
    incomplete_runs: 0,
  };
}
