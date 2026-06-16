# Quota-Degraded Escalation Defer (#10) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the reviewer panel is quota-degraded (a configured reviewer is in cooldown), DEFER the two "give-up" escalations (`max-iterations` soft case, `stuck-signatures`) for a bounded number of turns instead of escalating to the human, then escalate as a fail-closed backstop.

**Architecture:** A single new code path inside `LoopDriver.escalateAndDecide` (the choke point all escalations funnel through), gated by a new `deferableOnQuota` parameter set `true` only at the soft-max-iterations and stuck-signatures call sites. The defer is bounded by a new `consecutive_quota_defers` state counter + a new `loop.quotaDeferMaxConsecutive` config (default 3, 0 disables), mirroring the existing infra-defer pattern exactly. Approach 1 (defer-only — no fresh full-panel round on quota reset).

**Tech Stack:** Bun, TypeScript, zod schemas, `bun test`. Spec: `docs/superpowers/specs/2026-06-16-quota-degraded-escalation-defer-design.md`.

---

## File structure

- `src/schemas/state.ts` — new `consecutive_quota_defers` field + `initialState`.
- `src/config/define-config.ts` — new `loop.quotaDeferMaxConsecutive` zod field.
- `src/config/defaults.ts` — `quotaDeferMaxConsecutive: 3`.
- `src/core/loop-driver.ts` — `escalateAndDecide` signature + defer branch; two call-site flags; two reset points.
- `tests/unit/quota-defer-config.test.ts` — new: plumbing defaults.
- `tests/unit/loop-driver-quota-defer.test.ts` — new: the defer behaviour suite.

No other files change. (The config is hashed into the review cache key automatically — the existing `define-config` plumbing handles that; no extra work.)

---

## Task 1: State field + config plumbing

**Files:**
- Modify: `src/schemas/state.ts` (add field after the `consecutive_infra_defers` field ~line 118; add to `initialState` ~line 154)
- Modify: `src/config/define-config.ts` (add field after `infraDeferMaxConsecutive` ~line 301)
- Modify: `src/config/defaults.ts` (add to the `loop` block after `infraDeferMaxConsecutive: 3` ~line 206)
- Test: `tests/unit/quota-defer-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/quota-defer-config.test.ts`:

```ts
// tests/unit/quota-defer-config.test.ts
//
// #10 plumbing: the new consecutive_quota_defers state field defaults to 0 (and
// is present in a fresh initialState), and loop.quotaDeferMaxConsecutive defaults
// to 3 (mirrors infraDeferMaxConsecutive), including when omitted from a parsed config.
import { describe, expect, it } from "bun:test";
import { defaultConfig } from "../../src/config/defaults.ts";
import { ConfigSchema } from "../../src/config/define-config.ts";
import { initialState } from "../../src/schemas/state.ts";

describe("#10 quota-defer plumbing", () => {
  it("initialState starts the quota-defer counter at 0", () => {
    expect(initialState("01HXTEST0000").consecutive_quota_defers).toBe(0);
  });

  it("defaultConfig.loop.quotaDeferMaxConsecutive is 3", () => {
    expect(defaultConfig.loop.quotaDeferMaxConsecutive).toBe(3);
  });

  it("a parsed config with the field omitted re-defaults to 3", () => {
    // Strip the field so the parse exercises the zod `.default(3)`, not the value
    // already baked into defaultConfig.
    const { quotaDeferMaxConsecutive: _omit, ...loopWithout } = defaultConfig.loop;
    const parsed = ConfigSchema.parse({ ...defaultConfig, loop: loopWithout });
    expect(parsed.loop.quotaDeferMaxConsecutive).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/quota-defer-config.test.ts`
Expected: FAIL — `consecutive_quota_defers` is `undefined` and `quotaDeferMaxConsecutive` is `undefined`.

- [ ] **Step 3: Add the state field**

In `src/schemas/state.ts`, immediately after the `consecutive_infra_defers` field (the one ending `.default(0),` ~line 118), add:

```ts
  // #10: consecutive turns the gate DEFERRED a give-up escalation (max-iterations
  // / stuck-signatures) because a configured reviewer was in cooldown (quota cap
  // or timeout/error backoff). Like consecutive_infra_defers it is NOT a review
  // round and does not advance `iteration`; bounded by loop.quotaDeferMaxConsecutive
  // so a persistently-degraded panel escalates instead of deferring forever. Reset
  // to 0 when an escalation proceeds or a review completes. .default(0) for back-compat.
  consecutive_quota_defers: z.number().int().nonnegative().default(0),
```

In the `initialState()` object literal, after `consecutive_infra_defers: 0,` (~line 154) add:

```ts
    consecutive_quota_defers: 0,
```

- [ ] **Step 4: Add the config field + default**

In `src/config/define-config.ts`, immediately after the `infraDeferMaxConsecutive` zod field (~line 301) add:

```ts
    // #10: max consecutive turns to DEFER a give-up escalation (max-iterations /
    // stuck-signatures) while a configured reviewer is in cooldown (quota cap or
    // timeout/error backoff — see quotaDegradationNote), before escalating anyway.
    // Mirrors infraDeferMaxConsecutive. 0 disables the defer (escalate immediately
    // even when degraded — prior behavior).
    quotaDeferMaxConsecutive: z.number().int().nonnegative().default(3),
```

In `src/config/defaults.ts`, in the `loop` block, immediately after `infraDeferMaxConsecutive: 3,` (~line 206) add:

```ts
    quotaDeferMaxConsecutive: 3,
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/unit/quota-defer-config.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck**

Run: `bunx tsc --noEmit`
Expected: clean (no errors).

- [ ] **Step 7: Commit**

```bash
git add src/schemas/state.ts src/config/define-config.ts src/config/defaults.ts tests/unit/quota-defer-config.test.ts
git commit -m "feat(#10): add consecutive_quota_defers state + quotaDeferMaxConsecutive config"
```

---

## Task 2: Defer branch in `escalateAndDecide` + call-site flags + reset points

**Files:**
- Modify: `src/core/loop-driver.ts` — `escalateAndDecide` (~line 1568); soft max-iterations call site (~line 876); stuck-signatures call site (~line 904); normal post-review state update (~line 1269)
- Test: `tests/unit/loop-driver-quota-defer.test.ts`

### Context the implementer needs

- The escalation preconditions (`cost-cap`, soft+hard `max-iterations`, `stuck-signatures`, `reject-rate-high`, `decisions-unaddressed`, etc.) all run at the **top of `run()` BEFORE a new panel is spawned**, and each early-returns via `this.escalateAndDecide(...)`. So a defer placed inside `escalateAndDecide` runs before any panel — `runIteration` is never reached on the defer/escalate paths (the tests below use a throwing orchestrator stub to prove this).
- `quotaDegradationNote(now)` returns a `string | null`: non-null (a `\n\n⚠ …` note naming the capped provider + reset time) iff a configured reviewer's provider has an active cooldown (`QuotaCooldownStore.activeUntil(provider, now) !== null`). The current code at the top of `escalateAndDecide` already calls it (and confusingly names the *string* `degraded`); this task renames it to `note` and derives the boolean from it.
- The defer must early-return **before** `this.unlinkDirtyFlagIfUnchanged()` (~line 1601) and before `this.escalate(...)`, so the dirty flag is kept and no escalation state is set.
- `run_summary` is optional on an audit event, so the best-effort defer audit needs no `RunSummary`.

- [ ] **Step 1: Write the failing test suite**

Create `tests/unit/loop-driver-quota-defer.test.ts`:

```ts
// tests/unit/loop-driver-quota-defer.test.ts
//
// #10: don't escalate the "give-up" reasons (soft max-iterations, stuck-signatures)
// while the reviewer panel is quota-degraded — DEFER (bounded) instead. cost-cap,
// the hard-cap max-iterations backstop, decisions-unaddressed, etc. still escalate.
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import type { IterationResult } from "../../src/core/orchestrator.ts";
import { QuotaCooldownStore } from "../../src/core/quota-cooldown.ts";
import { StateStore } from "../../src/core/state-store.ts";
import type { ReviewgateConfig } from "../../src/config/define-config.ts";
import { auditDir, dirtyFlagPath } from "../../src/utils/paths.ts";

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-quota-defer-"));
  writeFileSync(join(dir, "foo.ts"), "x");
  return dir;
}

function writeDirty(repo: string): void {
  writeFileSync(dirtyFlagPath(repo), JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }));
}

// The escalation preconditions early-return before any panel runs; this stub
// proves runIteration is never reached on the defer/escalate paths.
const neverRuns = {
  runIteration: async (): Promise<IterationResult> => {
    throw new Error("orchestrator.runIteration must not run on the precondition defer/escalate path");
  },
};

// Cap defaultConfig's sole reviewer provider ("codex") so quotaDegradationNote is non-null.
function capCodex(repo: string): void {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  new QuotaCooldownStore(repo).record("codex", future, new Date());
}

function driver(repo: string, state: StateStore, config: ReviewgateConfig): LoopDriver {
  return new LoopDriver({
    repoRoot: repo,
    config,
    state,
    audit: new AuditLogger(auditDir(repo)),
    orchestrator: neverRuns,
    stopHookActive: false,
  });
}

const escPath = (repo: string) => join(repo, ".reviewgate", "ESCALATION.md");

describe("#10 quota-degraded escalation defer", () => {
  it("DEFERS the soft max-iterations escalation when the panel is degraded", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQD000001");
    // iteration == maxIterations (3), same signature each round → non-progressing.
    await state.update((cur) => ({ ...cur, iteration: 3, signature_history: [["s1"], ["s1"], ["s1"]] }));
    capCodex(repo);
    writeDirty(repo);

    const decision = await driver(repo, state, defaultConfig).run();

    expect(decision.kind).toBe("allow_stop");
    expect(decision.reason).toMatch(/DEFERRED/);
    expect(decision.reason).toMatch(/cooldown/i);
    const st = await state.load();
    expect(st.consecutive_quota_defers).toBe(1); // defer counted
    expect(st.iteration).toBe(3); // NOT advanced
    expect(st.escalated).toBe(false); // not an escalation
    expect(existsSync(dirtyFlagPath(repo))).toBe(true); // dirty flag KEPT
    expect(existsSync(escPath(repo))).toBe(false); // no ESCALATION.md
  });

  it("DEFERS the stuck-signatures escalation when the panel is degraded", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQD000002");
    // iteration 2 (< maxIter 3 so max-iter skips); last stuckThreshold (2) signatures equal → stuck.
    await state.update((cur) => ({ ...cur, iteration: 2, signature_history: [["s1"], ["s1"]] }));
    capCodex(repo);
    writeDirty(repo);

    const decision = await driver(repo, state, defaultConfig).run();

    expect(decision.kind).toBe("allow_stop");
    expect(decision.reason).toMatch(/DEFERRED/);
    const st = await state.load();
    expect(st.consecutive_quota_defers).toBe(1);
    expect(st.iteration).toBe(2);
    expect(existsSync(escPath(repo))).toBe(false);
  });

  it("ESCALATES once the defer cap is exhausted (fail-closed backstop), with the degraded note", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQD000003");
    // Already deferred quotaDeferMaxConsecutive (3) times → guard 3 < 3 is false → escalate.
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      signature_history: [["s1"], ["s1"], ["s1"]],
      consecutive_quota_defers: 3,
    }));
    capCodex(repo);
    writeDirty(repo);

    const decision = await driver(repo, state, defaultConfig).run();

    expect(decision.kind).toBe("block"); // first escalation announce blocks once
    expect(decision.reason).toMatch(/ESCALATED/);
    expect(decision.reason).toMatch(/degraded panel/); // ⚠ note still surfaced
    expect(existsSync(escPath(repo))).toBe(true);
    const st = await state.load();
    expect(st.escalated).toBe(true);
    expect(st.consecutive_quota_defers).toBe(0); // reset on escalation-proceed
  });

  it("ESCALATES immediately when quotaDeferMaxConsecutive is 0 (defer disabled)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQD000004");
    await state.update((cur) => ({ ...cur, iteration: 3, signature_history: [["s1"], ["s1"], ["s1"]] }));
    capCodex(repo);
    writeDirty(repo);
    const config = { ...defaultConfig, loop: { ...defaultConfig.loop, quotaDeferMaxConsecutive: 0 } };

    const decision = await driver(repo, state, config).run();

    expect(decision.kind).toBe("block");
    expect(decision.reason).toMatch(/ESCALATED/);
    expect(existsSync(escPath(repo))).toBe(true);
  });

  it("ESCALATES normally when the panel is NOT degraded (no cooldown)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQD000005");
    await state.update((cur) => ({ ...cur, iteration: 3, signature_history: [["s1"], ["s1"], ["s1"]] }));
    // NO capCodex — panel is whole.
    writeDirty(repo);

    const decision = await driver(repo, state, defaultConfig).run();

    expect(decision.kind).toBe("block");
    expect(decision.reason).toMatch(/ESCALATED/);
    const st = await state.load();
    expect(st.consecutive_quota_defers).toBe(0); // never deferred
  });

  it("does NOT defer cost-cap even when degraded (non-deferable)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQD000006");
    await state.update((cur) => ({ ...cur, iteration: 1, cost_usd_so_far: 2 }));
    capCodex(repo);
    writeDirty(repo);
    const config = { ...defaultConfig, loop: { ...defaultConfig.loop, costCapUsd: 1 } };

    const decision = await driver(repo, state, config).run();

    expect(decision.reason).toMatch(/ESCALATED/);
    expect(existsSync(escPath(repo))).toBe(true);
    const st = await state.load();
    expect(st.consecutive_quota_defers).toBe(0); // cost-cap is not deferable
  });

  it("does NOT defer the hard-cap max-iterations backstop even when degraded", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQD000007");
    // iteration >= maxIterations * 2 (6) → the hard-cap escalation (deferableOnQuota=false).
    await state.update((cur) => ({ ...cur, iteration: 6, signature_history: [["s1"], ["s1"], ["s1"]] }));
    capCodex(repo);
    writeDirty(repo);

    const decision = await driver(repo, state, defaultConfig).run();

    expect(decision.reason).toMatch(/ESCALATED/);
    expect(existsSync(escPath(repo))).toBe(true);
    const st = await state.load();
    expect(st.consecutive_quota_defers).toBe(0); // hard cap is the runaway backstop — never deferred
  });
});
```

- [ ] **Step 2: Run the suite to verify it fails**

Run: `bun test tests/unit/loop-driver-quota-defer.test.ts --timeout 20000`
Expected: FAIL — the defer tests fail (the gate escalates instead of deferring; `consecutive_quota_defers` stays 0). The cost-cap / hard-cap / not-degraded tests may already pass.

- [ ] **Step 3: Add the `deferableOnQuota` parameter + defer branch to `escalateAndDecide`**

In `src/core/loop-driver.ts`, change the `escalateAndDecide` signature (~line 1568) to add the parameter:

```ts
  private async escalateAndDecide(
    state: ReviewgateState,
    reasonCode: EscalationReason,
    summary: string,
    deferableOnQuota = false,
  ): Promise<LoopDecision> {
```

Then replace the existing top three lines of the body:

```ts
    const degraded = this.quotaDegradationNote(new Date());
    const fullSummary = degraded ? summary + degraded : summary;
    const suffix = degraded ? " · ⚠ degraded panel (quota) — see ESCALATION.md" : "";
```

with:

```ts
    const now = new Date();
    const note = this.quotaDegradationNote(now); // string | null — reused below
    // #10: don't give up (max-iterations / stuck-signatures) while the reviewer
    // panel is degraded by a quota cap / timeout backoff. DEFER (allow_stop, keep
    // the dirty flag, do NOT advance the iteration) for a bounded number of turns,
    // then escalate anyway (fail-closed). Mirrors the infra-defer pattern; the
    // runaway/budget/protocol escalations pass deferableOnQuota=false and skip this.
    const quotaDeferCap = this.i.config.loop.quotaDeferMaxConsecutive;
    if (
      deferableOnQuota &&
      note !== null &&
      quotaDeferCap > 0 &&
      state.consecutive_quota_defers < quotaDeferCap
    ) {
      const next = state.consecutive_quota_defers + 1;
      await this.i.state.update((cur) =>
        ReviewgateStateSchema.parse({
          ...cur,
          consecutive_quota_defers: next,
          last_stop_ts: now.toISOString(),
        }),
      );
      await this.i.audit
        .append({
          event: "gate.decision",
          run_id: state.session_id,
          iter: state.iteration,
          trigger: "stop-hook",
        })
        .catch(() => {});
      // EARLY RETURN — before this.escalate(...) and unlinkDirtyFlagIfUnchanged():
      // the dirty flag is KEPT (next turn re-checks the cooldown), `iteration` is
      // not advanced, and no escalation state (escalated/announced/reason) is set.
      return {
        kind: "allow_stop",
        reason: `🟠 Reviewgate · GATE DEFERRED (iteration ${state.iteration}) — a reviewer is in cooldown, so the panel is incomplete; NOT escalating on a degraded panel yet. Will escalate once the cooldown clears, or after ${quotaDeferCap - next} more degraded turn(s) (defer ${next}/${quotaDeferCap}).${note}`,
      };
    }
    const fullSummary = note ? summary + note : summary;
    const suffix = note ? " · ⚠ degraded panel (quota) — see ESCALATION.md" : "";
```

- [ ] **Step 4: Reset the counter when an escalation proceeds**

Still in `escalateAndDecide`, find the first-announce state update (~line 1596):

```ts
      await this.i.state.update((cur) => ({ ...cur, escalation_announced: true }));
```

Change it to also zero the quota-defer counter (a defer streak always ends in this escalation — see spec "Reset points"):

```ts
      await this.i.state.update((cur) => ({
        ...cur,
        escalation_announced: true,
        consecutive_quota_defers: 0,
      }));
```

- [ ] **Step 5: Pass `deferableOnQuota: true` at the two give-up call sites**

In `src/core/loop-driver.ts`, the **soft** max-iterations escalation (the `if (!progressing)` branch, ~line 876) — add `true` as the 4th argument:

```ts
        return this.escalateAndDecide(
          state,
          "max-iterations",
          `Reached ${state.iteration} iterations without convergence — ${recurring} of the prior round's findings recurred and severity did not improve (real findings not decreasing).`,
          true,
        );
```

The stuck-signatures escalation (~line 904) — add `true`:

```ts
      return this.escalateAndDecide(
        state,
        "stuck-signatures",
        `Findings unchanged across ${stuckN} iterations.`,
        true,
      );
```

Leave the **hard-cap** max-iterations call (`Reached the hard cap of ${hardCap} iterations.`, ~line 867) and every other `escalateAndDecide` call as-is (3 args → `deferableOnQuota` defaults to `false`).

- [ ] **Step 6: Reset the counter on the normal post-review state update**

Find the normal state update (~line 1269) where `consecutive_infra_defers: 0,` appears, and add the quota-defer reset on the same line group:

```ts
        consecutive_infra_defers: 0,
        consecutive_quota_defers: 0,
```

- [ ] **Step 7: Run the suite to verify it passes**

Run: `bun test tests/unit/loop-driver-quota-defer.test.ts --timeout 20000`
Expected: PASS (7 tests).

- [ ] **Step 8: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: both clean.

- [ ] **Step 9: Commit**

```bash
git add src/core/loop-driver.ts tests/unit/loop-driver-quota-defer.test.ts
git commit -m "feat(#10): defer give-up escalations on a quota-degraded panel"
```

---

## Task 3: Full-suite regression + DoD

**Files:** none (verification only).

- [ ] **Step 1: Run the full unit suite**

Run: `bun test tests/unit --timeout 20000`
Expected: all green (the prior baseline is ~1791 passing). Pay attention to existing loop-driver / escalation tests — the rename of `degraded` → `note` and the new param must not regress them.

- [ ] **Step 2: Typecheck + lint (final)**

Run: `bunx tsc --noEmit && bun run lint`
Expected: both clean.

- [ ] **Step 3: No commit**

Verification only — nothing to commit. Proceed to the DoD review chain (codex ×N, opus whole-branch, then the dogfood gate) before merge.

---

## Self-review notes (spec coverage)

- Defer the two give-up reasons → Task 2 Steps 3+5 (soft max-iter call:876, stuck:904 get `deferableOnQuota:true`). ✓
- Bounded by counter + cap, fail-closed backstop → Task 1 (state+config), Task 2 Step 3 (guard), tested by the cap-exhausted test. ✓
- Exclude cost-cap / hard-cap / decisions-unaddressed / timeout / infra / fp-streak / reject-rate-high → they keep the 3-arg call (default false); tested by the cost-cap + hard-cap tests. ✓
- Dirty flag KEPT + iteration not advanced → Task 2 Step 3 early-return before `unlinkDirtyFlagIfUnchanged`; asserted in the defer tests. ✓
- Reset points (escalation-proceed `~1596` + normal update `~1269`) → Task 2 Steps 4+6; asserted (counter resets to 0 on escalate). ✓
- `quotaDeferMaxConsecutive: 0` disables → Task 1 + Task 2 Step 3 (`quotaDeferCap > 0`); tested. ✓
- Degradation signal = `quotaDegradationNote` cooldown-store proxy → reused unchanged in Task 2 Step 3. ✓
- Back-compat defaults → `.default(0)` / `.default(3)`; tested in Task 1. ✓
