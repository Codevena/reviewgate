# Spec — FP-discounted convergence grace (Bug 3a)

**Date:** 2026-05-28
**Status:** Approved (design), pending implementation plan
**Author:** brainstormed with Markus

## Problem / Motivation

A flashbuddy agent's Reviewgate run ESCALATED at max-iterations ("findings not
decreasing") even though the agent was making real progress — fixing genuine bugs
each round and rejecting verified false positives. Root cause (verified in
`src/core/loop-driver.ts`):

```js
const progressing = hist.length >= 2 && lastN < prevN && state.cumulative_fp_rejects === 0;
```

Two flaws:
1. **Total-count is the wrong progress signal.** The panel surfaced NEW false
   positives each round faster than the agent removed real findings, so the TOTAL
   count rose (≈2→…→6). `lastN < prevN` was false regardless — count-based progress
   is blind to real progress masked by FP churn.
2. **Any FP rejection denies the grace.** `cumulative_fp_rejects === 0` means a
   single verified-FP rejection flips `progressing` to false — punishing the agent
   for correctly rejecting a reviewer's hallucination.

There is already a dedicated FP-runaway breaker — the **reviewer-fp-streak**
escalation (`cumulative_fp_rejects >= loop.fpStreakThreshold`, default 3,
loop-driver.ts ~452-470). It is the correct mechanism for genuine reviewer
runaway. The convergence-grace's `=== 0` clause is redundant with it and far too
strict.

This is **Bug 3a** ([[project-reviewer-fp-runaway-loop]] follow-up). **Bug 3b**
(persistent quota-degradation policy — codex was quota-down all 3 rounds → 3/4
reviewers) is a separate spec.

## Decisions (locked during brainstorming)

1. **Measure progress on REAL findings, not total count.** Real findings in an
   iteration = `signatures.length − (reviewer_was_wrong rejections that iteration)`.
2. **Grant grace if real findings are decreasing OR zero remain (Option A + B).**
   `lastReal < prevReal` (converging on real issues) OR `lastReal === 0` (the agent
   has resolved everything genuine; only FPs remain).
3. **Keep the reviewer-fp-streak breaker as the runaway backstop.** Unchanged. A
   cycle with falling real findings but high FP count now passes the maxIter grace
   and then escalates via the streak breaker — with the correct `reviewer-fp-streak`
   reason instead of the misleading `max-iterations`.
4. **Scope: 3a only.** No quota-degradation changes (3b).

## Background — current state + flow

- `state.signature_history: string[][]` — one entry per completed iteration, the
  finding signatures that iteration (length = finding count).
- `state.cumulative_fp_rejects: number` — running sum of `reviewer_was_wrong`
  rejections across the cycle, folded once per iteration via
  `fp_counted_through_iter`; reset to 0 on re-arm. (schemas/state.ts ~54.)
- `computeRejectRate(repoRoot, iter, requiredIds)` (fp-ledger/reject-rate.ts)
  returns `wrongRejects` = count of `reviewer_was_wrong` rejections for that iter.
- loop-driver `runStop` order today: re-arm checks → **maxIter convergence check
  (~331)** → stuck-signatures → decisions-gate → reject-rate breaker → **fp-streak
  fold+breaker (~452, folds the latest iter's wrongRejects into
  cumulative_fp_rejects)** → run next iteration.
- **Ordering gap:** the latest iteration's `wrongRejects` is folded at ~454, AFTER
  the maxIter check at ~331 reads `cumulative_fp_rejects`. So today the convergence
  check lags one iteration's rejects. The new design must read the latest
  iteration's real-finding count, so the per-iteration FP-reject count must be
  available to the convergence check.

## Design

### 1. State: per-iteration FP-reject history (`src/schemas/state.ts`)

Add a field aligned 1:1 with `signature_history`:

```ts
// Per-iteration count of reviewer_was_wrong rejections, aligned index-for-index
// with signature_history (fp_rejects_history[i] ↔ signature_history[i]). Used to
// compute the REAL-finding trajectory (total − FP) for the convergence grace.
// Reset to [] on re-arm. `.default([])` for back-compat with pre-existing state.
fp_rejects_history: z.array(z.number().int().nonnegative()).default([]),
```

Wherever `signature_history` is reset to `[]` on re-arm (clean PASS / commit
recovery), reset `fp_rejects_history` to `[]` too.

### 2. Record FP-rejects per iteration, before the convergence check (`src/core/loop-driver.ts`)

When the latest completed iteration's decisions are absorbed (the same point that
folds `cumulative_fp_rejects` — keep that), append that iteration's `wrongRejects`
to `fp_rejects_history` so the array stays aligned with `signature_history`, and
ensure this happens **before** the maxIter convergence check reads it. The
idempotency guard (`fp_counted_through_iter`) must gate the append too, so a
re-stop of the same iteration does not double-append.

Concretely: hoist the per-iteration FP-reject fold (currently at ~452-461) so both
`cumulative_fp_rejects` and the new `fp_rejects_history` append run in
`absorbPriorDecisions` (alongside the already-hoisted reputation/FP-ledger
learning), guarded by `fp_counted_through_iter`. The fp-streak threshold *check*
stays where it is (after the maxIter check) and reads the now-folded
`cumulative_fp_rejects`.

### 3. FP-discounted convergence predicate (`src/core/loop-driver.ts` ~331-356)

Replace the `lastN`/`prevN`/`cumulative_fp_rejects === 0` logic:

```ts
      const hist = state.signature_history;
      const fpHist = state.fp_rejects_history;
      const realAt = (i: number) => Math.max(0, (hist.at(i)?.length ?? 0) - (fpHist.at(i) ?? 0));
      const lastReal = realAt(-1);
      const prevReal = hist.length >= 2 ? realAt(-2) : Number.POSITIVE_INFINITY;
      // Converging = REAL (non-FP) findings strictly fewer than the previous round,
      // OR no real findings remain (the agent resolved everything genuine; only
      // reviewer FPs are left — those are the fp-streak breaker's job, not a
      // "not converging" escalation). Total-count is NOT used: the panel can add
      // fresh FPs faster than real findings are fixed, masking real progress.
      const progressing = hist.length >= 2 && (lastReal < prevReal || lastReal === 0);
```

The escalation reason becomes:
`Reached ${state.iteration} iterations without convergence (real findings not decreasing).`

The hard cap (`maxIter * 2`), cost-cap, and stuck-signature detection are
unchanged upper bounds.

## Components / isolation

- `src/schemas/state.ts` — owns persisted shape; the new array is validated here.
- `src/core/loop-driver.ts` — owns the gate decision; the predicate + the
  per-iteration FP-reject fold live here. No new module needed.

## Testing (`tests/unit/loop-driver.test.ts`)

Drive `LoopDriver` with crafted state (existing tests already construct
`signature_history`); add `fp_rejects_history` alongside:

1. **Real progress despite FPs:** signature counts flat/rising (e.g. 4,5,6) but
   `fp_rejects_history` such that real = 4,3,2 → at maxIter, grace granted, NO
   escalation (runs another iteration). The flashbuddy shape.
2. **All-FP endpoint:** `lastReal === 0` (every latest finding FP-rejected) → grace
   (no "not converging" escalation).
3. **Genuine non-convergence:** real findings flat/rising and >0 (e.g. real 3,3,4)
   → escalate with "real findings not decreasing".
4. **FP-runaway still caught:** real findings falling but `cumulative_fp_rejects ≥
   fpStreakThreshold` → passes maxIter grace, then the fp-streak breaker escalates
   with reason `reviewer-fp-streak`.
5. **Alignment + reset:** `fp_rejects_history` stays index-aligned with
   `signature_history`; both reset to `[]` on re-arm (clean PASS / commit).
6. **Back-compat:** state persisted without `fp_rejects_history` loads (`.default([])`)
   and behaves as all-zero FP history (real == total).
7. **Idempotent fold:** a re-stop of the same iteration does not double-append to
   `fp_rejects_history` (guarded by `fp_counted_through_iter`).

## Non-goals / YAGNI

- No quota-degradation / panel-adaptation changes (Bug 3b).
- No change to the fp-streak threshold or the stuck/cost/hard-cap backstops.
- No change to how decisions or reject-rate are computed (reuse `computeRejectRate`).

## Acceptance criteria

1. A cycle whose REAL findings decrease (even as total count rises from FP churn,
   and even with FP rejections) is NOT escalated at maxIterations.
2. `lastReal === 0` (only FPs remain) does not trigger a "not converging" escalation.
3. A cycle with non-decreasing real findings (>0) still escalates "max-iterations
   (real findings not decreasing)".
4. Genuine FP-runaway still escalates via the reviewer-fp-streak breaker with its
   own reason.
5. `fp_rejects_history` is index-aligned with `signature_history`, reset on re-arm,
   folded idempotently, and back-compatible (`.default([])`).
6. `bunx tsc --noEmit`, `bun run lint`, full `bun test` clean.
