# Spec — FP-discounted convergence grace (Bug 3a)

**Date:** 2026-05-28
**Status:** Approved (design v3), pending implementation plan
**Author:** brainstormed with Markus

> **v3 (2nd agy spec-review):** the v2 "fold at the existing site" had two more real
> CRITICALs: the fold is gated on `fpThreshold > 0`, so a disabled streak breaker
> left `fp_rejects_history` empty; and a bare `push` misaligns indices on a
> back-compat upgrade (old state loads `[]` while `signature_history` is populated).
> v3 decouples the fold from the streak threshold and writes `fp_rejects_history` by
> ABSOLUTE index with zero-padding (see §2).

> **v2 (after agy spec-review):** agy found two real CRITICALs + a WARN in v1.
> (1) `signature_history` and `fp_rejects_history` are appended at DIFFERENT
> lifecycle points (iteration-completion vs decision-fold), so at the convergence
> check their lengths differ — relative `.at(-1)/.at(-2)` on both misaligns.
> (2) Hoisting the fold into `absorbPriorDecisions` (called at ~421, AFTER the
> maxIter check at ~331) would still read stale data without a risky control-flow
> reorder. (3) If `fpStreakThreshold === 0` the runaway backstop is gone, so the
> `lastReal === 0` grace could run a pure-FP loop to the hard cap. v2 fixes all
> three: **absolute indexing**, **compute the latest iteration's FP-rejects fresh
> at the check** (no fold hoist), and **gate the `lastReal===0` grace on
> `fpStreakThreshold > 0`**.

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

There is already an `iteration_stats` array kept **length-aligned with
`signature_history`**, appended at iteration-completion (loop-driver ~571) and
reset to `[]` on re-arm. We add a sibling, indexed by ABSOLUTE iteration:

```ts
// Per-iteration count of reviewer_was_wrong rejections, indexed by absolute
// iteration: fp_rejects_history[k] is the FP-reject count of the iteration whose
// findings are signature_history[k]. Appended once per iteration at the existing
// FP fold (guarded by fp_counted_through_iter), so it lags signature_history by at
// most the current (not-yet-folded) iteration. Reset to [] on re-arm.
// `.default([])` for back-compat.
fp_rejects_history: z.array(z.number().int().nonnegative()).default([]),
```

Wherever `signature_history`/`iteration_stats` are reset to `[]` on re-arm (clean
PASS / commit recovery), reset `fp_rejects_history` to `[]` too.

### 2. Fold FP-rejects per iteration — decoupled from the streak threshold, absolute-index-aligned (`src/core/loop-driver.ts` ~452-470)

Today the whole fold block is gated `if (fpThreshold > 0 && state.iteration >
state.fp_counted_through_iter)` — so when the streak breaker is disabled
(`fpStreakThreshold === 0`) nothing folds and `fp_rejects_history` would stay empty
(agy CRITICAL #1). **Split the block:**

- **Fold (always, when there is a new iteration to count):** guard ONLY on
  `state.iteration > state.fp_counted_through_iter` (drop the `fpThreshold > 0`
  condition). Update `cumulative_fp_rejects += rr.wrongRejects`, advance
  `fp_counted_through_iter`, AND write `fp_rejects_history`.
- **Escalation check (unchanged gate):** keep `if (fpThreshold > 0 && cumulativeFp
  >= fpThreshold) escalate("reviewer-fp-streak")`.

**Write `fp_rejects_history` by ABSOLUTE index with zero-padding** (agy CRITICAL #2 —
a mid-cycle upgrade loads `fp_rejects_history: []` while `signature_history` already
has entries; a bare `push` would land iteration N's value at index 0). Target the
index of the latest completed iteration = `signature_history.length - 1`:

```ts
        const idx = cur.signature_history.length - 1; // latest completed iteration
        const fph = cur.fp_rejects_history.slice();
        while (fph.length < idx) fph.push(0);          // pad historical gaps (upgrade/self-heal)
        fph[idx] = rr.wrongRejects;                    // dense, absolute-aligned
        // ...fp_rejects_history: fph in the state update
```

Invariant after the fold: `fp_rejects_history.length === signature_history.length`
and `fp_rejects_history[k]` is iteration k's FP-reject count. No reorder of
`absorbPriorDecisions` or the decisions-gate (the latest iteration's FP-rejects are
computed fresh in §3, so the check never depends on the fold having run first).

### 3. FP-discounted convergence predicate, absolute-indexed + fresh latest (`src/core/loop-driver.ts` ~331-356)

Compute the latest completed iteration's FP-rejects fresh (reuse
`previousFindingIds` + `computeRejectRate`, the same call the reject-rate breaker
makes later — compute once and thread it down to avoid a double read). Index both
histories by ABSOLUTE position:

```ts
      const hist = state.signature_history;
      const fpHist = state.fp_rejects_history;
      const n = hist.length;
      // Latest iteration's FP-rejects are not folded into fpHist yet (the fold runs
      // after this check), so compute them fresh from the current pending +
      // decisions. `latestWrong` is reused by the reject-rate breaker below.
      const latestWrong = n > 0 ? computeRejectRate(this.i.repoRoot, state.iteration, previousFindingIds(this.i.repoRoot)).wrongRejects : 0;
      const realAt = (k: number, wrongOverride?: number) =>
        Math.max(0, (hist[k]?.length ?? 0) - (wrongOverride ?? fpHist[k] ?? 0));
      const lastReal = n > 0 ? realAt(n - 1, latestWrong) : Number.POSITIVE_INFINITY;
      const prevReal = n >= 2 ? realAt(n - 2) : Number.POSITIVE_INFINITY;
      const fpStreakOn = this.i.config.loop.fpStreakThreshold > 0;
      // Converging = REAL (non-FP) findings strictly fewer than the previous round,
      // OR no real findings remain (agent resolved everything genuine; only reviewer
      // FPs left — the fp-streak breaker's job, IF it is enabled). Total-count is NOT
      // used: the panel can add fresh FPs faster than real findings are fixed.
      const progressing =
        n >= 2 && (lastReal < prevReal || (lastReal === 0 && fpStreakOn));
```

Notes:
- **Absolute indices** (`n-1`, `n-2`) — never relative `.at()` across the two
  arrays — so the length lag between `signature_history` and `fp_rejects_history`
  cannot misalign them (agy CRITICAL #1).
- **`latestWrong` computed fresh** — the convergence check no longer depends on the
  fold having run first; no `absorbPriorDecisions` reorder needed (agy CRITICAL #2).
- **`lastReal === 0` grace gated on `fpStreakThreshold > 0`** — if the streak
  backstop is disabled, an all-FP cycle escalates at maxIterations as before, not
  at the hard cap (agy WARN #3).
- Escalation reason: `Reached ${state.iteration} iterations without convergence (real findings not decreasing).`
- Hard cap (`maxIter * 2`), cost-cap, stuck-signature detection unchanged.
- To avoid reading `decisions/<iter>.jsonl` twice, compute `latestWrong` once and
  pass it to the later reject-rate / fp-streak block (which already calls
  `computeRejectRate(... state.iteration ...)`).

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
2. **All-FP endpoint (streak enabled):** `lastReal === 0` (every latest finding
   FP-rejected) with `fpStreakThreshold > 0` → grace (no "not converging"
   escalation; the streak breaker is the backstop).
2b. **All-FP endpoint (streak DISABLED):** `lastReal === 0` with
   `fpStreakThreshold === 0` → escalate at maxIterations (no grace), preserving the
   pre-change bound (agy WARN #3).
3. **Genuine non-convergence:** real findings flat/rising and >0 (e.g. real 3,3,4)
   → escalate with "real findings not decreasing".
4. **FP-runaway still caught:** real findings falling but `cumulative_fp_rejects ≥
   fpStreakThreshold` → passes maxIter grace, then the fp-streak breaker escalates
   with reason `reviewer-fp-streak`.
5. **Alignment + reset:** `fp_rejects_history` stays index-aligned with
   `signature_history`; both reset to `[]` on re-arm (clean PASS / commit).
6. **Back-compat:** state persisted without `fp_rejects_history` loads (`.default([])`)
   and behaves as all-zero FP history (real == total).
7. **Idempotent fold:** a re-stop of the same iteration does not double-write
   `fp_rejects_history` (guarded by `fp_counted_through_iter`).
8. **Fold runs with streak breaker disabled:** `fpStreakThreshold === 0` still folds
   `fp_rejects_history` (decoupled), so the convergence check stays FP-discounted
   (agy CRITICAL #1).
9. **Back-compat upgrade alignment:** state loaded with `fp_rejects_history: []` but
   a populated `signature_history` → the next fold zero-pads to the latest index, so
   `fp_rejects_history[k]` still pairs with `signature_history[k]` (agy CRITICAL #2);
   the convergence check degrades gracefully (missing → 0) for the straddling cycle.

## Non-goals / YAGNI

- No quota-degradation / panel-adaptation changes (Bug 3b).
- No change to the fp-streak threshold or the stuck/cost/hard-cap backstops.
- No change to how decisions or reject-rate are computed (reuse `computeRejectRate`).

## Acceptance criteria

1. A cycle whose REAL findings decrease (even as total count rises from FP churn,
   and even with FP rejections) is NOT escalated at maxIterations.
2. `lastReal === 0` (only FPs remain) does not trigger a "not converging" escalation
   WHEN `fpStreakThreshold > 0`; with the streak breaker disabled (`=== 0`) it still
   escalates at maxIterations.
2b. The convergence check uses ABSOLUTE indices and computes the latest iteration's
   FP-rejects fresh — it does not depend on the FP fold having run first, and the
   `signature_history`/`fp_rejects_history` length lag never misaligns them.
3. A cycle with non-decreasing real findings (>0) still escalates "max-iterations
   (real findings not decreasing)".
4. Genuine FP-runaway still escalates via the reviewer-fp-streak breaker with its
   own reason.
5. `fp_rejects_history` is index-aligned with `signature_history`, reset on re-arm,
   folded idempotently, and back-compatible (`.default([])`).
6. `bunx tsc --noEmit`, `bun run lint`, full `bun test` clean.
