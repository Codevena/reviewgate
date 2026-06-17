# Workspace Settle-Check Before Review — Design (field-report #7)

**Date:** 2026-06-17
**Field-report item:** #7 — "Don't review in-flight / half-finished states."
**Status:** approved, pre-implementation.

## Problem & scope

When the Stop hook fires, a background process the agent spawned (a build/codegen),
an async tool, or a parallel session in the same checkout may **still be writing**
reviewed-scope files. Reviewing that half-written snapshot produces findings about
incomplete code.

Already shipped (P1, 2026-06-05): `collectDiff` excludes *pre-existing* untracked
files (`mtime < base_ts`). That is about *which old files to drop*, not "is
something writing *now*." #7's residual gap is the live-churn case.

**The crux:** the Stop hook fires *after* the agent's own (synchronous) edits
complete, so the most-recent reviewed-scope mtime is **almost always very recent**.
A single mtime snapshot cannot distinguish "agent done, mtime now stable" from "a
writer is actively advancing it." The robust signal is a **settle-check**: sample
`maxMtime`, wait a short interval, re-sample — if it *advanced*, a writer is active
(not quiescent); if stable, quiescent.

In scope (Approach A — bounded settle-check / debounce): before `collectDiff`
captures the snapshot, wait (bounded) for the reviewed-scope files to stop changing,
then collect + review. If they never settle within the cap, review anyway with a
WARN banner.

Out of scope: a multi-turn churn-defer (Approach B — marginal: only re-checks when
the agent takes another turn) and any change that could *skip* a review (this stays
fail-safe: it only ever *delays* a review by ≤ the cap, never cancels it).

## Where it runs

`collectDiff` runs in `gate.ts` inside `gatherReviewContext` (NOT in the
orchestrator — the orchestrator receives the pre-computed `diff`). `gatherReviewContext`
(`gate.ts:426`) reads the dirty flag → `reviewBase` (base sha) + `reviewBaseTs`
(base ts), then calls `collectDiff`. The settle-check goes **inside
`gatherReviewContext`, after the base is determined and immediately before
`collectDiff`** — so `collectDiff` captures the settled snapshot.

`gatherReviewContext` runs inside the gate's shared **setup budget**
(`SETUP_BUDGET_MS_DEFAULT = 120_000`, wrapped by `withTimeout`). A ≤1.5s settle is
comfortably within it; if the settle ever overran the setup budget, `withTimeout`
rejects → the gate fails **CLOSED** (block "review setup did not complete"), never
fail-open. So no Stop-hook-timeout risk. No abort signal is needed (the settle is in
the setup phase, before the loop self-deadline, and is bounded by `maxSettleMs`).

## Components

### 1. `src/core/workspace-settle.ts` (new)

```ts
export const SETTLE_QUIET_WINDOW_MS = 2000;
export const SETTLE_INTERVAL_MS = 250;
export const SETTLE_MAX_MS = 1500;

export interface SettleResult {
  settled: boolean;        // false → still advancing at the cap (churning)
  waitedMs: number;        // total time spent waiting
  lastWriteMsAgo: number;  // now − maxMtime at the final sample (for the banner; 0 if no files)
}

// The reviewed-scope file NAMES: tracked changes since base + in-scope untracked
// (mtime ≥ base_ts, mirroring P1). Best-effort → [] on any git error.
export async function reviewedScopeFiles(
  repoRoot: string, baseSha: string | null, baseTs: string | null,
): Promise<string[]>;

// Max lstat mtime (ms) across files; best-effort (skip unstattable / racing unlink).
// Returns 0 for an empty / all-unstattable set.
export function maxMtimeMs(repoRoot: string, files: string[]): number;

// Bounded settle loop. now()/sleep() are injected for deterministic tests.
export async function awaitWorkspaceSettle(opts: {
  repoRoot: string;
  baseSha: string | null;
  baseTs: string | null;
  quietWindowMs: number;
  settleIntervalMs: number;
  maxSettleMs: number;
  now: () => number;                  // gate passes () => Date.now()
  sleep: (ms: number) => Promise<void>; // gate passes (ms) => new Promise(r => setTimeout(r, ms))
}): Promise<SettleResult>;
```

`awaitWorkspaceSettle` logic:
1. `files = await reviewedScopeFiles(...)`. If empty → `{ settled: true, waitedMs: 0, lastWriteMsAgo: 0 }`.
2. `last = maxMtimeMs(files)`. If `now() − last ≥ quietWindowMs` → already quiescent → `{ settled: true, waitedMs: 0, lastWriteMsAgo: now()−last }` (no `sleep` call).
3. Loop while `waited < maxSettleMs`:
   - `const step = min(settleIntervalMs, maxSettleMs − waited)`; `await sleep(step)`; `waited += step`.
   - **re-enumerate** `files` (catches a writer *creating* new files) and `cur = maxMtimeMs(files)`.
   - if `cur ≤ last` → settled → `{ settled: true, waitedMs: waited, lastWriteMsAgo: now()−cur }`.
   - else `last = cur` (advanced — keep waiting).
4. Cap hit, still advancing → `{ settled: false, waitedMs: waited, lastWriteMsAgo: now()−last }`.

### 2. Gate wiring — `src/cli/commands/gate.ts` `gatherReviewContext`

`gatherReviewContext` already computes `reviewBase` + `reviewBaseTs` from the dirty
flag (`:453-454`) before calling `collectDiff`. Thread the effective config in (a new
param, or just the `settleBeforeReview` boolean + nothing else since timings are
constants), and, when `cfg.phases.review.settleBeforeReview` is truthy, between the
base determination and the `collectDiff` call:

```ts
let workspaceUnsettled: { last_write_ms_ago: number; waited_ms: number } | undefined;
if (settleBeforeReview) {
  try {
    const r = await awaitWorkspaceSettle({
      repoRoot, baseSha: reviewBase, baseTs: reviewBaseTs,
      quietWindowMs: SETTLE_QUIET_WINDOW_MS, settleIntervalMs: SETTLE_INTERVAL_MS, maxSettleMs: SETTLE_MAX_MS,
      now: () => Date.now(), sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    });
    if (!r.settled) workspaceUnsettled = { last_write_ms_ago: r.lastWriteMsAgo, waited_ms: r.waitedMs };
  } catch {
    /* best-effort: a settle failure must never block or skip the review */
  }
}
// ... then collectDiff(...) exactly as today ...
```

Add `workspaceUnsettled` to the `GatheredContext` return type. In `runGate`, after
`gatherReviewContext` returns, pass it to the `Orchestrator` input alongside
`largeDiff` (`gate.ts:611` pattern): `...(workspaceUnsettled ? { workspaceUnsettled } : {})`.

**Fail-safe:** the result NEVER gates the review — on `settled:false` we still
collect + run the full panel; we only attach a banner. Any thrown error → caught,
no banner, review proceeds.

### 3. Orchestrator passthrough — `src/core/orchestrator.ts`

Mirror `largeDiff` exactly: add an optional `workspaceUnsettled?: { last_write_ms_ago: number; waited_ms: number }`
to the Orchestrator input type, and include it in the `PendingReport` the orchestrator
builds for `writeReport` (the same place `large_diff: this.input.largeDiff` is set).
No other orchestrator logic changes.

### 4. Schema — `src/schemas/pending-report.ts`

Add an optional field mirroring `large_diff`:

```ts
// #7: set when the workspace was still being written when the panel ran (the
// settle-check hit its cap without the reviewed files going quiet). Advisory —
// the verdict is unaffected; it warns the agent the review may reflect a
// half-finished state.
workspace_unsettled: z
  .object({ last_write_ms_ago: z.number().int().nonnegative(), waited_ms: z.number().int().nonnegative() })
  .optional(),
```

### 5. Rendering — `src/core/report-writer.ts` `renderMd`

Add a banner (alongside `largeDiffBanner`), emitted only when `r.workspace_unsettled`
is present:

```
> ⚠ **Workspace not quiescent:** a reviewed file was still being written ~<N>ms before this review (waited <W>ms for it to settle). This review may reflect a HALF-FINISHED state — if findings look spurious, let the writer (a background build/codegen or a parallel session) finish, then re-run.
```

### 6. Config — `src/config/define-config.ts` + `defaults.ts`

```ts
// define-config.ts (phases.review):
// #7: before collectDiff snapshots the working tree, briefly wait (≤ ~1.5s) for
// reviewed-scope files to stop changing — a background build/codegen or a parallel
// session may still be writing — so the panel reviews a quiescent snapshot. Bounded
// and fail-safe: it only delays a review, never skips it. Default on.
settleBeforeReview: z.boolean().optional(),
```
`defaults.ts` (phases.review): `settleBeforeReview: true`. Timings stay module
constants (YAGNI; promote to config later if a repo needs them).

## Behavior summary

- Agent edited then did ≥ quietWindow of other work → `maxMtime` old → no wait, no banner.
- Agent's last action was an edit, no active writer → one interval (~250ms), stable → settled, review.
- Active writer (background build touching source / parallel session) → keeps advancing → cap (~1.5s) → review anyway + WARN banner.
- Empty scope / git error / thrown → treated as settled (review, no banner).
- Toggle off → no settle-check. (One-shot `review-plan` is a separate command that does not run `gatherReviewContext`/the gate, so it is naturally excluded.)

## Testing

Unit (`awaitWorkspaceSettle`, injected `now`/`sleep`, with `reviewedScopeFiles`/
`maxMtimeMs` exercised against a temp git repo whose files have controlled mtimes):
1. last write ≥ quietWindow ago → `settled:true`, `waitedMs:0`, `sleep` never called.
2. recent write, mtime stable across one interval → `settled:true` after ~one interval.
3. recent write, mtime advances every interval → `settled:false`, `waitedMs ≈ maxSettleMs`.
4. empty scope → `settled:true`, `waitedMs:0`.
5. `reviewedScopeFiles`: a back-dated untracked file (mtime < base_ts) is EXCLUDED; a fresh tracked change is included. `maxMtimeMs` returns the newest mtime, 0 for empty.

report-writer: `workspace_unsettled` present → banner rendered; absent → no banner.

config: `settleBeforeReview` defaults to `true` via the defaults merge; omitted → true.

gate integration (`gatherReviewContext`/`runGate`): toggle ON + a quiescent temp repo
→ context returns `workspaceUnsettled: undefined` and the review proceeds normally;
toggle OFF → `awaitWorkspaceSettle` not invoked. (The churning path is covered
deterministically by the `awaitWorkspaceSettle` unit tests — a real active writer is
impractical to simulate in an integration test.)

Plus: `bunx tsc --noEmit`, `bun run lint`, `bun test tests/unit --timeout 20000` clean.

## Files touched

- `src/core/workspace-settle.ts` — new (enumerate + max-mtime + settle loop + constants).
- `src/cli/commands/gate.ts` — call `awaitWorkspaceSettle` in `gatherReviewContext` before `collectDiff`; add `workspaceUnsettled` to `GatheredContext`; pass it to the Orchestrator input in `runGate`.
- `src/core/orchestrator.ts` — accept `workspaceUnsettled?` input and include it in the `PendingReport` (mirror `largeDiff`).
- `src/schemas/pending-report.ts` — optional `workspace_unsettled` field.
- `src/core/report-writer.ts` — render the banner.
- `src/config/define-config.ts` + `defaults.ts` — `settleBeforeReview` toggle.
- `tests/unit/` — new tests for the settle loop, the enumeration, the banner, config, and the gate toggle.
