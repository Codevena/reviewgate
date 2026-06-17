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
  // No reviewer could complete a review (every attempt failed quota/timeout/error)
  // for `infraDeferMaxConsecutive` consecutive turns. The gate DEFERS a bounded
  // number of turns (re-reviewing each, keeping the change flagged) then escalates
  // to the human so a persistent provider outage / misconfig is never silently
  // deferred forever — distinct from a code-quality FAIL.
  "infra-unavailable",
  // A single BLOCKING finding's signature recurred across loop.maxSignatureRecurrence
  // consecutive reviewed iterations — a treadmill where one finding sticks while the
  // set churns (the whole-set stuck-signatures check misses it). Surfaced to the
  // human (block-once, like stuck-signatures); never suppresses the finding.
  "signature-recurrence",
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
  // Precision metric: per-cycle watermark — highest iteration whose decisions have
  // already been emitted as decision.applied audit events (idempotency guard so a
  // re-stop of the same iteration can't double-emit). Reset to 0 on re-arm, exactly
  // like fp_counted_through_iter. `.default(0)` for back-compat with older state.json.
  decisions_emitted_through_iter: z.number().int().nonnegative().default(0),
  // Per-iteration count of reviewer_was_wrong rejections, indexed by ABSOLUTE
  // iteration: fp_rejects_history[k] is the FP-reject count of the iteration whose
  // findings are signature_history[k]. Used for the FP-discounted convergence grace
  // (real findings = signatures − FP). Reset to [] on re-arm. `.default([])` for
  // back-compat with state.json written before this field existed.
  fp_rejects_history: z.array(z.number().int().nonnegative()).default([]),
  // N1: the most recent non-passing iteration's triage maxIterationsOverride — the
  // per-diff soft iteration cap (min'd with config.loop.maxIterations by the cap
  // precondition). Persisted because the cap is checked in LoopDriver BEFORE a new
  // iteration runs (where triage isn't recomputed). null ⇒ no override (use config).
  // Reset to null on a clean PASS / re-arm. `.default(null)` for back-compat.
  max_iterations_override: z.number().int().positive().nullable().default(null),
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
  // Consecutive turns the gate DEFERRED because no reviewer could complete a review
  // (all quota/timeout/error). Like incomplete_runs it is NOT a review round and does
  // not advance `iteration`; tracked separately so a bounded number of infra-defers
  // escalates to the human (a persistent outage must not silently defer forever).
  // Reset to 0 whenever a review actually completes (any verdict). `.default(0)` for
  // back-compat with state.json written before this field existed.
  consecutive_infra_defers: z.number().int().nonnegative().default(0),
  // #10: consecutive turns the gate DEFERRED a give-up escalation (max-iterations
  // / stuck-signatures) because a configured reviewer was in cooldown (quota cap
  // or timeout/error backoff). Like consecutive_infra_defers it is NOT a review
  // round and does not advance `iteration`; bounded by loop.quotaDeferMaxConsecutive
  // so a persistently-degraded panel escalates instead of deferring forever. Reset
  // to 0 when an escalation proceeds or a review completes. .default(0) for back-compat.
  consecutive_quota_defers: z.number().int().nonnegative().default(0),
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
    max_iterations_override: null,
    decision_history: [],
    cumulative_fp_rejects: 0,
    fp_counted_through_iter: 0,
    decisions_emitted_through_iter: 0,
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
    consecutive_infra_defers: 0,
    consecutive_quota_defers: 0,
    incomplete_runs: 0,
    reputation_cycle_seq: 0,
  };
}
