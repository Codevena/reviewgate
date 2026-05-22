# Reviewgate — `reviewgate stats` (design)

**Date:** 2026-05-22 · **Status:** design (brainstormed, approved) · **Milestone:** M6/roadmap · **Default:** instrumentation always-on (one best-effort event/run); `stats` is a read-only CLI.

## Problem

Reviewgate has no visibility into its own behaviour over time: how often it passes vs blocks, how much it costs, which reviewer is valuable vs noisy, how often it escalates, what it has learned (FP-ledger / brain). The data to answer this is **not recorded today** — the audit log only emits `gate.decision` + `escalation` events carrying `{schema, ts, run_id, iter, event, trigger, hash}`; the rich `AuditEventSchema` fields (`gen_ai`, `cost_usd`, `finding_count`, `reviewer`, `latency_ms`) and most `EventType`s are defined but never written, and per-iteration `decisions/` are wiped each cycle. So trends must first be **recorded**, then **aggregated**.

## Approach (decided)

Two units. **(1) Instrumentation:** at the end of each review the orchestrator already computes the verdict, per-reviewer usage/duration, and demote counts — extend its `IterationResult` with a structured `summary`, and have the `LoopDriver` (which owns the audit logger) emit ONE `run.complete` audit event carrying it (a new optional `run_summary` field). This is the minimal honest source of trends, recorded going forward (history before instrumentation stays thin). **(2) Aggregation:** a read-only `src/stats/` module (load → aggregate → render) behind a `reviewgate stats` command. The date-partitioned audit log (`.reviewgate/audit/YYYY/MM/DD/*.jsonl`) is the single historical source; the FP-ledger and brain are read as current snapshots for their summary sections.

## Architecture

The orchestrator stays audit-logger-free (it returns data; the LoopDriver logs — same split as today, where `gate.decision` is emitted by the LoopDriver). The audit log is the append-only, hash-chained, gitignored history. `src/stats/` is pure read-only aggregation with no writes.

### Components (one responsibility each)

- **`src/schemas/audit-event.ts` (modify).** Add an optional `run_summary` object to `AuditEventSchema`:
  ```
  run_summary?: {
    verdict: "PASS" | "SOFT-PASS" | "FAIL" | "ERROR";
    counts: { critical: int; warn: int; info: int };   // post-aggregation severities
    cost_usd: number;
    duration_ms: number;
    demoted: int;                                        // findings demoted to INFO (scope_demoted OR fp_ledger_match OR critic likely_fp)
    signatures: string[];                                // blocking findings' signatures, capped at 20 — feeds top-recurring
    reviewers: { provider: ProviderId; persona: string; status: ReviewStatus;
                 findings: int; demoted: int; cost_usd: number; duration_ms: int }[];
  }
  ```
  Optional + backward-compatible (existing events omit it). `run.complete` is already in `EventType`. **No `escalated` field** — escalation is not knowable at iteration time (the LoopDriver decides escalation as a precondition on later stops), so escalation rate is derived in stats from the existing `escalation` audit events, not from `run_summary`. **Bounding (hash-chain stability):** `signatures` capped at 20; `reviewers` is bounded by the configured panel size; provider/persona/status are short enums/identifiers — so a `run.complete` line stays small.

- **`src/core/orchestrator.ts` (modify).** Extend `IterationResult` with `summary: RunSummary`. On the **normal path** it is built AFTER `aggregate()` from `agg` (`{ verdict, dedupedFindings, counts }`) + the `settled` reviewer runs:
  - `verdict`/`counts` ← `agg`; `cost_usd`/`duration_ms` ← the existing summed values.
  - `demoted` (total) ← count of `agg.dedupedFindings` carrying ANY demotion marker: `scope_demoted === true` OR `fp_ledger_match?.suppressed === true` OR `critic_verdict === "likely_fp"`. (The orchestrator today counts only the critic case — broaden it.)
  - `signatures` ← the blocking (CRITICAL/WARN) findings' `signature`s, capped at 20.
  - **per-reviewer** ← one entry per `settled` `ReviewerRun` (provider, persona, `res.status`, `res.usage.costUsd`, `durationMs`). `findings` = number of `agg.dedupedFindings` that the provider contributed, i.e. the provider appears as the representative `reviewer.provider` OR in `members[].reviewer.provider` (a merged finding counts toward each contributing provider). `demoted` = that subset which now carries a demotion marker.

  **Early-return paths each return an explicit, partial `summary`** (fields that didn't happen are zero/empty, not faked): triage-skip → `verdict:"PASS"`, reviewers `[]`, cost 0, counts `{0,0,0}`, signatures `[]`; cache-hit → cached `verdict`+`counts`, reviewers `[]`, cost 0, signatures `[]` (the cache stores only verdict+counts); sandbox-refuse → `verdict:"ERROR"`, reviewers `[]`; reviewer-error → `verdict:"ERROR"`, reviewers from the `settled` runs (status/cost/duration; findings 0), counts `{0,0,0}`. stats treats empty-reviewer/zero-cost runs honestly (a cached or skipped run contributes a verdict but no cost/reviewer rows).

- **`src/core/loop-driver.ts` (modify).** ONLY on the path that actually calls `orchestrator.runIteration(...)` (NOT the early exits — no-dirty-flag allow, nor the escalation-precondition paths `cost-cap`/`max-iterations`/`stuck-signatures`/`reject-rate-high`/`decisions-unaddressed` which never run an iteration), emit one `run.complete`: `audit.append({ event: "run.complete", run_id, iter, trigger, run_summary: result.summary })`. Best-effort `.catch` (like the existing `gate.decision` append) — never breaks the gate. Escalations continue to be recorded by the existing `escalation` event (emitted on those precondition paths), which stats consumes separately.

- **`src/stats/load.ts` — `loadAuditWindow(repoRoot, { since?, last? })`.** Walk `.reviewgate/audit/**/*.jsonl` (date-partitioned), parse JSONL (skip malformed lines), sort by `ts`, and return BOTH the `run.complete` runs (`{ ts, run_id, iter, summary }[]`, filtered to those carrying `run_summary`) AND the count of `escalation` events in the window. `since` (ISO date) prunes by the date-partition path + `ts`; `last` (int) keeps the most recent N **runs** (escalation events are counted within the same `since`/post-`last` window).

- **`src/stats/aggregate.ts` — `aggregate(runs, escalationCount, fpSnapshot, brainSnapshot): StatsReport`.** Pure function → a typed report:
  - **Verdict & activity:** run count, verdict distribution (counts + %), **escalation rate = `escalationCount / runs.length`** (from the separate `escalation` events, NOT `run_summary`), first/last run ts.
  - **Cost:** total, avg/run, per-provider (summed from `reviewers[].cost_usd`), and a small per-day series.
  - **Reviewer performance** (windowed, from `run_summary.reviewers`): per provider — runs participated, total findings contributed, **demote rate** (`Σdemoted / Σfindings`), error+timeout rate (from `status`), avg `duration_ms`, total cost.
  - **Findings & learn-state:** top recurring finding signatures (from the capped `run_summary.signatures`); overall demote rate; FP-ledger summary (active/sticky/candidate counts) **and per-provider confirmed-FP reject counts** (all-time, from `fpSnapshot.rejects[].provider`); brain summary (entries by status/type). Per-provider confirmed-FP is reported as a COUNT in this learn-state section (all-time) — deliberately NOT divided by windowed findings, to avoid mixing an all-time numerator with a windowed denominator.

- **`src/stats/render.ts` — `renderStats(report): string`.** Human-readable sections (mirrors `doctor` / `fp audit` output style). Empty data → a clear "no review history yet — run a review first" line.

- **`src/cli/commands/stats.ts` + `src/cli/index.ts` (modify).** `reviewgate stats [--since <YYYY-MM-DD>] [--last <N>] [--json]`. Default: human render. `--json`: print the `StatsReport` object. Registered alongside `doctor`/`fp`/`brain`.

### Data flow

```
review run → orchestrator returns IterationResult{ summary } → LoopDriver emits
            run.complete{ run_summary } into .reviewgate/audit/<date>/<run>.jsonl

reviewgate stats [--since|--last|--json]
  → loadAuditWindow(window) → { runs, escalationCount }  + FpLedger snapshot + Brain snapshot
  → aggregate(runs, escalationCount, fp, brain) → StatsReport
  → renderStats()  (or JSON.stringify)
```

### Error handling

`stats` is read-only and best-effort: missing/empty audit dir → "no data" message (exit 0); malformed JSONL lines skipped; absent FP-ledger/brain → those sections render "none". The `run.complete` emit is wrapped in `.catch` so a logging failure never affects the verdict; it participates in the hash chain like any other event (appended through the same `AuditLogger`).

## Testing

- **Unit:** `run_summary` schema (valid + optional); `aggregate` (verdict distribution + %, cost totals/per-provider, reviewer demote rate, FP-confirmation rate from a seeded fp snapshot, `since`/`last` filtering, empty input); `render` (sections present; empty → "no data"); `load` (date-partition walk, malformed-line skip, run.complete-only filter).
- **Integration:** drive one review **via a cassette** (deterministic, no LLM) through the LoopDriver/orchestrator → assert a `run.complete` with a correct `run_summary` is appended (verdict, per-reviewer findings/demoted derived from the deduped findings) → `loadAuditWindow` + `aggregate` produce the expected report. (Reuses the cassette feature for a hermetic end-to-end stats test.)
- **Compiled-binary smoke:** seed a `.reviewgate/audit/` with a couple of `run.complete` lines → `dist/reviewgate stats` renders + `--json` parses, in the compiled binary.

## Scope / non-goals

- **In:** the `run.complete`/`run_summary` instrumentation; `src/stats/` load+aggregate+render; the `stats` CLI (`--since`/`--last`/`--json`); all four metric groups (verdict/activity, cost, reviewer-performance, findings+learn-state).
- **Out (follow-ups):** weekly report generation (roadmap #3 — builds on this aggregation); per-file/per-rule deep analytics; cross-repo aggregation; backfilling pre-instrumentation history; live/streaming dashboards; retention/rotation of run.complete events (the existing audit retention applies).

## Decomposition

One plan, bottom-up: (1) `audit-event` `run_summary` schema → (2) orchestrator `IterationResult.summary` (all return paths) → (3) LoopDriver `run.complete` emit → (4) `stats/load` → (5) `stats/aggregate` → (6) `stats/render` → (7) `stats` CLI + index wiring → (8) integration (cassette-driven) + compiled-binary smoke + DoD.
