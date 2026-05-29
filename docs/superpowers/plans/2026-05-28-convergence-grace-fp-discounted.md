# FP-discounted convergence grace (Bug 3a) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The max-iterations convergence grace measures progress on REAL findings (total − reviewer_was_wrong rejections) instead of total count, so a cycle that resolves genuine findings while the panel churns false positives is not escalated as "not converging".

**Architecture:** Add a per-iteration `fp_rejects_history` (absolute-index-aligned with `signature_history`), folded once per iteration (decoupled from the streak threshold). The maxIter convergence check computes the latest iteration's FP-rejects fresh (no control-flow reorder), discounts both histories by absolute index, and grants grace if real findings drop or hit zero (the zero case gated on the streak breaker being enabled).

**Tech Stack:** Bun, TypeScript, zod, `bun test`.

**Spec:** `docs/superpowers/specs/2026-05-28-convergence-grace-fp-discounted-design.md` (v3, agy-reviewed PASS)

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/schemas/state.ts` | persisted state shape | add `fp_rejects_history` (`.default([])`) + initial-state entry |
| `src/core/loop-driver.ts` | gate decision | decouple FP fold from streak threshold + absolute-index write; reset on re-arm/pass; FP-discounted convergence predicate |
| `tests/unit/loop-driver.test.ts` | gate tests | extend the `drive` harness; convergence + fold + back-compat cases |

`computeRejectRate` (`src/core/fp-ledger/reject-rate.ts`) and `previousFindingIds` (loop-driver) are reused unchanged.

---

## Task 1: State field `fp_rejects_history`

**Files:**
- Modify: `src/schemas/state.ts` (schema ~58, initial-state literal ~94)
- Test: `tests/unit/state-schema.test.ts` (existing) or `tests/unit/loop-driver.test.ts`

- [ ] **Step 1: Add the schema field** in `src/schemas/state.ts`, right after `fp_counted_through_iter`:

```ts
  // Per-iteration count of reviewer_was_wrong rejections, indexed by ABSOLUTE
  // iteration: fp_rejects_history[k] is the FP-reject count of the iteration whose
  // findings are signature_history[k]. Used for the FP-discounted convergence grace
  // (real findings = signatures − FP). Reset to [] on re-arm. `.default([])` for
  // back-compat with state.json written before this field existed.
  fp_rejects_history: z.array(z.number().int().nonnegative()).default([]),
```

- [ ] **Step 2: Add to the initial-state literal** (~line 94-98, where `signature_history: []` etc. are):

```ts
    signature_history: [],
    iteration_stats: [],
    fp_rejects_history: [],
```

(Place `fp_rejects_history: []` adjacent to the other history fields.)

- [ ] **Step 3: Back-compat test** — add to `tests/unit/state-schema.test.ts` (or create it):

```ts
import { describe, expect, it } from "bun:test";
import { ReviewgateStateSchema } from "../../src/schemas/state.ts";

it("defaults fp_rejects_history to [] for state written before the field existed", () => {
  // a minimal pre-existing state object WITHOUT fp_rejects_history
  const parsed = ReviewgateStateSchema.parse({
    schema: "reviewgate.state.v1",
    session_id: "s",
    iteration: 2,
    signature_history: [["a"], ["a", "b"]],
  });
  expect(parsed.fp_rejects_history).toEqual([]);
});
```

(If the schema requires more fields, copy them from an existing state fixture in the test suite; the point is: omitting `fp_rejects_history` parses to `[]`.)

- [ ] **Step 4: Run + typecheck**

Run: `bunx tsc --noEmit && bun test tests/unit/state-schema.test.ts`
Expected: clean + pass.

- [ ] **Step 5: Commit**

```bash
git add src/schemas/state.ts tests/unit/state-schema.test.ts
git commit -m "feat(state): add fp_rejects_history (per-iteration FP-reject counts, default [])"
```

---

## Task 2: Decouple the FP fold from the streak threshold + absolute-index write

**Files:**
- Modify: `src/core/loop-driver.ts` (fold block ~452-470; re-arm reset ~277-289; pass-path reset ~568-589)
- Test: `tests/unit/loop-driver.test.ts`

- [ ] **Step 1: Replace the fold block** at ~452-470. Today:

```ts
      const fpThreshold = this.i.config.loop.fpStreakThreshold;
      if (fpThreshold > 0 && state.iteration > state.fp_counted_through_iter) {
        const cumulativeFp = state.cumulative_fp_rejects + rr.wrongRejects;
        await this.i.state.update((cur) => ReviewgateStateSchema.parse({
          ...cur,
          cumulative_fp_rejects: cur.cumulative_fp_rejects + rr.wrongRejects,
          fp_counted_through_iter: Math.max(cur.fp_counted_through_iter, state.iteration),
        }));
        state = await this.i.state.load();
        if (cumulativeFp >= fpThreshold) {
          return this.escalateAndDecide(state, "reviewer-fp-streak", `${cumulativeFp} confirmed reviewer false positives ...`);
        }
      }
```

becomes (fold ALWAYS when there's a new iteration; only the escalation is gated):

```ts
      const fpThreshold = this.i.config.loop.fpStreakThreshold;
      if (state.iteration > state.fp_counted_through_iter) {
        const cumulativeFp = state.cumulative_fp_rejects + rr.wrongRejects;
        await this.i.state.update((cur) => {
          // Absolute-index write: fp_rejects_history[k] ↔ signature_history[k].
          // Pad historical gaps with 0 (self-heals a back-compat upgrade where
          // signature_history is populated but fp_rejects_history loaded as []).
          const idx = cur.signature_history.length - 1; // latest completed iteration
          const fph = cur.fp_rejects_history.slice();
          while (fph.length < idx) fph.push(0);
          if (idx >= 0) fph[idx] = rr.wrongRejects;
          return ReviewgateStateSchema.parse({
            ...cur,
            cumulative_fp_rejects: cur.cumulative_fp_rejects + rr.wrongRejects,
            fp_counted_through_iter: Math.max(cur.fp_counted_through_iter, state.iteration),
            fp_rejects_history: fph,
          });
        });
        state = await this.i.state.load();
        if (fpThreshold > 0 && cumulativeFp >= fpThreshold) {
          return this.escalateAndDecide(
            state,
            "reviewer-fp-streak",
            `${cumulativeFp} confirmed reviewer false positives accumulated across ${state.iteration} iterations (threshold ${fpThreshold}) — a reviewer appears to be producing persistent false positives. See .reviewgate/pending.md for the rejected findings and their provider; consider disabling or replacing that reviewer in reviewgate.config.ts.`,
          );
        }
      }
```

- [ ] **Step 2: Reset `fp_rejects_history` on re-arm** — in the commit-recovery reset (~277-289, where `signature_history: []` and `iteration_stats: []` are set), add `fp_rejects_history: [],`.

- [ ] **Step 3: Reset on the pass path** — in the post-iteration state update (~568, the `passed ? [] : [...]` block alongside `signature_history`/`iteration_stats`), add:

```ts
        fp_rejects_history: passed ? [] : cur.fp_rejects_history,
```

(On a non-pass we do NOT append here — the fold in Step 1 owns appends. The pass branch resets to `[]` like the sibling histories.)

- [ ] **Step 4: Write the fold test** — add to `tests/unit/loop-driver.test.ts`. This test drives a real iteration with `fpStreakThreshold: 0` and a decisions file containing a reviewer_was_wrong rejection, then asserts `fp_rejects_history` was still written (decoupled). Use the existing harness pieces (`fakeRepo`, `StateStore`, `writeDirty`, `decisionsPath`, `pendingJsonPath`). Concretely:

```ts
it("folds fp_rejects_history even when the streak breaker is disabled (fpStreakThreshold=0)", async () => {
  const repo = fakeRepo();
  const state = new StateStore(repo);
  await state.initialise("01HXQFOLD");
  // one completed iteration (index 0) with one blocking finding F-001
  await state.update((cur) => ({ ...cur, iteration: 1, signature_history: [["sig-a"]] }));
  writeFileSync(pendingJsonPath(repo), JSON.stringify({ findings: [{ id: "F-001", severity: "CRITICAL" }] }));
  mkdirSync(dirname(decisionsPath(repo, 1)), { recursive: true });
  writeFileSync(decisionsPath(repo, 1), JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "rejected", reason: "verified false positive by runtime trace", reviewer_was_wrong: true }) + "\n");
  writeDirty(repo);
  const cfg = { ...defaultConfig, loop: { ...defaultConfig.loop, fpStreakThreshold: 0, maxIterations: 99 } };
  const driver = new LoopDriver({
    repoRoot: repo, config: cfg, state, audit: new AuditLogger(auditDir(repo)),
    orchestrator: new Orchestrator({ repoRoot: repo, config: cfg, adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) }, sandboxMode: "off", hostTier: "opus", diff: "", reasonOnFailEnabled: true }),
    stopHookActive: false,
  });
  await driver.run();
  // iteration 1's decisions folded into fp_rejects_history[0] (decoupled from threshold)
  expect((await state.load()).fp_rejects_history[0]).toBe(1);
});
```

- [ ] **Step 5: Run + verify FAIL→PASS, typecheck/lint**

Run: `bun test tests/unit/loop-driver.test.ts -t "folds fp_rejects_history even when"` (fails before Step 1-3 if written first; passes after). Then `bunx tsc --noEmit && bun run lint`.
Expected: pass + clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/loop-driver.ts tests/unit/loop-driver.test.ts
git commit -m "feat(loop-driver): fold fp_rejects_history per iteration (absolute-index, threshold-decoupled)"
```

---

## Task 3: FP-discounted convergence predicate

**Files:**
- Modify: `src/core/loop-driver.ts` (maxIter block ~331-356)
- Test: `tests/unit/loop-driver.test.ts`

- [ ] **Step 1: Replace the predicate** at ~332-341. Today:

```ts
      const hist = state.signature_history;
      const lastN = hist.at(-1)?.length ?? 0;
      const prevN = hist.at(-2)?.length ?? Number.POSITIVE_INFINITY;
      const progressing = hist.length >= 2 && lastN < prevN && state.cumulative_fp_rejects === 0;
```

becomes:

```ts
      const hist = state.signature_history;
      const fpHist = state.fp_rejects_history;
      const n = hist.length;
      // The latest iteration's FP-rejects are not folded into fpHist yet (the fold
      // runs after this check), so compute them fresh from the current pending +
      // decisions. Absolute indices (n-1, n-2) — never relative .at() across two
      // arrays of possibly different length.
      const latestWrong =
        n > 0 ? computeRejectRate(this.i.repoRoot, state.iteration, previousFindingIds(this.i.repoRoot)).wrongRejects : 0;
      const realAt = (k: number, wrongOverride?: number) =>
        Math.max(0, (hist[k]?.length ?? 0) - (wrongOverride ?? fpHist[k] ?? 0));
      const lastReal = n > 0 ? realAt(n - 1, latestWrong) : Number.POSITIVE_INFINITY;
      const prevReal = n >= 2 ? realAt(n - 2) : Number.POSITIVE_INFINITY;
      const fpStreakOn = this.i.config.loop.fpStreakThreshold > 0;
      // Converging = REAL (non-FP) findings strictly fewer than the prior round, OR
      // no real findings remain (only reviewer FPs left — the fp-streak breaker's
      // job, IF enabled). Total count is NOT used: the panel can add fresh FPs faster
      // than real findings are fixed, masking real progress.
      const progressing = n >= 2 && (lastReal < prevReal || (lastReal === 0 && fpStreakOn));
```

Ensure `computeRejectRate` and `previousFindingIds` are imported/in scope (computeRejectRate is already imported at the top; `previousFindingIds` is a module function).

- [ ] **Step 2: Update the escalation reason** (~351-354):

```ts
        return this.escalateAndDecide(
          state,
          "max-iterations",
          `Reached ${state.iteration} iterations without convergence (real findings not decreasing).`,
        );
```

- [ ] **Step 3: Update the stale comment** above the predicate (the "Genuine convergence = the finding count is dropping AND no confirmed reviewer false positives" block) to describe the real-findings logic.

- [ ] **Step 4: Write the convergence tests** — extend the `drive` harness in the existing `describe("LoopDriver convergence-aware max-iterations")` block to accept `fpHistory`, `fpStreakThreshold`, and optional latest pending/decisions, then add cases. Replace/extend `drive`:

```ts
  async function drive(history: string[][], iteration: number, opts: {
    maxIterations?: number; fpHistory?: number[]; fpStreakThreshold?: number;
    latestFindingIds?: string[]; latestWrongIds?: string[];
  } = {}) {
    const { maxIterations = 3, fpHistory = [], fpStreakThreshold = 3, latestFindingIds, latestWrongIds = [] } = opts;
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQCONV");
    await state.update((cur) => ({ ...cur, iteration, signature_history: history, fp_rejects_history: fpHistory }));
    // Latest-iteration FP-rejects are computed fresh from pending + decisions:
    if (latestFindingIds) {
      writeFileSync(pendingJsonPath(repo), JSON.stringify({ findings: latestFindingIds.map((id) => ({ id, severity: "CRITICAL" })) }));
      mkdirSync(dirname(decisionsPath(repo, iteration)), { recursive: true });
      writeFileSync(decisionsPath(repo, iteration),
        latestWrongIds.map((id) => JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: id, verdict: "rejected", reason: "verified false positive by runtime trace", reviewer_was_wrong: true })).join("\n") + (latestWrongIds.length ? "\n" : ""));
    }
    writeDirty(repo);
    const cfg = { ...defaultConfig, loop: { ...defaultConfig.loop, maxIterations, stuckThreshold: 99, fpStreakThreshold } };
    const driver = new LoopDriver({
      repoRoot: repo, config: cfg, state, audit: new AuditLogger(auditDir(repo)),
      orchestrator: new Orchestrator({ repoRoot: repo, config: cfg, adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) }, sandboxMode: "off", hostTier: "opus", diff: "", reasonOnFailEnabled: true }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    return { decision, state, repo };
  }
```

Then the cases:

```ts
  it("REAL progress despite rising total count (FP churn) does NOT escalate", async () => {
    // total 4 → 5; but iter-1 had 1 FP and the latest (iter 2, 5 findings) has 3 FPs
    // → real 4 → 2 (decreasing). fp_rejects_history[0]=1 (prev); latest computed fresh=3.
    const { state } = await drive(
      [["a", "b", "c", "d"], ["a", "b", "c", "d", "e"]], 3,
      { fpHistory: [1], latestFindingIds: ["F1", "F2", "F3", "F4", "F5"], latestWrongIds: ["F1", "F2", "F3"] },
    );
    expect((await state.load()).escalated).toBe(false); // grace: real 3 → 2
  });

  it("all-FP latest with streak breaker ENABLED → grace (no 'not converging')", async () => {
    // BOTH iterations all-FP → prevReal=0 (2−2) and lastReal=0, so the first clause
    // (lastReal<prevReal = 0<0) is FALSE — grace can only come from (lastReal===0 &&
    // streakOn). This isolates the streak-gate, not the count-drop clause.
    const { state } = await drive(
      [["a", "b"], ["a", "b"]], 3,
      { fpStreakThreshold: 3, fpHistory: [2], latestFindingIds: ["F1", "F2"], latestWrongIds: ["F1", "F2"] },
    );
    expect((await state.load()).escalated).toBe(false); // lastReal===0, streak on
  });

  it("all-FP latest with streak breaker DISABLED → escalates max-iterations", async () => {
    // Same shape (prevReal=0, lastReal=0) but streak OFF → (0===0 && false) → escalate.
    const { decision, state } = await drive(
      [["a", "b"], ["a", "b"]], 3,
      { fpStreakThreshold: 0, fpHistory: [2], latestFindingIds: ["F1", "F2"], latestWrongIds: ["F1", "F2"] },
    );
    expect(decision.kind).toBe("block");
    expect((await state.load()).escalation_reason).toBe("max-iterations");
  });

  it("genuine non-convergence (real findings flat/rising) escalates", async () => {
    // real 2 → 3 (no FPs) → escalate "real findings not decreasing"
    const { state } = await drive(
      [["a", "b"], ["a", "b", "c"]], 3,
      { fpHistory: [0], latestFindingIds: ["F1", "F2", "F3"], latestWrongIds: [] },
    );
    expect((await state.load()).escalation_reason).toBe("max-iterations");
  });
```

- [ ] **Step 5: Run + typecheck + lint**

Run: `bun test tests/unit/loop-driver.test.ts && bunx tsc --noEmit && bun run lint`
Expected: all pass/clean.

- [ ] **Step 6: Commit**

```bash
git add src/core/loop-driver.ts tests/unit/loop-driver.test.ts
git commit -m "feat(loop-driver): FP-discounted convergence grace (real findings, not total count)"
```

---

## Task 4: Full verification + DoD

**Files:** none (verification only)

- [ ] **Step 1: Static + full suite**

Run: `bunx tsc --noEmit && bun run lint && bun test`
Expected: tsc clean, lint clean, all green.

- [ ] **Step 2: Build the binary**

Run: `bun run build`
Expected: `dist/reviewgate` produced, 0 errors.

- [ ] **Step 3: DoD review pipeline** (per project `CLAUDE.md`): run the agy reviewer (foreground, standalone Bash call) + an Opus reviewer over the branch diff, fix all findings, gate. Commit only after both PASS; do NOT push without explicit user permission.
```
