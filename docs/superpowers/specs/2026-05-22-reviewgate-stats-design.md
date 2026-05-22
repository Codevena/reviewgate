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
    escalated: boolean;
    demoted: int;                                        // findings demoted to INFO (scopeToDiff + fp-ledger)
    signatures: string[];                                // blocking findings' signatures, capped (e.g. ≤20) — feeds top-recurring
    reviewers: { provider: ProviderId; persona: string; status: ReviewStatus;
                 findings: int; demoted: int; cost_usd: number; duration_ms: int }[];
  }
  ```
  Optional + backward-compatible (existing events omit it). `run.complete` is already in the `EventType` enum.

- **`src/core/orchestrator.ts` (modify).** Extend `IterationResult` with `summary: RunSummary` (the shape above), populated from data the pipeline already has: `agg.verdict`, `agg.counts`, the summed `costUsd`/`durationMs`, the per-reviewer `ReviewerRun`s (provider/persona/status/usage/duration + how many of their findings survived vs were demoted), the count of demoted findings, and the escalation flag. No new computation — just surfacing what `runIteration` already computes. The early-return paths (triage skip, cache hit, sandbox refuse, reviewer-error ERROR) each return a `summary` with the right verdict and empty/partial reviewer list.

- **`src/core/loop-driver.ts` (modify).** After `orchestrator.runIteration(...)`, emit one `run.complete` audit event: `audit.append({ event: "run.complete", run_id, iter, trigger, run_summary: result.summary })`. Best-effort `.catch` (like the existing `gate.decision` append) — never breaks the gate. Emitted once per iteration, regardless of allow/block.

- **`src/stats/load.ts` — `loadRunSummaries(repoRoot, { since?, last? })`.** Walk `.reviewgate/audit/**/*.jsonl` (date-partitioned), parse JSONL (skip malformed lines), keep `run.complete` events that carry `run_summary`, sort by `ts`. `since` (ISO date) prunes by the date-partition path + `ts`; `last` (int) keeps the most recent N. Returns `{ ts, run_id, iter, summary }[]`.

- **`src/stats/aggregate.ts` — `aggregate(runs, fpSnapshot, brainSnapshot): StatsReport`.** Pure function → a typed report:
  - **Verdict & activity:** run count, verdict distribution (counts + %), escalation rate, first/last run ts.
  - **Cost:** total, avg/run, per-provider (summed from `reviewers[].cost_usd`), and a small per-day series.
  - **Reviewer performance:** per provider — runs participated, total findings contributed, demote rate (`demoted/findings`), error+timeout rate (from `status`), avg `duration_ms`, total cost, and **FP-confirmation rate** from `fpSnapshot` (`rejects[].provider` ÷ that provider's findings).
  - **Findings & learn-state:** top recurring finding signatures (from the capped `run_summary.signatures`), overall demote rate, FP-ledger summary (active/sticky/candidate counts), brain summary (entries by status/type).

- **`src/stats/render.ts` — `renderStats(report): string`.** Human-readable sections (mirrors `doctor` / `fp audit` output style). Empty data → a clear "no review history yet — run a review first" line.

- **`src/cli/commands/stats.ts` + `src/cli/index.ts` (modify).** `reviewgate stats [--since <YYYY-MM-DD>] [--last <N>] [--json]`. Default: human render. `--json`: print the `StatsReport` object. Registered alongside `doctor`/`fp`/`brain`.

### Data flow

```
review run → orchestrator returns IterationResult{ summary } → LoopDriver emits
            run.complete{ run_summary } into .reviewgate/audit/<date>/<run>.jsonl

reviewgate stats [--since|--last|--json]
  → loadRunSummaries(window) + FpLedger snapshot + Brain snapshot
  → aggregate() → StatsReport
  → renderStats()  (or JSON.stringify)
```

### Error handling

`stats` is read-only and best-effort: missing/empty audit dir → "no data" message (exit 0); malformed JSONL lines skipped; absent FP-ledger/brain → those sections render "none". The `run.complete` emit is wrapped in `.catch` so a logging failure never affects the verdict; it participates in the hash chain like any other event (appended through the same `AuditLogger`).

## Testing

- **Unit:** `run_summary` schema (valid + optional); `aggregate` (verdict distribution + %, cost totals/per-provider, reviewer demote rate, FP-confirmation rate from a seeded fp snapshot, `since`/`last` filtering, empty input); `render` (sections present; empty → "no data"); `load` (date-partition walk, malformed-line skip, run.complete-only filter).
- **Integration:** drive one review **via a cassette** (deterministic, no LLM) through the LoopDriver/orchestrator → assert a `run.complete` with a correct `run_summary` is appended → `loadRunSummaries` + `aggregate` produce the expected report. (Reuses the cassette feature for a hermetic end-to-end stats test.)
- **Compiled-binary smoke:** seed a `.reviewgate/audit/` with a couple of `run.complete` lines → `dist/reviewgate stats` renders + `--json` parses, in the compiled binary.

## Scope / non-goals

- **In:** the `run.complete`/`run_summary` instrumentation; `src/stats/` load+aggregate+render; the `stats` CLI (`--since`/`--last`/`--json`); all four metric groups (verdict/activity, cost, reviewer-performance, findings+learn-state).
- **Out (follow-ups):** weekly report generation (roadmap #3 — builds on this aggregation); per-file/per-rule deep analytics; cross-repo aggregation; backfilling pre-instrumentation history; live/streaming dashboards; retention/rotation of run.complete events (the existing audit retention applies).

## Decomposition

One plan, bottom-up: (1) `audit-event` `run_summary` schema → (2) orchestrator `IterationResult.summary` (all return paths) → (3) LoopDriver `run.complete` emit → (4) `stats/load` → (5) `stats/aggregate` → (6) `stats/render` → (7) `stats` CLI + index wiring → (8) integration (cassette-driven) + compiled-binary smoke + DoD.
