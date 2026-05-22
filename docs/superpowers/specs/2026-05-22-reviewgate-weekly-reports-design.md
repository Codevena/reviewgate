# Reviewgate — Weekly Reports (`reviewgate report`) — Design

**Date:** 2026-05-22 · **Status:** approved design (Codex design-reviewed, 9 rounds → PASS)

## Goal

A periodic **weekly report** of Reviewgate activity that goes beyond the ad-hoc
`reviewgate stats` snapshot: a per-ISO-week document with a **week-over-week
trend** and a **highlights** section. Delivered two ways — an on-demand CLI
command and an opt-in auto-snapshot written when a new ISO week rolls over.

Builds directly on the existing `src/stats/` pipeline
(`load.ts` → `aggregate.ts` → `render.ts`, plus the `reviewgate stats` CLI).

### Locked decisions (with the user)
- **Trigger/delivery:** CLI command **plus** optional auto-snapshot-on-rollover (opt-in via config).
- **Content:** weekly snapshot **+ trend-delta vs previous week + highlights**.
- **Week:** **ISO-8601 calendar week (Mon–Sun, UTC)**; CLI default = **last complete week**, trend = the week before.
- **Structure:** Approach A — a thin ISO-week + period layer that reuses the pure `aggregate()` twice; a dedicated `report` command (not a `stats --weekly` flag).

## Existing infrastructure this builds on
- `src/stats/load.ts` `loadAuditWindow(repoRoot, {since?, last?})` reads the date-partitioned `.reviewgate/audit/**/*.jsonl`, parses `run.complete` (→ `RunSummary`) and `escalation` events; supports a `since` lower bound and `last` (most-recent N). Escalation count is windowed to the kept runs when `last` is used.
- `src/stats/aggregate.ts` `aggregate(runs, escalationCount, fpEntries, brainEntries): StatsReport` — **pure**. `StatsReport` = window {runCount, firstTs, lastTs, bySource{panel,cache,skipped}}, verdicts{PASS,SOFT-PASS,FAIL,ERROR}, escalationRate, cost{total,avgPerRun,perProvider}, providers[]{provider,runs,findings,demoteRate,errorRate,avgDurationMs,cost}, topSignatures[], fpLedger{active,sticky,candidate,perProviderConfirmed}, brain{byStatus,byType}. Panel-only data is filtered from runs where `source==="panel"`.
- `src/cli/commands/stats.ts` wires load → fp/brain snapshots → aggregate → render/json.
- Schemas: `FpLedgerEntry` has `first_seen_at`, `last_seen_at`, `created_at`, `stage`, `rejects[]{provider}`. `BrainEntry` has `created_at`, `last_referenced_at?`, `status` (candidate/active/stale/archived), `type`. **Brain has NO `promoted_at`.**
- `src/audit/logger.ts`: partitions are `audit/<YYYY>/<MM>/<DD>/<stamp>.jsonl`. `currentFilePath()` **memoizes the partition path for the whole process lifetime** while each event gets a fresh `ts` (relevant to §2's guard day).
- `src/core/loop-driver.ts`: `LoopInput` carries `repoRoot`, `config: ReviewgateConfig`, `audit: AuditLogger`. `run.complete` is emitted (~L308) via `this.i.audit.append(...).catch(...)` on the iteration path; re-arm on clean PASS / commit follows.
- Everything under `.reviewgate/` is excluded from the reviewed diff.

## 1. `src/stats/iso-week.ts` (pure, no I/O)
ISO-8601 weeks in **UTC**.
- `isoWeekOf(date): {year, week}` (Thursday rule).
- `weekBounds(year, week): {since: ISO, until: ISO}` — Mon 00:00:00.000Z to next Mon 00:00:00.000Z; `until` exclusive → half-open `[since, until)`.
- `lastCompleteWeek(now): {year, week}` — the most recent ISO week that has **fully ended**, defined precisely as the week whose `weekBounds(...).until <= now` (NOT "Sunday < now", which on a Sunday UTC would wrongly pick the still-in-progress current week). Equivalent: `previousWeek(isoWeekOf(now))`.
- `previousWeek({year,week}): {year,week}`.
- `formatIsoWeek` → "2026-W20"; `parseIsoWeek("2026-W20")`.
- `weeksInIsoYear(year): number` (52 or 53). **`weekBounds(year, week)` itself validates** week ∈ [1, weeksInIsoYear(year)] (throws on out-of-range) so every direct caller is guarded, not just `parseIsoWeek` (which also validates and rejects `2026-W54`/`W00`). `previousWeek` of W01 rolls back to the previous ISO year's last week (W52/W53 via `weeksInIsoYear`).

## 2. `load.ts` change
A run is assigned to a week by its **`run.complete` audit append timestamp** (`obj.ts`, already the loader's sort/filter key) — i.e. review *completion* time, not review-start. A long review crossing a week boundary lands in the week it finished. Stated for clarity; no behavior change.

Add an optional `until` (exclusive upper bound) to `loadAuditWindow` opts so a single ISO week is loadable as `[since, until)`. **The `until` filter applies to BOTH runs and escalations, alongside `since`, BEFORE the `last` narrowing** (so a week-bounded query can never count escalations outside `[since, until)`). `since`/`last`/`json` unchanged (additive; existing tests stay green). Weekly queries pass `since`+`until` and never `last`.

**Partition-scoped scan (cost bound):** the audit log is partitioned `audit/<YYYY>/<MM>/<DD>/*.jsonl`. When BOTH `since` and `until` are given, `loadAuditWindow` restricts the `Bun.Glob` to the **day partitions overlapping `[since − 1 day, until]`** instead of `**/*.jsonl` over the full history (the exact `ts` filter still runs on the contents — over-scanning adjacent partitions is safe, never wrong). This bounds the weekly load cost independent of total audit-history size (directly bounds the auto-snapshot hot-path work). The `since`-only / `last` paths keep the full-history scan (unchanged behavior).

**Why the ±1-day guard (correctness, not just margin):** `AuditLogger.currentFilePath()` memoizes its partition path for the whole process lifetime, while every event gets a fresh `ts`. A gate/CLI process that crosses UTC midnight therefore writes a `ts`-day-D+1 event into day-D's partition file. So an event whose `ts` is inside `[since, until)` can physically live in the partition of the day *before* `since`. The guard day before `since` (plus including `until`'s day) recovers these boundary events. This is safe under the invariant that a single gate/CLI process lives far less than a day (a review is seconds–minutes); the design records that assumption.

## 3. `WeeklyReport` shape + `buildWeeklyReport()` (pure)
```ts
interface Delta { current: number; previous: number; abs: number; }
interface WeeklyReport {
  meta: {
    generatedAt: string;
    fpBrainReflect: "generation-time";              // counts+highlights are live-state, not durable
    status: "complete" | "partial" | "future";      // machine-visible week state
    generatedThrough: string | null;                // the `now` cutoff for a partial week; null otherwise
  };
  week: { iso: string; since: string; until: string };
  previousWeek: { iso: string } | null;             // null only when no prior history (see trend rule)
  current: StatsReport;
  trend: {
    runCount: Delta;
    cost: Delta;                                    // total
    escalationRate: Delta;                          // fraction
    verdicts: Record<"PASS"|"SOFT-PASS"|"FAIL"|"ERROR", Delta>;
    providerErrorRate: { provider: string; delta: Delta }[];  // UNION (see below)
  } | null;                                         // null when previousWeek null
  highlights: {
    newFpSignatures: { signature: string; stage: string; providers: string[] }[]; // first_seen_at in week
    newBrainEntries: { id: string; type: string; status: string }[];              // created_at in week
    topCostProviders: { provider: string; cost: number }[];                       // top 3 from current
    newSignatures: { signature: string; count: number }[];                        // in target week, not in prev
  };
}
```

`buildWeeklyReport(current: StatsReport, previous: StatsReport | null, args)` — **pure**, computes deltas + highlights. No file/time access. `args` carries the data `StatsReport` can't supply (resolved at the CLI/load layer):
- `currentSignatures: Map<string,number>` and `previousSignatures: Map<string,number>` — the signature multisets for each week, derived from `window.runs[].summary.signatures` (NOT `StatsReport.topSignatures`, which is capped to 10 by the renderer). `newSignatures` = keys in `currentSignatures` absent from `previousSignatures`, with their current-week counts, sorted desc. This removes the renderer's top-10 cap.
  - **Persistence cap (documented, accepted):** the audit log itself stores only the first `SIGNATURE_CAP = 20` CRITICAL/WARN finding signatures **per run** (`buildRunSummary`). So `newSignatures` reflects *newly observed CRITICAL/WARN panel-run signatures subject to the 20-per-run cap*, not literally every finding. A recurring signature appears across many runs and is reliably captured; only a signature consistently beyond the 20th in **every** run of the week could be missed (requires >20 distinct CRITICAL/WARN per run — pathological). No schema change this milestone; the cap is stated in the rendered report and spec.
- `windowedFpEntries`, `windowedBrainEntries` — full FP/brain entries already filtered to `first_seen_at` / `created_at` ∈ `[since, until)`.
- `generatedAt: string` and `now: Date` — supplied by the CLI/snapshot layer so `buildWeeklyReport` stays **pure** (no `Date.now()` inside it). `meta.generatedAt = generatedAt`, and `status`/`generatedThrough` are derived from `now` vs the week bounds (`until <= now` → "complete"; `since <= now < until` → "partial", `generatedThrough = generatedAt`; `since > now` → "future"). Passing the same clock for both keeps `generatedAt`, `status`, and `generatedThrough` mutually consistent. The renderer derives the in-progress banner purely from these machine-visible fields, so `--json` consumers can detect partial/future without re-deriving from timestamps.

### Highlight mapping against the real schemas
- The highlight windowing reads the **full** `FpLedgerStore`/`BrainStore` entries (carrying `id`, `first_seen_at`, `created_at`, `rejects[]`) — NOT the lite `{stage,rejects:{provider}}` / `{status,type}` shape `aggregate()` consumes. The CLI already loads both full snapshots (`fpSnap.entries`, `brainSnap.entries`); it derives the lite shape for `aggregate()` AND passes the full entries (filtered to the week) for highlights.
- `newFpSignatures`: one row per FP entry whose `first_seen_at` ∈ `[since, until)`. `providers` = the **distinct** providers from that entry's `rejects[]` (deduped, sorted). Rows sorted by `first_seen_at` desc, capped at 20.
- `newBrainEntries`: one row per brain entry whose `created_at` ∈ `[since, until)`, fields `{id, type, status}`. Sorted by `created_at` desc, capped at 20.

### Trend baseline — `null` only when there is no detectable prior history
`previousWeek`/`trend` is `null` **iff `hasPriorHistory` is false**, where `hasPriorHistory` = the previous ISO week's aggregate has runs **OR** any audit **day-partition directory dated `< week.since` exists**. A prior *calendar* week that simply had **zero runs** but with older history present is a **valid zero baseline**, not null: `aggregate([], 0, …)` yields an all-zero `StatsReport`, and the trend renders real deltas (e.g. runCount 12 vs 0 → +12). This avoids mislabeling "quiet week then active week" as a "first report".

The probe is intentionally **directory-existence-based, not run-content-based** (cheap `readdir` of `audit/<YYYY>/<MM>/` dirs, stop at the first older partition — no `.jsonl` parsing, never materializes historical runs). The trade-off, stated so the rule and the probe agree: an older partition holding **only** non-run events (e.g. `escalation`) counts as prior history → `previousWeek` is non-null and the trend renders deltas vs a zero baseline. This is acceptable ("there was earlier activity, just no runs in the immediately prior week") and is the *defined* contract — there is no separate "must be a `run.complete`" requirement. The CLI/load layer passes the previous-week `StatsReport` (possibly all-zero) plus `hasPriorHistory` into `buildWeeklyReport`; when `!hasPriorHistory`, `previous` is treated as null.

### `providerErrorRate` delta membership
The **union** of providers present in current OR previous week. A provider absent in one week contributes `errorRate = 0` for that side (matches `aggregate()`, which already yields 0 when `runs === 0`), so a provider that vanished still shows its negative delta and a brand-new provider shows a positive one. Each row is keyed by provider, sorted by name.

### FP-ledger / brain semantics (made explicit)
- The `current: StatsReport` **fpLedger/brain counts reflect state AS OF report generation** (a live `FpLedgerStore`/`BrainStore` snapshot — same as `reviewgate stats`). Historical ledger/brain *counts* cannot be reconstructed for a past week, so for a backfilled `--week` these counts are TODAY's, not that week's. Documented in the rendered report ("FP-ledger / brain reflect current state").
- The **highlights** (`newFpSignatures`, `newBrainEntries`) are derived from the **current** store state filtered by timestamp. They are therefore **also live-state-dependent, NOT a durable historical record**: the stores mutate (`FpLedgerStore.decayPass()` drops candidate entries, `BrainStore.revoke()` deletes brain entries), so an entry created in an old week can later vanish from that week's backfilled highlights. Honest semantics: highlights answer "which still-present FP/brain entries were first seen this week", not "everything ever created this week". (The run-derived sections — verdicts/cost/trend/signatures — ARE durable, sourced from the append-only audit log.)
- `meta.fpBrainReflect: "generation-time"` makes this machine-visible for BOTH counts and highlights, so JSON consumers do not infer durable historical week-state. These live-snapshot fields are deliberately **excluded from `trend`** (trend only covers run-derived metrics).
- `newSignatures` counts only **panel-run** signatures — cached/skipped runs contribute none, so "new signatures" means newly observed panel-run signatures, not every finding that touched the gate that week.

**Known limitation (documented):** "new brain entries" uses `created_at` (no `promoted_at` field), so it shows newly *created* memories, not newly *promoted* ones. No schema change this milestone.

## 4. `src/stats/weekly-render.ts`
Markdown document (NOT the terminal-box style of `render.ts`). Header + Summary table (Runs, Cost, Escalation rate with Δ), Verdicts table, Reviewer per-provider error-rate Δ, Highlights, and the FP/brain "current state" caveat line. Trend arrows ▲/▼/▬ (unicode glyphs, no color). When `previousWeek` null → "first report" note, trend columns omitted. `meta.status: "partial"` → an `⚠ in progress — week-to-date through <generatedThrough>` banner; `"future"` → a "no runs in `<iso>`" note.

## 5. CLI: `reviewgate report` (`src/cli/commands/report.ts`)
- `reviewgate report` → last complete week; renders Markdown to **stdout** AND writes `.reviewgate/reports/<iso>.md`.
- `--week 2026-W20` → specific week (re-render/backfill).
- `--json` → JSON to stdout, writes **no** file (pure data dump, consistent with `stats --json`).
- Registered in `src/cli/index.ts`.

### Week-state semantics (default vs `--week`)
- Default no-arg → **last complete week** (`until <= now`); never partial.
- `--week <current in-progress week>` (`since <= now < until`) → **partial "week-to-date" report**: includes the `run.complete` events recorded so far this week, banner-labeled `⚠ in progress — week-to-date through <now ISO>`. Trend compares against the previous (complete) week, also flagged partial.
- `--week <future week>` (`since > now`) → **zero-run report** (header + "no runs in `<iso>`" note).
- A past week with genuinely zero runs → zero-run report (not an error, not the `stats` "no review history" message).
- A *malformed* week string (`parseIsoWeek` reject) → clear error.
- The auto-snapshot path only ever targets the **last complete** week, so it never produces a partial report; it *skips* (writes `.empty`) a zero-run week (§6.2).

### Write semantics — shared `writeReportFile(path, content, { exclusive })`
The CLI markdown path **always (re-)renders and overwrites** (explicit user command = fresh render). The auto-snapshot path **creates only if absent, never overwrites**. Both go through one helper:
- mkdir the reports dir; write full content to a **process-unique** temp file `.<iso>.md.<crypto.randomUUID()>.tmp` (UUID, not just pid — two writes for the same week from one process must not clobber each other's temp).
- `exclusive: false` (CLI) → `renameSync(temp, final)` (atomic overwrite).
- `exclusive: true` (auto) → `linkSync(temp, final)` then `unlinkSync(temp)`. `link` is atomic and **fails with `EEXIST` if `final` exists**, so concurrent auto-writers cannot last-writer-wins clobber: the loser catches EEXIST, unlinks its temp, no-ops. (`rename` cannot provide create-if-absent atomically; `link`+`unlink` is the standard exclusive-atomic-create idiom.) On any throw the temp is cleaned up in a `finally`.

## 6. Auto-snapshot (opt-in)
- **Config:** `weeklyReport: { autoSnapshot: boolean }` added to **`ConfigSchema` in `define-config.ts`** AND operational defaults in **`src/config/defaults.ts`** (default `autoSnapshot: false`). `init` **does** scaffold a starter `reviewgate.config.ts` (`src/cli/commands/init.ts`, plain-object literal ~L147) — add a **commented-out** `weeklyReport: { autoSnapshot: true }` line to the starter, matching the existing commented-example style.
- `src/stats/snapshot.ts` `maybeWriteWeeklySnapshot(repoRoot, config, { now?: Date })`:
  1. **Cheap short-circuits FIRST (no audit scan):** compute last-complete-week, then three `stat()`s, return on any hit: (a) `reports/<iso>.md` exists → already written; (b) `reports/.<iso>.empty` exists → that week had zero runs (permanent sentinel — a past complete week cannot gain new runs); (c) `reports/.<iso>.failed` exists and mtime younger than `SNAPSHOT_RETRY_COOLDOWN` (6h) → in cooldown. These `stat()`s are the only steady-state cost; the expensive load runs **at most once per ISO week per repo on the success path** (and at most ~once/6h while persistently failing). Even then the load is partition-scoped (§2) to ~2 weeks of day-dirs and network-free.
  2. Load the week + previous week, build the report. **If the target (last-complete) week has zero runs → write the `.<iso>.empty` sentinel and return** (no empty report file; the sentinel prevents every later gate-stop this week from rescanning).
  3. Write via `writeReportFile(path, content, { exclusive: true })` (§5).
  4. **Failure handling:** if build/render/write throws, write/refresh the cooldown marker `.<iso>.failed` (mtime = now) and no-op. The marker is **expiring, not a poison** — after the cooldown the build retries (self-healing for transient corruption that later clears). Combined with step 1 this caps a persistently-failing build to one expensive attempt per cooldown window instead of per gate-stop.
- No automatic backfill of older weeks (use `--week`).
- **Testability:** the injectable `{ now?: Date }` clock (default `new Date()`) lets cooldown-expiry and week-rollover tests drive time deterministically; the wrapper threads the same clock into `buildWeeklyReport`'s `now`/`generatedAt`.

### Call site, ordering & isolation (in `loop-driver.ts`)
On the iteration path (the branch that runs `runIteration`; NOT the early allow/escalation branches), placed **AFTER the state update and `dirty.flag` handling are committed** — the **last** trailing side-effect before the `LoopDecision` is returned, not in the gap between the `run.complete` append and the state mutation. This guarantees an interruption (kill/hang) *during* the snapshot cannot leave the audit log advanced while gate state lags. It fires on **every iteration verdict** (the snapshot always targets the last *complete* week, verdict-independent; existence/empty/cooldown guards short-circuit all but the first post-rollover stop). Wrapped in its **own** `try/catch`, separate from the audit append's `.catch` — a snapshot failure can never affect audit logging, state, or the verdict. Only runs when `config.weeklyReport?.autoSnapshot`.

**Awaited, with an explicitly accepted one-time latency.** The gate is a short-lived CLI process that exits right after `runGate`, so a fire-and-forget snapshot would be killed before finishing — therefore `maybeWriteWeeklySnapshot` is **`await`ed**. The cost is paid synchronously only on the **first gate-stop after weekly rollover** (every other stop hits a `stat()` short-circuit); it is **bounded** (partition-scoped scan of ~2 weeks + pure aggregation/render + one small file write, no network) and at most once per ISO week. No background/queue mechanism — it would not survive the process exit and is unjustified for an at-most-weekly cost.

## 7. Tests (TDD)
- `iso-week.test.ts` — bounds, year boundary (W52/W53/W01 incl. a 53-week year), Thursday rule, parse/format roundtrip, BOTH `parseIsoWeek` AND `weekBounds` REJECT out-of-range (`2026-W54`/`W00`), `lastCompleteWeek` on a Sunday UTC picks the ended week, `previousWeek(W01)` → prev year's last week.
- `load.test.ts` — `until` filter on both runs AND escalations (additive); partition-scoped scan == full scan; a boundary event with in-window `ts` written into the prior day's partition (memoized-path/midnight-crossing) is still found via the −1-day guard.
- `weekly.test.ts` — deltas; true-first-report `null` vs zero-run-previous-week (zero baseline → real +deltas, NOT "first report"); highlight windowing (in/out of `[since,until)`); `newFpSignatures.providers` distinct+sorted from `rejects[]`; `newBrainEntries` carries `id` from full entries; new-signature diff beyond the renderer top-10; `providerErrorRate` union (vanished provider keeps its delta; new provider appears).
- `weekly-render.test.ts` — arrow selection, null-prev path, table form, FP/brain "current state" caveat line, zero-run "no runs in `<iso>`" note, `meta.status` "partial" → banner with `generatedThrough`, "future" note.
- `snapshot.test.ts` — idempotence (existing file → no-op, no audit scan); zero-run last-complete week → writes `.empty` + no report + later calls short-circuit on the sentinel; cooldown marker on failure suppresses retry until expiry then retries; exclusive `link` create → second writer EEXIST → no-op (no clobber); CLI overwrite vs auto exclusive; temp file unique (UUID); mkdir missing reports dir; no partial final file on mid-build throw; injectable clock drives rollover/cooldown.
- `report.test.ts` (CLI) — default = last complete week; `--week` current-in-progress → partial banner + includes this-week runs; `--week` future → zero-run; `--json` writes no file; markdown path overwrites; `hasPriorHistory` dir-existence probe (older partition exists → trend not null even when prev calendar week empty).
- Integration: `report-pipeline.test.ts` — seeded 2-week audit log → CLI → Markdown with correct deltas. Plus **compiled-binary verification** (per the project's real-e2e rule).

## Out of scope / deferred
- `promoted_at` on `BrainEntry` (would make "newly promoted this week" exact) — not this milestone.
- Durable historical FP/brain snapshots per week — not reconstructable from current schemas; counts/highlights are honestly scoped as generation-time.
- Native sandbox (blocked — `@anthropic-ai/sandbox-runtime` unpublished).

### Known limitation — partial report is not refreshed by the auto-snapshot

If a user runs `reviewgate report --week <iso>` for the **current, still-in-progress week**, a partial (week-to-date) report is written to `.reviewgate/reports/<iso>.md`. When that week later completes and the auto-snapshot fires (`maybeWriteWeeklySnapshot`), it hits the `existsSync(weekReportPath(...))` short-circuit and treats the file as already written — it does **not** overwrite the stale partial with the final complete version. This is by design (§6.1(a) — any existing `<iso>.md` is treated as authoritative to avoid concurrent-write races). To refresh a partial report once the week has ended, re-run `reviewgate report --week <iso>` explicitly (the CLI path always overwrites).
