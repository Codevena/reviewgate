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
