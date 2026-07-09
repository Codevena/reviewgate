// src/config/budgets.ts
//
// Wall-clock budgets for the Stop-hook gate's NON-loop phases, kept in ONE place
// (M-A0) so the doctor's hook-timeout margin check can DERIVE its threshold from
// them instead of duplicating a literal. The fail-open guarantee is:
//
//   SETUP_BUDGET + loop.runTimeoutMs + POST_ABORT_SETTLE  <  OS Stop-hook timeout
//
// If these constants and the doctor margin drift apart, that guarantee could be
// silently invalidated — so doctor imports these rather than hard-coding 150s.

// Shared budget (ms) for ALL pre-loop setup: config load + lock acquire + state
// load + adapter build + git/diff. Bounded as one so their sum can't exceed the
// (OS timeout − runTimeoutMs) margin. See gate.ts runGate / runStopGate.
export const SETUP_BUDGET_MS_DEFAULT = 120_000;

// Cap (ms) for awaiting the run to settle AFTER the loop self-deadline aborts it,
// so a run that ignores the abort can't hang past the OS kill. See loop-driver.ts.
export const POST_ABORT_SETTLE_MS_DEFAULT = 30_000;

// Deadline-aware panel budgeting (see docs/superpowers/plans/2026-07-09-deadline-
// aware-gate-budgeting.md). Reviewer spawns clamp to the remaining run budget
// minus this reserve for the post-panel tail (critic + aggregate + report):
export const PANEL_TAIL_RESERVE_MS = 60_000;
// Below this floor a reviewer spawn is pointless (spawn+model latency alone
// eats it) — skip the spawn instead of starting a doomed run:
export const MIN_REVIEWER_BUDGET_MS = 30_000;
// The critic keeps this much air for aggregate/report after itself:
export const CRITIC_TAIL_RESERVE_MS = 30_000;
// Below this the critic is SKIPPED entirely (fail-safe: no demotions) — a
// floored micro-critic straddling the deadline would be abort-killed and turn
// a completed panel into an incomplete run:
export const MIN_CRITIC_BUDGET_MS = 15_000;
// Cooldown attribution: a timeout is the PROVIDER's fault (cool it down) when
// its granted window was within this slack of its configured timeoutMs; only a
// materially shorter, gate-clamped window suppresses the cooldown. Without
// this, every near-deadline timeout would read as "gate's fault" and the
// treadmill would return through the back door:
export const BUDGET_ATTRIBUTION_SLACK_MS = 30_000;
// Floor for the loop's EFFECTIVE self-deadline after clamping to the installed
// Stop-hook timeout (loop-driver). When the hook timeout is pathologically
// small (cap ≤ 0), the deadline must be floored — never disabled: a disabled
// deadline guarantees the OS kill wins (silent, non-blocking = fail-open),
// while a best-effort short deadline usually still fires first because the
// SETUP budget is a worst case, not the typical few seconds:
export const MIN_RUN_TIMEOUT_MS = 60_000;
