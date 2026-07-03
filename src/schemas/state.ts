// src/schemas/state.ts
import { z } from "zod";
import { FindingCategory, Severity } from "./finding.ts";

// T1 (field report 2026-07-03): one entry per file of the reviewed diff. The
// keyset of a snapshot/ledger `files` record is a COMPLETE manifest — a missing
// key means "not in the reviewed diff", never "unreadable" (unreadable files get
// an explicit hash:null entry, which consumers treat fail-safe).
export const SnapshotFileEntrySchema = z.object({
  status: z.enum(["present", "deleted", "unreadable"]),
  // sha256 hex of the file's RAW BYTES; null unless status === "present".
  hash: z.string().nullable(),
});
export type SnapshotFileEntry = z.infer<typeof SnapshotFileEntrySchema>;

// Working-tree state the panel ACTUALLY reviewed in the recorded iteration.
// Substrate for the delta-scope demote (iteration ≥ 2 reviews gate only on what
// changed since this state) — written only for FULL-PANEL iterations, so a
// checks-fail or ERROR round can never masquerade as reviewed content.
export const ReviewedSnapshotSchema = z.object({
  iter: z.number().int().nonnegative(),
  verdict: z.string(),
  base_sha: z.string().nullable(),
  files: z.record(z.string(), SnapshotFileEntrySchema),
  // Files of this iteration's blocking (CRITICAL/WARN) findings — persisted here
  // (not re-read from pending.json) because an ERROR/timeout round clobbers
  // pending.json while the snapshot deliberately survives it; the delta gating
  // scope must keep still-contested files in scope across such rounds
  // (adversarial review 2026-07-03). `.default([])` for back-compat.
  blocking_files: z.array(z.string()).default([]),
});
export type ReviewedSnapshot = z.infer<typeof ReviewedSnapshotSchema>;

// Content that passed a clean FULL-coverage panel review. Unlike the byte-keyed
// verdict cache this survives diff re-serialization (untracked --no-index
// synthesis vs committed hunks, message-only amends): a later gate fire whose
// diff files are all byte-identical ledger entries short-circuits to PASS.
// Survives re-arms ("this exact content passed" stays true); cleared on session
// reset; an env_hash mismatch makes it inert.
export const PassLedgerSchema = z.object({
  head_sha: z.string().nullable(),
  // sha256 over the SAME environment inputs as the byte-cache key minus the diff
  // (configHash + behavior-hash composite incl. brain/FP/prompt/host-tier/
  // conventions/foreign/delta segments + RG_VERSION + pending schemaVersion) —
  // a reviewgate upgrade or any behavior-affecting change invalidates the ledger
  // exactly like it invalidates the byte cache (adversarial review 2026-07-03;
  // the first cut compared config_hash only, which served stale-semantics PASSes).
  env_hash: z.string(),
  files: z.record(z.string(), SnapshotFileEntrySchema),
});
export type PassLedger = z.infer<typeof PassLedgerSchema>;

// ONE agent disposition (rejected / verified-not-applicable / fixed) bound to its
// finding's (file, line-range) — the RAW record region memory is derived from.
// Stored un-merged (adversarial review 2026-07-03): merging at write time let a
// later-superseded disposition leave absorbed categories/severity/bounds behind on
// a surviving region; deriving regions fresh at READ time from the surviving raw
// dispositions makes the supersede reconciliation exact. `key` = "<iter>:<finding_id>"
// is the idempotency anchor (re-folding one iteration's decisions can never
// double-count; superseding drops exactly that key's contribution).
export const CycleDispositionSchema = z.object({
  key: z.string(),
  file: z.string(),
  start_line: z.number().int().nonnegative(),
  end_line: z.number().int().nonnegative(),
  severity: Severity,
  categories: z.array(FindingCategory),
  // Agent-authored disposition reason, truncated to ≤ 200 chars at harvest.
  reason: z.string(),
});
export type CycleDisposition = z.infer<typeof CycleDispositionSchema>;

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
  // Non-convergence (field report 2026-06-17): a file:line REGION re-raised as a blocking
  // finding across loop.maxLocationRecurrence consecutive reviewed iterations — the location
  // treadmill where a reviewer re-litigates the same lines under a DIFFERENT signature each
  // round (defeating every signature-keyed guard). Surfaced to the human (block-once, like
  // signature-recurrence); never suppresses the finding.
  "location-recurrence",
  // P3 (field report 2026-06-22): the still-unaddressed BLOCKING findings are all on files this
  // session did not author (foreign_to_session) — e.g. a parallel agent's uncommitted work in a
  // shared checkout. NOT the agent ignoring its own work: it correctly declined to edit foreign
  // code. Surfaced to the human (allow-stop, non-accusatory) instead of the "you ignored this"
  // decisions-unaddressed framing. Only reached when foreign findings are kept BLOCKING (the
  // outOfDiffBlocking opt-in); by default Slice A demotes them to advisory and this never fires.
  "findings-out-of-scope",
  // S2 (field report 2026-06-23): the agent honestly disowned the whole change-set as NOT its
  // session's work — the COMMITTED-foreign case (a parallel agent's already-merged commits that
  // entered this session's reviewed diff in a shared checkout, which P2's byte-identity baseline
  // can't tag foreign_to_session). Reached ONLY when the session produced zero attributable
  // (uncommitted) work in the diff (whole_diff_attributable=false). ALLOW-STOP + non-accusatory
  // ESCALATION.md (never a faked PASS, never re-arms) — the honest "escalate + pause" handoff.
  "session-disowned",
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
  // Non-convergence (field report 2026-06-17): per-iteration finding REGION keys
  // (`file:line-bucket`), INDEX-ALIGNED with signature_history (appended + reset at the same
  // points). The location-keyed sibling of signature_history — lets the gate detect a region
  // re-litigated under a churning signature, which signature_history alone misses. Reset to []
  // on re-arm. `.default([])` for back-compat with state.json written before this field.
  location_history: z.array(z.array(z.string())).default([]),
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
  // Stable-Code-Guard (field report 2026-06-17): union of `files_touched` the agent recorded in
  // accepted decisions across THIS cycle. A finding (iter ≥ 2) on a file NOT in this set is on
  // code the agent never edited while iterating — stable across the loop — so a fresh finding on
  // it is flagged `stable_code` (advisory; the reviewer is re-reviewing unchanged code). Reset to
  // [] on re-arm. `.default([])` for back-compat with state.json written before this field.
  agent_touched_files: z.array(z.string()).default([]),
  // §4.3 Fix-Verification: signatures the agent marked accepted/action:"fixed" in
  // an EARLIER iteration of the CURRENT cycle, mapped to the EARLIEST iteration the
  // claim was made. A later recurrence of the same signature is re-flagged as
  // still-blocking by the aggregator (the claimed fix did not resolve it). `positive`
  // because a claim only follows iteration ≥1's findings. Reset on re-arm.
  // `.default({})` for back-compat with state.json written before this field.
  claimed_fixed_signatures: z.record(z.string(), z.number().int().positive()).default({}),
  // T1 (field report 2026-07-03): working-tree manifest of the last FULL-PANEL
  // iteration this cycle (null on ERROR/checks-only rounds and until the first
  // panel round). Cleared on re-arm; substrate for the delta-scope demote.
  // `.default(null)` for back-compat with state.json written before this field.
  reviewed_snapshot: ReviewedSnapshotSchema.nullable().default(null),
  // T1/T3: RAW dispositions the agent explicitly REJECTED (verdict:rejected /
  // verified-not-applicable) resp. ADDRESSED (accepted/action:"fixed") this cycle,
  // harvested from decisions × pending.json. Regions are DERIVED from these at
  // read time (region-memory.ts mergeRegions) — see CycleDispositionSchema for why
  // raw storage. Rejected dispositions feed the region-rejection demote (≥ 2
  // distinct + category-compatible); addressed ones feed the (follow-up)
  // contradiction badge. Cleared on re-arm. `.default([])` for back-compat.
  cycle_rejected_dispositions: z.array(CycleDispositionSchema).default([]),
  cycle_addressed_dispositions: z.array(CycleDispositionSchema).default([]),
  // T1/T3/T6: count of findings the region-rejection pass demoted in the LATEST
  // completed panel iteration (per-iteration, NOT cycle-cumulative — the contested
  // breaker weighs it against the same iteration's decisions; a cumulative count
  // re-weighed against every later round's shrinking sample would fire on
  // HEALTHIER rounds, adversarial review 2026-07-03). Preserved across ERROR
  // rounds; cleared on re-arm. `.default(0)` for back-compat.
  region_suppressed_hits: z.number().int().nonnegative().default(0),
  // T1/T5: content that passed a clean full-coverage panel review. Written on
  // PASS re-arm (T5), consulted by the content-identity short-circuit, survives
  // commit/escalation re-arms, cleared on session reset. `.default(null)` for
  // back-compat with state.json written before this field.
  pass_ledger: PassLedgerSchema.nullable().default(null),
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
    location_history: [],
    iteration_stats: [],
    fp_rejects_history: [],
    max_iterations_override: null,
    decision_history: [],
    cumulative_fp_rejects: 0,
    fp_counted_through_iter: 0,
    decisions_emitted_through_iter: 0,
    cycle_rejected_signatures: [],
    agent_touched_files: [],
    claimed_fixed_signatures: {},
    reviewed_snapshot: null,
    cycle_rejected_dispositions: [],
    cycle_addressed_dispositions: [],
    region_suppressed_hits: 0,
    pass_ledger: null,
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
