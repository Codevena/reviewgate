# Deadline-Aware Gate Budgeting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the gate's review pipeline structurally fit inside `loop.runTimeoutMs` (no more coin-flip 12-min aborts), and break the timeout treadmill where an aborted run suppresses the cooldown of a genuinely-hung reviewer so the identical slow chain re-runs and re-aborts until escalation.

**Architecture:** Three mechanisms plus new defaults. (1) *Per-settle abort attribution:* compute each reviewer's cooldown effect with the abort state read **when that reviewer settles**, not at task start, and drop the run-level suppression in `applyCooldownEffects` — a reviewer that hit its OWN timeout before the deadline keeps its backoff, so the next run skips it (treadmill broken). (2) *Deadline-aware budgets:* `LoopDriver` passes the absolute deadline into `runIteration`; reviewer spawns clamp their timeout to the remaining budget (minus a tail reserve for critic/report) and are skipped entirely below a floor; the critic clamps likewise and is SKIPPED below its floor (fail-safe, demote-only). A run whose window was MATERIALLY shortened by the budget clamp (more than `BUDGET_ATTRIBUTION_SLACK_MS` below its configured timeout) is never cooldown-penalized (same posture as the triage small-diff cap); a near-full-window timeout still is — that asymmetry is what keeps the treadmill dead without punishing gate-clamped reviewers. (3) *Doctor budget-consistency check:* WARN when the config's worst-case phase sum exceeds `loop.runTimeoutMs`. Defaults: `runTimeoutMs` 720s → 1800s, init-written Stop-hook `timeout` 900 → 2400.

**Tech Stack:** Bun + TypeScript, zod schemas, `bun test`, biome.

**Field evidence (FlashBuddy 2026-07-05/08 audit logs):** healthy panel = 117s wall; degraded panel (hung primary → full 300s timeout → sequential fallback → critic) = 630–716s measured on SUCCESSFUL runs vs 720s deadline; two aborts in a row → `review-timeout` escalation with 0 findings.

## Global Constraints

- Runtime is Bun; run `bunx tsc --noEmit` AND `bun run lint` before considering any task done; full `bun test` after schema/config edits.
- Fail-open invariant (budgets.ts): `SETUP_BUDGET_MS_DEFAULT (120s) + loop.runTimeoutMs + POST_ABORT_SETTLE_MS_DEFAULT (30s) < OS Stop-hook timeout`.
- All new wall-clock constants live in `src/config/budgets.ts` (M-A0: doctor derives thresholds from there, never duplicates literals).
- Cooldown posture: a reviewer torn down by the GATE (deadline abort, triage cap, budget clamp) must NOT be cooldown-penalized; a reviewer that hit its OWN configured `timeoutMs` MUST be.
- Suppressors fail safe: a clamped/skipped critic degrades to "no demotions", never to a changed verdict.
- Commits are local only; never push without explicit permission. No Claude attribution in commit messages.

---

### Task 1: Per-settle abort attribution for cooldown effects

The treadmill-breaker. Today `timeoutCooldownMs` is snapshotted at slot-task start (before the deadline can have fired) and `applyCooldownEffects(..., aborted)` suppresses ALL default-source backoffs run-level when the run was aborted — so a reviewer that legitimately burned its full 300s `timeoutMs` loses its backoff whenever the run is later aborted, and the next run re-burns it identically. Fix: read `opts.signal?.aborted` at **effect-computation time** (each reviewer's settle) and delete the run-level suppression.

**Files:**
- Modify: `src/core/orchestrator.ts` (`effectFor` closure ~line 1597; `applyCooldownEffects` ~line 483; its call site ~line 1755; the `timeoutCooldownMs` snapshot ~line 1589; KNOWN TRADE-OFF docblock ~lines 468–482)
- Test: `tests/unit/cooldown-effect.test.ts` (existing `applyCooldownEffects` aborted-suppression cases), new file `tests/unit/orchestrator-abort-attribution.test.ts`

**Interfaces:**
- Consumes: `cooldownEffectFor(provider, res, now, timeoutCooldownMs)` (unchanged).
- Produces: `applyCooldownEffects(store: QuotaCooldownStore, effects: CooldownEffect[], now: Date)` — **4th `aborted` param removed**. Task 2 relies on the `effectFor(provider, res, budgetCapped?)` shape introduced here being extended with a 3rd param.

- [ ] **Step 1: Write the failing test** — new `tests/unit/orchestrator-abort-attribution.test.ts`, driving `runIteration` with stub adapters (pattern from `tests/unit/orchestrator-checks.test.ts`) and an `AbortController`:

```ts
// tests/unit/orchestrator-abort-attribution.test.ts
//
// A reviewer that hits its OWN per-reviewer timeout BEFORE the gate deadline
// aborts the run must be cooled down even when the run is aborted later —
// otherwise the next run re-burns the identical hung chain (timeout treadmill:
// FlashBuddy 2026-07-08, 2× 12-min abort → review-timeout escalation).
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "../../src/config/define-config.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import { QuotaCooldownStore } from "../../src/core/quota-cooldown.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";

const diff = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

const mkres = (reviewerId: string, status: ReviewResult["status"]): ReviewResult => ({
  reviewerId,
  verdict: status === "ok" ? "PASS" : "ERROR",
  findings: [],
  usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
  durationMs: 300_000,
  exitCode: status === "ok" ? 0 : -1,
  rawEventsPath: "",
  status,
});

// codex times out (its OWN timeout — signal NOT yet aborted), then the gate
// deadline fires (ac.abort()) while claude-code is still in flight; claude-code
// settles as timeout AFTER the abort. Ordering is made robust (not just
// microtask-lucky) by having claude-code park on a 100ms macrotask BEFORE
// aborting: codex's settle + effect computation are pure microtasks and finish
// well inside that window. In-process stubs, no subprocess → CI-safe.
function adapters(ac: AbortController): Record<string, ProviderAdapter> {
  return {
    codex: {
      id: "codex",
      async preflight() {
        return { available: true, version: "x", authMode: "oauth", error: null };
      },
      async review(inp) {
        return mkres(inp.reviewerId, "timeout"); // settles pre-abort (microtask)
      },
    },
    "claude-code": {
      id: "claude-code",
      async preflight() {
        return { available: true, version: "x", authMode: "oauth", error: null };
      },
      async review(inp) {
        // Park a full macrotask so codex's slot finishes settle+effect first,
        // THEN fire the deadline abort, THEN settle as a killed-by-abort timeout.
        await new Promise((r) => setTimeout(r, 100));
        ac.abort();
        return mkres(inp.reviewerId, "timeout"); // killed BY the abort
      },
    },
  };
}

describe("per-settle abort attribution", () => {
  it("cools a reviewer that timed out pre-abort; not one killed by the abort", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-abort-attr-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const ac = new AbortController();
    const orch = new Orchestrator({
      repoRoot: repo,
      config: defineConfig({
        providers: {
          codex: { enabled: true, auth: "oauth", model: "m", timeoutMs: 300_000 },
          "claude-code": { enabled: true, auth: "oauth", model: "m", timeoutMs: 300_000 },
        },
        phases: {
          review: {
            reviewers: [
              { provider: "codex", persona: "security" },
              { provider: "claude-code", persona: "security" },
            ],
          },
          triage: null,
        },
        loop: { timeoutCooldownMs: 60_000 },
      }),
      adapters: adapters(ac),
      sandboxMode: "off",
      hostTier: "opus",
      diff,
      disableLastResortFailover: true,
    });
    await orch.runIteration({ runId: "R", iter: 1, signal: ac.signal }).catch(() => {});
    const store = new QuotaCooldownStore(repo);
    const now = new Date();
    // codex hit its OWN timeout before the abort → MUST be cooled.
    expect(store.skipUntil("codex", now)).not.toBeNull();
    // claude-code was killed BY the abort → must NOT be penalized.
    expect(store.skipUntil("claude-code", now)).toBeNull();
  });
});
```

Note for the implementer: the 100ms macrotask park makes the sequencing robust (codex's settle + effect computation are microtasks); if it still flakes under CI load, replace the delay with manually-controlled promises (codex resolves → await one macrotask → abort → resolve claude-code). `skipUntil` re-probe: `QuotaCooldownStore.skipUntil(provider, now)` returns the ISO reset string while the cooldown window is active for `now` — a fresh backoff window (5 min) is active immediately after the run, so a plain `new Date()` works. `triage: null` disables the small-diff timeout cap so `triageCapActive` stays false. `disableLastResortFailover: true` keeps the two slots from recruiting each other's provider (which would pollute the effect list).

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/orchestrator-abort-attribution.test.ts`
Expected: FAIL — `skipUntil("codex", …)` is `null` because the run-level `aborted` suppression in `applyCooldownEffects` dropped codex's default-source backoff.

- [ ] **Step 3: Move abort read to settle time and delete run-level suppression** — in `src/core/orchestrator.ts`:

(a) Replace the per-task snapshot (~line 1588) so the snapshot no longer bakes in the abort state, only the triage-cap posture:

```ts
const triageCapActive = (triage.reviewerTimeoutCapMs ?? null) !== null;
const configuredTimeoutCooldownMs = triageCapActive
  ? 0
  : (this.input.config.loop.timeoutCooldownMs ?? TIMEOUT_COOLDOWN_MS);
```

(b) `effectFor` reads the signal at CALL time (it runs immediately after each reviewer settles):

```ts
const effectFor = (provider: ProviderId, res: ReviewResult): CooldownEffect | null =>
  cooldownEffectFor(
    provider,
    res,
    this.input.now?.() ?? new Date(),
    // Read the abort state NOW (this reviewer just settled), not at task start:
    // a reviewer that hit its OWN timeout pre-abort keeps its backoff; one killed
    // BY the deadline abort surfaces after abort() and is not penalized.
    opts.signal?.aborted ? 0 : configuredTimeoutCooldownMs,
  );
```

(c) `applyCooldownEffects`: remove the `aborted: boolean` parameter and the branch that suppresses default-source effects when it is true; keep dedup + `clear > parsed > default` precedence unchanged. Rewrite the KNOWN TRADE-OFF paragraph (lines ~468–482) to document the new contract: *attribution happens per effect at settle time; the only residual imprecision is a reviewer whose settle races the abort by milliseconds, which suppresses one legitimate backoff for one cycle (benign, self-correcting).* Update the call site (~line 1755) to drop the 4th argument.

- [ ] **Step 4: Run the new test + existing cooldown tests**

Run: `bun test tests/unit/orchestrator-abort-attribution.test.ts tests/unit/cooldown-effect.test.ts`
Expected: new test PASSES; in `cooldown-effect.test.ts` every `applyCooldownEffects` case that passed `aborted` fails to COMPILE or fails — update those cases to the 3-arg signature. Cases that asserted "aborted run suppresses default effects" now assert the opposite contract at the `effectFor` level and should be replaced by: default-source effects are applied unconditionally by `applyCooldownEffects`; suppression is the CALLER's job via `timeoutCooldownMs=0` (already covered by the existing `cooldownEffectFor(..., 0)` cases). Grep for other callers first: `rg -n "applyCooldownEffects" src tests` — update every site.

- [ ] **Step 5: Typecheck + lint + full unit tests, then commit**

Run: `bunx tsc --noEmit && bun run lint && bun test tests/unit`
Expected: clean.

```bash
git add src/core/orchestrator.ts tests/unit/orchestrator-abort-attribution.test.ts tests/unit/cooldown-effect.test.ts
git commit -m "fix(cooldown): attribute deadline-abort per reviewer at settle time

A gate self-deadline abort suppressed ALL default-source cooldowns run-level,
so a genuinely-hung reviewer was never cooled and the next run re-burned the
identical slow chain until review-timeout escalation (FlashBuddy field report
2026-07-08). Abort state is now read when each reviewer settles."
```

### Task 2: Deadline plumbing + reviewer budget clamps

**Files:**
- Modify: `src/config/budgets.ts` (new constants), `src/core/orchestrator.ts` (both `runIteration` opts signatures ~lines 278/602, `runProvider` ~line 1331, primary spawn ~line 1621, fallback loop ~line 1647, last-resort loop ~line 1690, `ReviewerRun` type), `src/core/loop-driver.ts` (~line 1688 and the non-deadline call ~line 1754)
- Test: `tests/unit/orchestrator-budget-clamp.test.ts` (new)

**Interfaces:**
- Consumes: Task 1's `effectFor` closure and `configuredTimeoutCooldownMs`.
- Produces: `runIteration(opts: { …, deadlineAt?: number })` (epoch ms, absolute); budgets.ts exports `PANEL_TAIL_RESERVE_MS = 60_000`, `MIN_REVIEWER_BUDGET_MS = 30_000`, `CRITIC_TAIL_RESERVE_MS = 30_000`, `MIN_CRITIC_BUDGET_MS = 15_000` (Task 3 + Task 4 consume these); `ReviewerRun` gains `budgetCapped?: boolean`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/orchestrator-budget-clamp.test.ts
//
// With a deadline in sight, a reviewer spawn must clamp its timeout to the
// remaining budget (minus the tail reserve for critic/aggregate/report), skip
// spawns entirely below the floor, and never cooldown-penalize a budget-capped
// timeout (same posture as the triage small-diff cap — the GATE tore it down).
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MIN_REVIEWER_BUDGET_MS,
  PANEL_TAIL_RESERVE_MS,
} from "../../src/config/budgets.ts";
import { defineConfig } from "../../src/config/define-config.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import { QuotaCooldownStore } from "../../src/core/quota-cooldown.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";

const diff = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

function stub(id: string, seen: { timeoutMs: number[] }, status: ReviewResult["status"]): ProviderAdapter {
  return {
    id,
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      seen.timeoutMs.push(inp.cfg.timeoutMs);
      return {
        reviewerId: inp.reviewerId,
        verdict: status === "ok" ? "PASS" : "ERROR",
        findings: [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1000,
        exitCode: status === "ok" ? 0 : -1,
        rawEventsPath: "",
        status,
      };
    },
  };
}

function orch(repo: string, adapters: Record<string, ProviderAdapter>, opts: {
  reviewers: { provider: string; persona: string; fallback?: string[] }[];
  now: () => Date;
}) {
  return new Orchestrator({
    repoRoot: repo,
    config: defineConfig({
      providers: {
        codex: { enabled: true, auth: "oauth", model: "m", timeoutMs: 300_000 },
        gemini: { enabled: true, auth: "oauth", model: "m", timeoutMs: 300_000 },
      },
      phases: { review: { reviewers: opts.reviewers as never }, triage: null },
    }),
    adapters,
    sandboxMode: "off",
    hostTier: "opus",
    diff,
    disableLastResortFailover: true,
    now: opts.now,
  });
}

describe("deadline-aware reviewer budgets", () => {
  it("clamps the reviewer timeout to remaining budget minus the tail reserve", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-budget-clamp-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const t0 = Date.now();
    const seen = { timeoutMs: [] as number[] };
    const o = orch(repo, { codex: stub("codex", seen, "ok") }, {
      reviewers: [{ provider: "codex", persona: "security" }],
      now: () => new Date(t0),
    });
    // 200s of budget left → clamp = 200_000 − PANEL_TAIL_RESERVE_MS < 300_000.
    await o.runIteration({ runId: "R", iter: 1, deadlineAt: t0 + 200_000 });
    expect(seen.timeoutMs).toEqual([200_000 - PANEL_TAIL_RESERVE_MS]);
  });

  it("skips the spawn below the floor and does not run fallbacks either", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-budget-floor-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const t0 = Date.now();
    const seenP = { timeoutMs: [] as number[] };
    const seenF = { timeoutMs: [] as number[] };
    const o = orch(
      repo,
      { codex: stub("codex", seenP, "ok"), gemini: stub("gemini", seenF, "ok") },
      {
        reviewers: [{ provider: "codex", persona: "security", fallback: ["gemini"] }],
        now: () => new Date(t0),
      },
    );
    // Budget below the spawn floor → NOTHING spawns; the run must still settle
    // (fail-closed ERROR verdict via the existing 0-ok-reviewers path).
    const res = await o.runIteration({
      runId: "R",
      iter: 1,
      deadlineAt: t0 + PANEL_TAIL_RESERVE_MS + MIN_REVIEWER_BUDGET_MS - 1_000,
    });
    expect(seenP.timeoutMs).toEqual([]);
    expect(seenF.timeoutMs).toEqual([]);
    expect(res.verdict).toBe("ERROR");
  });

  it("a MATERIALLY budget-capped timeout is not cooldown-penalized", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-budget-nocool-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const t0 = Date.now();
    const seen = { timeoutMs: [] as number[] };
    const o = orch(repo, { codex: stub("codex", seen, "timeout") }, {
      reviewers: [{ provider: "codex", persona: "security" }],
      now: () => new Date(t0),
    });
    await o.runIteration({ runId: "R", iter: 1, deadlineAt: t0 + 200_000 });
    // Granted window 140s (200s − 60s reserve) is MORE than the 30s slack below
    // the configured 300s → gate's fault → no backoff recorded.
    expect(new QuotaCooldownStore(repo).skipUntil("codex", new Date(t0))).toBeNull();
  });

  it("a NEAR-FULL-window timeout keeps its cooldown (provider's fault)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-budget-cool-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const t0 = Date.now();
    const seen = { timeoutMs: [] as number[] };
    const o = orch(repo, { codex: stub("codex", seen, "timeout") }, {
      reviewers: [{ provider: "codex", persona: "security" }],
      now: () => new Date(t0),
    });
    // Budget 350s → granted window 290s of the configured 300s — inside the
    // 30s attribution slack. The provider demonstrably hung for (nearly) its
    // whole window → the escalating backoff MUST be recorded, else the next
    // run re-burns it (this is the CRITICAL from the plan-gate review).
    await o.runIteration({ runId: "R", iter: 1, deadlineAt: t0 + 350_000 });
    expect(seen.timeoutMs).toEqual([290_000]);
    expect(new QuotaCooldownStore(repo).skipUntil("codex", new Date(t0))).not.toBeNull();
  });
});
```

Implementer notes: `now` is the Orchestrator's injectable clock (`this.input.now`) — check the exact constructor field name before writing the test (`rg -n "now\?" src/core/orchestrator.ts`). The frozen clock makes the clamp arithmetic exact. If `defineConfig` rejects the partial provider shape, mirror how existing tests build it (`as never` where they do). The near-full-window case relies on the config default `loop.timeoutCooldownMs: 300_000` (> 0 → timeout cooldowns armed) — do not disable it in the test config.

Clock semantics (plan-gate WARN): production builds the Orchestrator WITHOUT `now` (verified: `gate.ts` `new Orchestrator({...})` has no `now:` field; the only `now: () => Date.now()` in gate.ts belongs to `awaitWorkspaceSettle`), so `remainingMs()` uses live `new Date()` and genuinely shrinks across sequential fallback/critic phases. An injected frozen clock (tests, bench) freezes the budget — intended there. Do not "fix" this by mixing `Date.now()` into the orchestrator: the injectable clock is what makes the clamp testable.

All-skipped semantics (plan-gate WARN, deliberate): when EVERY slot is budget-skipped, the panel settles with 0 ok reviewers and the existing fail-closed path yields verdict ERROR — the turn is BLOCKED, never fail-open. The synthetic `status:"error"` runs carry `statusDetail:"budget-skip: …"` so `preliminaryWhy`'s per-provider breakdown names the cause, and the FAST-error rule (durationMs 0) keeps them cooldown-inconclusive. This is only reachable with a misconfigured tiny `runTimeoutMs` (< PANEL_TAIL_RESERVE_MS + MIN_REVIEWER_BUDGET_MS ≈ 90s), which Task 4's doctor check flags. Do NOT route budget-skips into the quota-defer latch — a budget skip is a config problem, not a transient provider outage.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/orchestrator-budget-clamp.test.ts`
Expected: FAIL — `deadlineAt` is not an accepted option / no clamping occurs (first case sees `300_000`).

- [ ] **Step 3: Implement**

(a) `src/config/budgets.ts` — append:

```ts
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
```

(b) `runIteration` opts (BOTH the interface ~line 278 and the implementation ~line 602): add `deadlineAt?: number; // absolute epoch ms — the loop's self-deadline`.

(c) In `runIteration`, next to the existing `now` acquisition (~line 1446):

```ts
// Deadline-aware budgets: how much wall-clock is left before the loop's
// self-deadline aborts this run. Infinity when no deadline was passed
// (one-shot review-plan, tests, bench).
const remainingMs = (): number =>
  opts.deadlineAt === undefined
    ? Number.POSITIVE_INFINITY
    : opts.deadlineAt - (this.input.now?.() ?? new Date()).getTime();
const reviewerBudgetMs = (): number => remainingMs() - PANEL_TAIL_RESERVE_MS;
```

(d) `runProvider` (~line 1346): fold the budget into the effective timeout and report whether the budget clamp MATERIALLY shortened the window. A near-full window (within `BUDGET_ATTRIBUTION_SLACK_MS` of the configured `timeoutMs`) that still times out is the provider demonstrably hanging — it MUST keep its cooldown, or every near-deadline run would read as "gate's fault" and the treadmill returns:

```ts
const capMs = triage.reviewerTimeoutCapMs ?? null;
const budgetMs = reviewerBudgetMs(); // Infinity when no deadline
const effectiveTimeoutMs = Math.max(
  1,
  Math.min(
    providerCfg.timeoutMs,
    capMs ?? Number.POSITIVE_INFINITY,
    budgetMs,
  ),
);
// Materially-clamped ⇔ the granted window is more than the slack below the
// configured timeout. 290s of a 300s window ⇒ provider's fault (cool it);
// 140s of a 300s window ⇒ gate's fault (don't).
const budgetCapped =
  effectiveTimeoutMs < providerCfg.timeoutMs - BUDGET_ATTRIBUTION_SLACK_MS;
```

and add `budgetCapped` to the returned `ReviewerRun` objects (extend the `ReviewerRun` type with `budgetCapped?: boolean`; set it in the success return and both error returns).

(e) Spawn guards. Primary (~line 1621): before calling `runProvider`, if `reviewerBudgetMs() < MIN_REVIEWER_BUDGET_MS`, synthesize (mirroring the cooldown-skip block, status `"error"` so the FAST-error rule keeps it cooldown-inconclusive):

```ts
run = {
  res: {
    reviewerId: `${r.provider}-${persona}`,
    verdict: "ERROR",
    findings: [],
    usage: { ...ZERO_USAGE },
    durationMs: 0,
    exitCode: -1,
    rawEventsPath: "",
    status: "error",
    statusDetail: `budget-skip: ${Math.max(0, Math.round(reviewerBudgetMs() / 1000))}s of panel budget left before the gate deadline — reviewer not spawned`,
  },
  provider: r.provider,
  persona,
  model,
};
```

Fallback loop (~line 1648) and last-resort loop (~line 1697): first statement inside each `for` body: `if (reviewerBudgetMs() < MIN_REVIEWER_BUDGET_MS) break;`.

(f) Cooldown posture: extend Task 1's `effectFor` to accept the run's clamp flag:

```ts
const effectFor = (
  provider: ProviderId,
  res: ReviewResult,
  budgetCapped = false,
): CooldownEffect | null =>
  cooldownEffectFor(
    provider,
    res,
    this.input.now?.() ?? new Date(),
    opts.signal?.aborted || budgetCapped ? 0 : configuredTimeoutCooldownMs,
  );
```

Update the three call sites to pass `run.budgetCapped` (`effectFor(r.provider, run.res, run.budgetCapped)`, and likewise for the fallback/last-resort `run`s).

(g) `src/core/loop-driver.ts`: the deadline-bounded call (~line 1688) passes `deadlineAt: Date.now() + runTimeoutMs` (compute ONE `const deadlineAt` right where the timer is armed so timer and budget agree); the `runTimeoutMs <= 0` call (~line 1754) passes nothing.

- [ ] **Step 4: Run tests**

Run: `bun test tests/unit/orchestrator-budget-clamp.test.ts tests/unit/orchestrator-abort-attribution.test.ts tests/unit/cooldown-effect.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint + full unit tests, then commit**

Run: `bunx tsc --noEmit && bun run lint && bun test tests/unit`
Expected: clean (watch for orchestrator tests that assert `statusDetail` shapes).

```bash
git add src/config/budgets.ts src/core/orchestrator.ts src/core/loop-driver.ts tests/unit/orchestrator-budget-clamp.test.ts
git commit -m "feat(gate): deadline-aware reviewer budgets

Reviewer spawns clamp their timeout to the remaining run budget (minus a tail
reserve for critic/report) and are skipped below a 30s floor, so a degraded
panel (hung primary -> sequential fallback chain) structurally fits inside
loop.runTimeoutMs instead of coin-flipping against it. A budget-capped timeout
is never cooldown-penalized (gate's fault, not the provider's)."
```

### Task 3: Critic budget clamp (skip below the floor)

Below the floor the critic is SKIPPED, not floored (plan-gate WARN): a floored 15s micro-critic started with ~0 budget would straddle the self-deadline, get abort-killed, and (via writeReport's abort guard) turn an otherwise COMPLETED panel into an incomplete run — the exact failure this plan removes. Skipping is fail-safe: the critic is demote-only, so skipping demotes nothing.

**Files:**
- Modify: `src/core/orchestrator.ts` (critic phase, `timeoutMs: cProviderCfg.timeoutMs` ~line 1968, and the `criticInfo` local type ~line 1944), `src/schemas/` wherever `criticInfo.status` is persisted (find with `rg -n '"misconfigured"' src`)
- Test: `tests/unit/orchestrator-budget-clamp.test.ts` (extend)

**Interfaces:**
- Consumes: `remainingMs()` from Task 2; `CRITIC_TAIL_RESERVE_MS`, `MIN_CRITIC_BUDGET_MS` from budgets.ts.
- Produces: `criticInfo.status` union gains `"skipped-budget"` (orchestrator local type AND the pending-report schema enum, if the field is persisted — zod schemas are the source of truth).

- [ ] **Step 1: Write the failing test** — append to `tests/unit/orchestrator-budget-clamp.test.ts`:

```ts
it("clamps the critic timeout to remaining budget, with a hard floor", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-budget-critic-"));
  writeFileSync(join(repo, "foo.ts"), "x");
  const t0 = Date.now();
  const seenReviewer = { timeoutMs: [] as number[] };
  const seenCritic = { timeoutMs: [] as number[] };
  // Reviewer must RAISE a finding, else the critic phase is skipped entirely.
  const finding = {
    title: "t",
    body: "b",
    severity: "WARN",
    file: "foo.ts",
    line_start: 1,
    line_end: 1,
    rule_id: null,
    suggestion: null,
    confidence: 0.9,
  };
  const reviewer: ProviderAdapter = {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      seenReviewer.timeoutMs.push(inp.cfg.timeoutMs);
      return {
        reviewerId: inp.reviewerId,
        verdict: "FAIL",
        findings: [finding as never],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1000,
        exitCode: 0,
        rawEventsPath: "",
        status: "ok",
      };
    },
    async complete(inp) {
      seenCritic.timeoutMs.push(inp.cfg.timeoutMs);
      return { text: "[]", status: "ok" }; // no demotions
    },
  } as never;
  const o = new Orchestrator({
    repoRoot: repo,
    config: defineConfig({
      providers: { codex: { enabled: true, auth: "oauth", model: "m", timeoutMs: 300_000 } },
      phases: {
        review: { reviewers: [{ provider: "codex", persona: "security" }] },
        critic: { provider: "codex" },
        triage: null,
      },
    }),
    adapters: { codex: reviewer },
    sandboxMode: "off",
    hostTier: "opus",
    diff,
    disableLastResortFailover: true,
    now: () => new Date(t0),
  });
  await o.runIteration({ runId: "R", iter: 1, deadlineAt: t0 + 200_000 });
  expect(seenCritic.timeoutMs.length).toBe(1);
  // 200s budget − CRITIC_TAIL_RESERVE_MS(30s) = 170s < the 300s configured.
  expect(seenCritic.timeoutMs[0]).toBe(200_000 - CRITIC_TAIL_RESERVE_MS);
});

it("SKIPS the critic below the floor (fail-safe: verdict from the panel stands)", async () => {
  // Same double-duty adapter as above (factor the construction into a helper),
  // but with only CRITIC_TAIL + 10s of budget left — below MIN_CRITIC_BUDGET_MS.
  // Reviewer budget is Infinity-like here? NO — reviewers share the deadline, so
  // give the run enough budget for the reviewer by freezing the clock: reviewer
  // spawn sees the same remaining budget. Choose deadlineAt so the REVIEWER's
  // clamp stays above MIN_REVIEWER_BUDGET_MS but the CRITIC's is below its floor:
  // remaining = 95s → reviewer window 35s (≥ 30s floor, spawns), critic budget
  // 95−30 = 65s ≥ 15s… that still runs. There is no single frozen-clock value
  // where the reviewer spawns AND the critic is floored, because the clock never
  // advances. So instead: advance the clock manually — a `now` stub backed by a
  // mutable box, bumped +190s inside the reviewer's review() body.
  const repo = mkdtempSync(join(tmpdir(), "rg-budget-critic-skip-"));
  writeFileSync(join(repo, "foo.ts"), "x");
  const t0 = Date.now();
  const clock = { ms: t0 };
  const seenCritic = { timeoutMs: [] as number[] };
  const reviewer = makeCriticProbeAdapter(seenCritic, {
    onReview: () => {
      clock.ms += 190_000; // panel consumed 190s of the 200s budget
    },
  });
  const o = new Orchestrator({
    repoRoot: repo,
    config: defineConfig({
      providers: { codex: { enabled: true, auth: "oauth", model: "m", timeoutMs: 300_000 } },
      phases: {
        review: { reviewers: [{ provider: "codex", persona: "security" }] },
        critic: { provider: "codex" },
        triage: null,
      },
    }),
    adapters: { codex: reviewer },
    sandboxMode: "off",
    hostTier: "opus",
    diff,
    disableLastResortFailover: true,
    now: () => new Date(clock.ms),
  });
  const res = await o.runIteration({ runId: "R", iter: 1, deadlineAt: t0 + 200_000 });
  // Remaining at critic time: 10s − 30s reserve < 15s floor → critic skipped.
  expect(seenCritic.timeoutMs).toEqual([]);
  // The panel verdict stands (finding raised → FAIL), produced WITHOUT the critic.
  expect(res.verdict).toBe("FAIL");
});
```

(`makeCriticProbeAdapter(seenCritic, {onReview})` = the reviewer/critic double-duty stub from the previous case, extracted into a helper that calls `onReview()` before returning the finding — write it once, use it in both cases.)

Implementer notes: import `CRITIC_TAIL_RESERVE_MS` at the top. Check the `complete()` input shape (`rg -n "complete\(" src/providers/adapter-base.ts`) and the exact critic-response format `runCritic` parses (`src/core/critic.ts`) — adjust the stub's return (`"[]"`) to whatever parses as "zero verdicts", and the finding literal to the real `Finding` schema (`src/schemas/finding.ts`) so the reviewer result validates. With the frozen clock the reviewer's elapsed time doesn't reduce the critic's view of `remainingMs()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/orchestrator-budget-clamp.test.ts`
Expected: the new case FAILS — critic sees `300_000`.

- [ ] **Step 3: Implement** — in the critic block, compute the budget BEFORE building the call and gate the whole phase on it:

```ts
// Deadline-aware: the critic (sequential, AFTER the panel) may not push the
// run past the self-deadline. Clamp its timeout to the remaining budget minus
// air for aggregate/report; below the floor SKIP it entirely (fail-safe —
// demote-only, so skipping demotes nothing). Never floor-and-run: a micro-
// critic straddling the deadline would be abort-killed and turn a COMPLETED
// panel into an incomplete run.
const criticBudgetMs = Math.min(
  cProviderCfg.timeoutMs,
  remainingMs() - CRITIC_TAIL_RESERVE_MS,
);
if (criticBudgetMs < MIN_CRITIC_BUDGET_MS) {
  criticInfo = { provider: criticCfg.provider, status: "skipped-budget", verdicts: 0 };
} else {
  // …existing runCritic call, with `timeoutMs: criticBudgetMs` instead of
  // `timeoutMs: cProviderCfg.timeoutMs`…
}
```

Extend the `criticInfo` local union with `"skipped-budget"`, and — if `criticInfo.status` is persisted (check `rg -n '"misconfigured"' src`) — the corresponding zod enum in `src/schemas/` too (schemas are the source of truth; a stale enum makes writeReport throw on the new value).

- [ ] **Step 4: Run tests**

Run: `bun test tests/unit/orchestrator-budget-clamp.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint, then commit**

Run: `bunx tsc --noEmit && bun run lint && bun test tests/unit`

```bash
git add src/core/orchestrator.ts tests/unit/orchestrator-budget-clamp.test.ts
git commit -m "feat(gate): clamp critic timeout to remaining run budget"
```

### Task 4: Doctor budget-consistency check

**Files:**
- Modify: `src/cli/commands/doctor.ts` (new exported `panelBudgetCheck`, wired next to `hookTimeoutCheck` ~line 618)
- Test: `tests/unit/doctor-panel-budget.test.ts` (new)

**Interfaces:**
- Consumes: `PANEL_TAIL_RESERVE_MS` from budgets.ts; config shapes.
- Produces: `export function panelBudgetCheck(cfg: ReviewgateConfig): Check` — WARN-level (never FAIL: budgets now degrade gracefully; the check is advisory sizing guidance).

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/doctor-panel-budget.test.ts
//
// Advisory sizing check: WARN when the configured worst-case panel wall-clock
// (slowest slot chain: primary + declared fallbacks, sequential) plus the
// critic exceeds loop.runTimeoutMs — reviewer clamping will degrade such a
// config (truncated reviews / skipped spawns) instead of timing out, but the
// user should size the budget deliberately.
import { describe, expect, it } from "bun:test";
import { panelBudgetCheck } from "../../src/cli/commands/doctor.ts";
import { defineConfig } from "../../src/config/define-config.ts";

describe("doctor panel budget check", () => {
  it("warns when worst-case chain + critic exceeds runTimeoutMs", () => {
    const cfg = defineConfig({
      providers: {
        codex: { enabled: true, auth: "oauth", model: "m", timeoutMs: 600_000 },
        gemini: { enabled: true, auth: "oauth", model: "m", timeoutMs: 600_000 },
        "claude-code": { enabled: true, auth: "oauth", model: "m", timeoutMs: 600_000 },
      },
      phases: {
        review: {
          reviewers: [
            { provider: "codex", persona: "security", fallback: ["gemini", "claude-code"] },
          ],
        },
        critic: { provider: "claude-code" },
      },
      loop: { runTimeoutMs: 720_000 },
    });
    const c = panelBudgetCheck(cfg);
    // chain 600+600+600 = 1800s + max(60s panel tail, 600s critic + 30s critic
    // tail) = 2430s > 720s → warn.
    expect(c.status).toBe("warn");
  });

  it("passes when the worst case fits", () => {
    const cfg = defineConfig({
      providers: {
        codex: { enabled: true, auth: "oauth", model: "m", timeoutMs: 300_000 },
        gemini: { enabled: true, auth: "oauth", model: "m", timeoutMs: 300_000 },
      },
      phases: {
        review: {
          reviewers: [{ provider: "codex", persona: "security", fallback: ["gemini"] }],
        },
        critic: null,
      },
      loop: { runTimeoutMs: 1_800_000 },
    });
    expect(panelBudgetCheck(cfg).status).toBe("ok");
  });
});
```

Implementer notes: mirror `hookTimeoutCheck`'s `Check` construction (name/status/detail/hint fields — read it first). If `defineConfig` requires more provider fields, copy a minimal valid provider literal from an existing doctor test. `critic: null` vs omission: match the schema default.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/doctor-panel-budget.test.ts`
Expected: FAIL — `panelBudgetCheck` is not exported.

- [ ] **Step 3: Implement** — in `doctor.ts`:

```ts
// Advisory: worst-case panel wall-clock vs loop.runTimeoutMs, mirroring the
// runtime's TWO-reserve model (plan-gate WARN — do not lump the reserves):
// reviewers run unclamped iff slowestChain + PANEL_TAIL_RESERVE fits; the
// sequential critic runs unclamped iff slowestChain + critic + CRITIC_TAIL_
// RESERVE fits. Worst case = slowestChain + max(PANEL_TAIL, critic + CRITIC_
// TAIL). Slot chains = primary + declared fallbacks (sequential inside one
// slot; slots are parallel). Reviewer budget-clamping degrades an oversized
// config gracefully — truncated reviews of large diffs (reduced review
// quality), skipped fallbacks, skipped critic — instead of aborting, but the
// user should size deliberately, so WARN, never FAIL. Last-resort failover is
// unbounded by declaration and deliberately excluded (the clamp bounds it).
export function panelBudgetCheck(cfg: ReviewgateConfig): Check {
  const providers = cfg.providers as Record<string, { timeoutMs?: number } | undefined>;
  const t = (p: string): number => providers[p]?.timeoutMs ?? 300_000;
  const chains = (cfg.phases.review.reviewers ?? []).map(
    (r) => t(r.provider) + (r.fallback ?? []).reduce((s, fb) => s + t(fb), 0),
  );
  const slowestChainMs = chains.length ? Math.max(...chains) : 0;
  const criticMs = cfg.phases.critic ? t(cfg.phases.critic.provider) : 0;
  const tailMs = Math.max(
    PANEL_TAIL_RESERVE_MS,
    criticMs > 0 ? criticMs + CRITIC_TAIL_RESERVE_MS : 0,
  );
  const worstMs = slowestChainMs + tailMs;
  const runMs = cfg.loop.runTimeoutMs;
  const fits = runMs <= 0 || worstMs <= runMs;
  return {
    name: "panel budget vs loop.runTimeoutMs",
    status: fits ? "ok" : "warn",
    detail: fits
      ? `worst-case panel ${Math.round(worstMs / 1000)}s fits runTimeoutMs ${Math.round(runMs / 1000)}s`
      : `worst-case panel wall-clock ${Math.round(worstMs / 1000)}s (slowest slot chain ${Math.round(slowestChainMs / 1000)}s + ${Math.round(tailMs / 1000)}s tail: max(panel reserve, critic + critic reserve)) exceeds loop.runTimeoutMs (${Math.round(runMs / 1000)}s) — the gate will budget-clamp instead of timing out: reviews of large diffs get CUT SHORT (reduced quality), late fallbacks and the critic get skipped`,
    hint: fits
      ? ""
      : "Raise loop.runTimeoutMs (and the Stop-hook timeout with it: setup 120s + runTimeoutMs + settle 30s must stay below it), or lower per-provider timeoutMs / shorten fallback chains.",
  };
}
```

Import `CRITIC_TAIL_RESERVE_MS` alongside `PANEL_TAIL_RESERVE_MS` from budgets.ts.

Wire it where `hookTimeoutCheck` is pushed (~line 618): `checks.push(panelBudgetCheck(cfg));` (adapt to the local pattern — `hookTimeoutCheck` may return null; this one always returns a Check). Adjust field names to the actual `Check` type.

- [ ] **Step 4: Run tests**

Run: `bun test tests/unit/doctor-panel-budget.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint + doctor smoke, then commit**

Run: `bunx tsc --noEmit && bun run lint && bun run dev doctor | head -40`
Expected: clean; doctor output shows the new check as ok for this repo's config.

```bash
git add src/cli/commands/doctor.ts tests/unit/doctor-panel-budget.test.ts
git commit -m "feat(doctor): advisory panel-budget vs runTimeoutMs sizing check"
```

### Task 5: New defaults — runTimeoutMs 1800s, init Stop-hook timeout 2400s

**Files:**
- Modify: `src/config/defaults.ts` (~line 239), `src/cli/commands/init.ts` (~line 93), `CLAUDE.md` (one gotcha line)
- Test: existing suites (`tests/unit/doctor-hook-timeout.test.ts` and any test pinning `720_000`/`900` — `rg -n "720_000|timeout: 900" src tests`)

**Interfaces:**
- Consumes: budgets.ts invariant (120s + runTimeoutMs + 30s < hook timeout → 1950s < 2400s ✓).
- Produces: new install defaults; existing repos unaffected unless they re-run init (config deep-merge keeps explicit values).

- [ ] **Step 1: Find every pin of the old values**

Run: `rg -n "720_000|timeout: 900|900\b.*Stop|runTimeoutMs" src tests docs/AGENTS.md README.md | rg -v "node_modules"`
Expected: hits in defaults.ts, init.ts, possibly doctor-hook-timeout tests and docs. List them; each is updated in the next steps (docs included — stale numbers in docs are bugs).

- [ ] **Step 2: Update defaults.ts** — `runTimeoutMs: 720_000` → `runTimeoutMs: 1_800_000`, and extend the adjacent comment:

```ts
// Self-deadline for one gate run. 1800s (was 720s): a degraded panel (hung
// primary burning its full timeout → sequential fallback chain → critic)
// legitimately needs 10–12min, which made 720s a coin flip (field report:
// FlashBuddy 2026-07-08, repeated 12-min aborts → review-timeout escalation).
// Paired with the 2400s Stop-hook timeout init writes: 120s setup + 1800s +
// 30s settle = 1950s < 2400s (fail-open invariant, budgets.ts).
runTimeoutMs: 1_800_000,
```

- [ ] **Step 3: Update init.ts** — the Stop hook literal `timeout: 900` → `timeout: 2400` with comment: `// 120s setup + 1800s runTimeoutMs + 30s settle = 1950s < 2400s (budgets.ts invariant)`.

- [ ] **Step 4: Run the full suite; update honest pins**

Run: `bun test`
Expected: failures only in tests that pinned the old defaults (e.g. doctor margin fixtures). Update the expected VALUES to the new defaults — do not weaken assertions. Re-run until green.

- [ ] **Step 5: Add the CLAUDE.md gotcha line** — append to "Non-obvious gotchas":

```
- **Deadline-aware budgets:** `runIteration` receives `deadlineAt` from the loop; reviewer spawns clamp to the remaining budget minus `PANEL_TAIL_RESERVE_MS` and are skipped below `MIN_REVIEWER_BUDGET_MS` (budgets.ts); the critic clamps likewise. A budget-clamped/aborted timeout is never cooldown-penalized, but a reviewer that hit its OWN `timeoutMs` pre-abort now IS (per-settle attribution) — that pairing is what breaks the repeated-timeout treadmill. Defaults: `loop.runTimeoutMs` 1800s, init-written Stop-hook timeout 2400s.
```

- [ ] **Step 6: Typecheck + lint + full tests, then commit**

Run: `bunx tsc --noEmit && bun run lint && bun test`
Expected: all green.

```bash
git add src/config/defaults.ts src/cli/commands/init.ts CLAUDE.md tests
git commit -m "feat(defaults): runTimeoutMs 1800s + init Stop-hook timeout 2400s

720s was below the measured wall-clock of a degraded panel (630-716s on
successful runs, FlashBuddy audit 2026-07-05/08), making every such run a
coin flip and funneling healthy changes into review-timeout escalations."
```
