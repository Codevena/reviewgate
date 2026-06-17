# Workspace Settle-Check Before Review — Design (field-report #7)

**Date:** 2026-06-17
**Field-report item:** #7 — "Don't review in-flight / half-finished states."
**Status:** approved, pre-implementation.

## Problem & scope

When the Stop hook fires, a background process the agent spawned (a build/codegen),
an async tool, or a parallel session in the same checkout may **still be writing**
working-tree files. Reviewing that half-written snapshot produces findings about
incomplete code.

Already shipped (P1, 2026-06-05): `collectDiff` excludes *pre-existing* untracked
files (`max(mtime, ctime) < base_ts`). That is about *which old files to drop* from
the **review**, not "is something writing *now*." #7's residual gap is the live-churn
case.

**The crux:** the Stop hook fires *after* the agent's own (synchronous) edits
complete, so the most-recent working-tree change time is **almost always very
recent**. A single mtime snapshot cannot distinguish "agent done, mtime now stable"
from "a writer is actively advancing it." The robust signal is a **settle-check**:
sample the latest change time, wait a short interval, re-sample — if it *advanced*, a
writer is active (not quiescent); if stable, quiescent.

In scope (Approach A — bounded settle-check / debounce): before `collectDiff`
captures the snapshot, wait (bounded) for the working tree to stop changing, then
collect + review. If it never settles within the cap, review anyway with a WARN
banner.

Out of scope: a multi-turn churn-defer (Approach B — marginal: only re-checks when
the agent takes another turn) and any change that could *skip* a review (this stays
fail-safe: it only ever *delays* a review by ≤ the cap, never cancels it).

## Where it runs

`collectDiff` runs in `gate.ts`, NOT in the orchestrator (the orchestrator receives
the pre-computed `diff`). It is invoked inside `gatherReviewContext` (`gate.ts:426`),
which has **two** `collectDiff` (`diffFn`) call sites: an eager one on the
HEAD-advanced/no-dirty-flag path (`gate.ts:485-486`, reused as `precomputedDiff`) and
the main one (`gate.ts:527-528`). The settle-check must run **at the TOP of
`gatherReviewContext`, before BOTH `diffFn` call sites**, so whichever path collects
the diff captures the settled snapshot.

It runs inside the gate's shared **setup budget** (`SETUP_BUDGET_MS_DEFAULT = 120_000`,
wrapped by `withTimeout` at `gate.ts:568-571`). A ≤1.5s settle is comfortably within
it; if the settle ever overran the setup budget, `withTimeout` rejects → the gate
fails **CLOSED** (block "review setup did not complete" at `gate.ts:572-575`), never
fail-open. No abort signal needed (it's bounded by `maxSettleMs` and lives before the
loop self-deadline).

## Base-independence

The settle deliberately does **not** use the review base / `base_ts`. It only needs
"is any working-tree-dirty file being written *right now*." A base-independent
working-tree enumeration (`git diff --name-only HEAD` + untracked) is the right scope:
a pre-existing untracked file that P1 excludes from the *review* has an old, stable
change time → it never "advances" → it never triggers churn, so including it is
harmless. This sidesteps the base/`base_ts`/`precomputedDiff` ordering entirely and
needs no `max(mtime,ctime) ≥ base_ts` mirror.

## Components

### 1. `src/core/workspace-settle.ts` (new)

```ts
export const SETTLE_QUIET_WINDOW_MS = 2000;
export const SETTLE_INTERVAL_MS = 250;
export const SETTLE_MAX_MS = 1500;

export interface SettleResult {
  settled: boolean;        // false → still advancing at the cap (churning)
  waitedMs: number;        // total time spent waiting
  lastWriteMsAgo: number;  // now − latestChange at the final sample (for the banner; 0 if no files)
}

// Working-tree-dirty file NAMES, base-independent: `git diff --name-only HEAD`
// (tracked, uncommitted changes) ∪ `git ls-files -z --others --exclude-standard`
// (untracked). Each git call is independent + best-effort (a fresh repo with no HEAD
// errors the diff call but ls-files still works); union, dedupe → [] only if both fail.
export async function workingTreeDirtyFiles(repoRoot: string): Promise<string[]>;

// Latest change time (ms) across files = max over files of
// max(lstat.mtimeMs, lstat.ctimeMs) — more sensitive than mtime alone (catches a
// write OR a create/metadata change; ctime is not back-datable). Best-effort (skip
// unstattable / racing unlink). Returns 0 for an empty / all-unstattable set.
export function latestChangeMs(repoRoot: string, files: string[]): number;

// Bounded settle loop. now()/sleep() are injected for deterministic tests.
export async function awaitWorkspaceSettle(opts: {
  repoRoot: string;
  quietWindowMs: number;
  settleIntervalMs: number;
  maxSettleMs: number;
  now: () => number;                    // gate passes () => Date.now()
  sleep: (ms: number) => Promise<void>; // gate passes (ms) => new Promise(r => setTimeout(r, ms))
}): Promise<SettleResult>;
```

`awaitWorkspaceSettle` logic:
1. `files = await workingTreeDirtyFiles(repoRoot)`. If empty → `{ settled: true, waitedMs: 0, lastWriteMsAgo: 0 }`.
2. `last = latestChangeMs(files)`. If `now() − last ≥ quietWindowMs` → already quiescent → `{ settled: true, waitedMs: 0, lastWriteMsAgo: now()−last }` (no `sleep` call).
3. Loop while `waited < maxSettleMs`:
   - `const step = min(settleIntervalMs, maxSettleMs − waited)`; `await sleep(step)`; `waited += step`.
   - **re-enumerate** `files` (catches a writer *creating* new files) and `cur = latestChangeMs(files)`.
   - if `cur ≤ last` → settled → `{ settled: true, waitedMs: waited, lastWriteMsAgo: now()−cur }`.
   - else `last = cur` (advanced — keep waiting).
4. Cap hit, still advancing → `{ settled: false, waitedMs: waited, lastWriteMsAgo: now()−last }`.

### 2. Gate wiring — `src/cli/commands/gate.ts` `gatherReviewContext`

Thread the toggle in (a new `settleBeforeReview: boolean` param, or the effective
`cfg`). At the **very start** of `gatherReviewContext` (before the dirty-flag /
HEAD-advanced branch logic and before either `diffFn` call), when truthy:

```ts
let workspaceUnsettled: { last_write_ms_ago: number; waited_ms: number } | undefined;
if (settleBeforeReview) {
  try {
    const r = await awaitWorkspaceSettle({
      repoRoot,
      quietWindowMs: SETTLE_QUIET_WINDOW_MS, settleIntervalMs: SETTLE_INTERVAL_MS, maxSettleMs: SETTLE_MAX_MS,
      now: () => Date.now(), sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
    });
    if (!r.settled) workspaceUnsettled = { last_write_ms_ago: r.lastWriteMsAgo, waited_ms: r.waitedMs };
  } catch {
    /* best-effort: a settle failure must never block or skip the review */
  }
}
// ... existing base-resolution + diffFn calls run AFTER this ...
```

Add `workspaceUnsettled` to the `GatheredContext` return type. In `runGate`, after
`gatherReviewContext` returns, pass it to the `Orchestrator` input alongside
`largeDiff` (`gate.ts:611` pattern): `...(workspaceUnsettled ? { workspaceUnsettled } : {})`.

**Fail-safe:** the result NEVER gates the review — on `settled:false` we still
collect + run the full panel; we only attach a banner. Any thrown error → caught, no
banner, review proceeds.

### 3. Orchestrator passthrough — `src/core/orchestrator.ts`

Mirror `largeDiff` exactly: add an optional `workspaceUnsettled?: { last_write_ms_ago: number; waited_ms: number }`
to the Orchestrator input type, and include it in the `PendingReport` at the single
`writeReport` chokepoint (`orchestrator.ts:~2133`, where `large_diff: this.input.largeDiff`
is set — every exit path routes through it). No other orchestrator logic changes.

### 4. Schema — `src/schemas/pending-report.ts`

Add an optional field mirroring `large_diff`:

```ts
// #7: set when the working tree was still being written when the panel ran (the
// settle-check hit its cap without the tree going quiet). Advisory — the verdict is
// unaffected; it warns the agent the review may reflect a half-finished state.
workspace_unsettled: z
  .object({ last_write_ms_ago: z.number().int().nonnegative(), waited_ms: z.number().int().nonnegative() })
  .optional(),
```

### 5. Rendering — `src/core/report-writer.ts` `renderMd`

Add a banner (alongside `largeDiffBanner`), emitted only when `r.workspace_unsettled`
is present:

```
> ⚠ **Workspace not quiescent:** a file was still being written ~<N>ms before this review (waited <W>ms for it to settle). This review may reflect a HALF-FINISHED state — if findings look spurious, let the writer (a background build/codegen or a parallel session) finish, then re-run.
```

### 6. Config — `src/config/define-config.ts` + `defaults.ts`

```ts
// define-config.ts (phases.review):
// #7: before collectDiff snapshots the working tree, briefly wait (≤ ~1.5s) for
// working-tree files to stop changing — a background build/codegen or a parallel
// session may still be writing — so the panel reviews a quiescent snapshot. Bounded
// and fail-safe: it only delays a review, never skips it. Default on.
settleBeforeReview: z.boolean().optional(),
```
`defaults.ts` (phases.review): `settleBeforeReview: true`. Timings stay module
constants (YAGNI; promote to config later if a repo needs them).

## Behavior summary

- Agent edited then did ≥ quietWindow of other work → latest change old → no wait, no banner.
- Agent's last action was an edit, no active writer → one interval (~250ms), stable → settled, review.
- Active writer (background build touching the tree / parallel session) → keeps advancing → cap (~1.5s) → review anyway + WARN banner.
- Empty working tree / git error / thrown → treated as settled (review, no banner).
- Toggle off → no settle-check. (One-shot `review-plan` is a separate command that does not run `gatherReviewContext`/the gate, so it is naturally excluded.)

## Testing

Unit (`awaitWorkspaceSettle`, injected `now`/`sleep`, with `workingTreeDirtyFiles`/
`latestChangeMs` exercised against a temp git repo whose files have controlled mtimes):
1. last change ≥ quietWindow ago → `settled:true`, `waitedMs:0`, `sleep` never called.
2. recent change, latestChange stable across one interval → `settled:true` after ~one interval.
3. recent change, latestChange advances every interval → `settled:false`, `waitedMs ≈ maxSettleMs`.
4. empty working tree → `settled:true`, `waitedMs:0`.
5. `workingTreeDirtyFiles`: a tracked uncommitted change AND an untracked file both appear; a committed-clean file does not. `latestChangeMs` returns the newest `max(mtime,ctime)` (verify a back-dated-mtime-but-recent-ctime file reads as recent), 0 for empty.

report-writer: `workspace_unsettled` present → banner rendered; absent → no banner.

config: `settleBeforeReview` defaults to `true` via the defaults merge; omitted → true.

gate integration (`gatherReviewContext`/`runGate`): toggle ON + a quiescent temp repo
→ context returns `workspaceUnsettled: undefined` and the review proceeds normally;
toggle OFF → `awaitWorkspaceSettle` not invoked. (The churning path is covered
deterministically by the `awaitWorkspaceSettle` unit tests — a real active writer is
impractical to simulate in an integration test.)

Plus: `bunx tsc --noEmit`, `bun run lint`, `bun test tests/unit --timeout 20000` clean.

## Files touched

- `src/core/workspace-settle.ts` — new (working-tree enumerate + latest-change + settle loop + constants).
- `src/cli/commands/gate.ts` — call `awaitWorkspaceSettle` at the top of `gatherReviewContext` (before both `diffFn` calls); add `workspaceUnsettled` to `GatheredContext`; thread the `settleBeforeReview` toggle in; pass the result to the Orchestrator input in `runGate`.
- `src/core/orchestrator.ts` — accept `workspaceUnsettled?` input and include it in the `PendingReport` (mirror `largeDiff`).
- `src/schemas/pending-report.ts` — optional `workspace_unsettled` field.
- `src/core/report-writer.ts` — render the banner.
- `src/config/define-config.ts` + `defaults.ts` — `settleBeforeReview` toggle.
- `tests/unit/` — new tests for the settle loop, the enumeration, the banner, config, and the gate toggle.
