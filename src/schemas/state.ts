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
  // Per-iteration count of reviewer_was_wrong rejections, indexed by ABSOLUTE
  // iteration: fp_rejects_history[k] is the FP-reject count of the iteration whose
  // findings are signature_history[k]. Used for the FP-discounted convergence grace
  // (real findings = signatures − FP). Reset to [] on re-arm. `.default([])` for
  // back-compat with state.json written before this field existed.
  fp_rejects_history: z.array(z.number().int().nonnegative()).default([]),
  // Per-cycle suppression (2b): signatures the agent rejected as reviewer_was_wrong
  // in an EARLIER iteration of the CURRENT cycle. The panel demotes any recurrence
  // to INFO so the agent never re-rejects the same finding (and it stops feeding
  // the reviewer-fp-streak). Reset to [] on re-arm. `.default([])` for back-compat.
  cycle_rejected_signatures: z.array(z.string()).default([]),
  // §4.3 Fix-Verification: signatures the agent marked accepted/action:"fixed" in
  // an EARLIER iteration of the CURRENT cycle, mapped to the EARLIEST iteration the
  // claim was made. A later recurrence of the same signature is re-flagged as
  // still-blocking by the aggregator (the claimed fix did not resolve it). `positive`
  // because a claim only follows iteration ≥1's findings. Reset on re-arm.
  // `.default({})` for back-compat with state.json written before this field.
  claimed_fixed_signatures: z.record(z.string(), z.number().int().positive()).default({}),
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
  // Monotonic per-session counter, incremented on every re-arm (clean PASS /
  // commit-recovery). Feeds the reputation event-id namespace so a re-armed cycle
  // (iteration resets to 0, findings renumber from F-001) cannot collide with a
  // prior cycle's events. NOT a gate; never reset to 0 within a session.
  reputation_cycle_seq: z.number().int().nonnegative().default(0),
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
    fp_rejects_history: [],
    decision_history: [],
    cumulative_fp_rejects: 0,
    fp_counted_through_iter: 0,
    cycle_rejected_signatures: [],
    claimed_fixed_signatures: {},
    last_diff_hash: null,
    last_stop_ts: null,
    last_pass_diff_hash: null,
    last_reviewed_head_sha: null,
    started_at: new Date().toISOString(),
    escalated: false,
    escalation_reason: null,
    escalation_announced: false,
    incomplete_runs: 0,
    reputation_cycle_seq: 0,
  };
}
