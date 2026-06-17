import type { ReviewgateState } from "../schemas/state.ts";

// Rec #3 (deep half) — pre-push gate. The Stop-hook runs at TURN-END and has no authority over
// a later `git push`, so a "clean" turn-end pass can be pushed (→ Coolify auto-deploy) BEFORE a
// deeper review ran (the field-report scenario). This pure check decides, from the persisted gate
// state, whether the commit being pushed has a RECORDED clean Reviewgate PASS. It is WARN-ONLY by
// policy (the caller prints a warning and ALWAYS exits 0) — fail-safe: it never blocks a push, it
// only surfaces "this SHA isn't recorded as reviewed-clean; not deploy-ready". A hard guarantee
// belongs server-side in CI (see docs), not a bypassable local hook.

export interface PrePushVerdict {
  /** true ⇒ a clean Reviewgate PASS is recorded for the pushed tip (no warning needed). */
  ok: boolean;
  /** Human-readable explanation, always set (shown in the warning when !ok). */
  reason: string;
}

const short = (sha: string): string => sha.slice(0, 7);

/**
 * Decide whether the pushed commit(s) carry a recorded clean Reviewgate PASS. Pure + best-effort:
 * reads ONLY what state.json reliably records (a clean PASS re-arms → iteration 0 + the reviewed
 * HEAD sha). `pushedShas` are the local tip oids git hands the pre-push hook, with deletes/zeros
 * already filtered out by the caller.
 */
export function evaluatePrePush(input: {
  pushedShas: string[];
  state: ReviewgateState | null;
}): PrePushVerdict {
  const { pushedShas, state } = input;
  if (pushedShas.length === 0) {
    return { ok: true, reason: "Nothing to review (branch delete or up-to-date)." };
  }
  if (!state) {
    return {
      ok: false,
      reason:
        "no Reviewgate state found (.reviewgate/state.json) — this commit has no recorded review",
    };
  }
  if (state.escalated) {
    return {
      ok: false,
      reason: `Reviewgate is ESCALATED (${state.escalation_reason ?? "unknown"}) — unresolved findings; not deploy-ready`,
    };
  }
  // A clean PASS re-arms the gate: iteration resets to 0 AND last_reviewed_head_sha holds the
  // reviewed HEAD. A FAIL leaves iteration > 0; a never-reviewed session leaves the sha null.
  const reviewedHead = state.last_reviewed_head_sha;
  const passed = state.iteration === 0 && reviewedHead !== null;
  if (!passed || reviewedHead === null) {
    return {
      ok: false,
      reason: "no clean Reviewgate PASS recorded (the last review did not pass) — not deploy-ready",
    };
  }
  // The pushed tip must BE the last-reviewed HEAD; if newer commits sit on top, the gate never
  // saw the final state being pushed (exactly the field-report case).
  if (!pushedShas.includes(reviewedHead)) {
    return {
      ok: false,
      reason: `the commit being pushed was not the last reviewed HEAD (Reviewgate last passed on ${short(reviewedHead)}) — newer commits may be unreviewed`,
    };
  }
  return { ok: true, reason: `Reviewgate passed on ${short(reviewedHead)} — clear to push.` };
}
