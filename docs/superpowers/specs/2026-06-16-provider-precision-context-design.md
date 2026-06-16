# Advisory Per-Provider Precision Context — Design (field-report #8)

**Date:** 2026-06-16
**Field-report item:** #8 — "Calibrate confidence per provider/persona (openrouter minority ≠ codex unanimous)."
**Status:** approved, pre-implementation.

## Problem & scope decision

The field report asked to weight a finding's block-force by the raising provider's
reliability. During brainstorming we found that the **reputation system already
does this**: its trust score `(c+1)/(c+w+2)` is a Beta-smoothed, time-decayed
precision-like ratio, and it already **demotes** a below-floor reviewer's lone,
uncorroborated, non-security findings (default-on: `trustFloor 0.35`,
`minSamples 8`, security + corroborated exempt). The `reviewgate stats` precision
metric (`tp/(tp+fp)` per provider) is a near-twin computed from the *same*
accepted/rejected decisions, currently measurement-only.

Wiring that precision into block-weighting (the roadmap's literal suggestion)
would create a **second, overlapping per-provider suppressor** — double-counting
the same decisions, two knobs doing nearly the same job, and added over-suppression
risk (violating the project rule "a suppressor must FAIL SAFE"). So, mirroring the
#3 pivot (unsound demote → non-suppressing context injection), this design takes
**Option A: surface per-provider precision as ADVISORY context** — it informs the
agent's/human's accept-or-reject decision without ever changing the verdict.

In scope: compute per-provider historical precision at gate time and annotate each
finding in `pending.md` / `pending.json` with the contributing provider(s)' track
record. Default-on, single toggle.

Out of scope: any change to severity, verdict, consensus, or the
reputation/confidence demote pipeline. This feature is **purely additive metadata**
— it cannot hide, demote, or drop a finding. (That is the whole point of choosing
Option A over the literal precision-demoter.)

## Data source

The `decision.applied` audit events (`DecisionOutcome` in
`src/schemas/audit-event.ts`): each carries `bucket` ∈ {`tp`, `fp`, `declined`},
`severity`, and `providers` (base provider ids from `normalizeProviders` —
`reviewer.provider` + `members[].provider`, persona suffix stripped, deduped).
This is the exact data `reviewgate stats` precision already consumes. Loaded with
the existing `loadAuditWindow(repoRoot, { since, until })` (`src/stats/load.ts`)
— **both** `since` and `until` MUST be passed: `loadAuditWindow`/`collectFiles`
only takes the bounded `dayDirsInRange` day-dir scan when both are non-null;
with `since` alone it falls back to a `**/*.jsonl` scan of the ENTIRE audit tree
(then filters in memory), defeating the cost bound. So
`loadProviderPrecision` passes `since = now − windowDays` and `until = now`.

Precision per provider = `tp / (tp + fp)`, **INFO excluded** (non-blocking, needs
no decision — same rule as the stats metric), `declined` excluded entirely (it is
neither a true nor a false positive), `null` when `tp + fp === 0`. The
`minDecisions` sample floor (component 1) counts `tp + fp` only — `declined` does
not count toward having "enough history".

## Components

### 1. `src/core/provider-precision.ts` (new)

```ts
export interface ProviderPrecision {
  tp: number;
  fp: number;
  precision: number | null; // tp/(tp+fp); null when tp+fp === 0
}

// Pure aggregation: count tp/fp per base provider over the given decisions.
// INFO decisions are skipped (non-blocking). `declined` is ignored (neither tp
// nor fp). Mirrors the stats byProvider precision exactly.
export function perProviderPrecision(
  decisions: DecisionOutcome[],
): Map<string, ProviderPrecision>;

// Best-effort gate-time load: loadAuditWindow over [now − windowDays, now] — pass
// BOTH since AND until (computed from `now`/`windowDays` as ISO strings) so the
// bounded dayDirsInRange scan is used (passing only `since` scans the whole audit
// tree). Then aggregate. Returns an empty Map on ANY error (never throws — advisory).
export function loadProviderPrecision(
  repoRoot: string,
  opts: { windowDays: number; now: Date },
): Map<string, ProviderPrecision>;

// Attach `reviewer_precision` to each finding for its contributing base providers
// (normalizeProviders) that have >= minDecisions samples (tp+fp). Findings with no
// qualifying provider are returned unchanged. Pure / immutable (returns new array).
export function annotateFindingsWithPrecision(
  findings: Finding[],
  precision: Map<string, ProviderPrecision>,
  opts: { minDecisions: number },
): Finding[];
```

DRY: `perProviderPrecision` is the single definition of the per-provider tp/fp/
precision aggregation; `src/stats/aggregate.ts` is refactored to call it for its
`precision.byProvider` cell (the `overall`/`bySeverity` cells stay inline). The
output shape is identical to the existing `PrecisionCell` minus the `declined`
field, so the stats `byProvider` cells keep `declined` by counting it in the stats
loop and merging — see Implementation note below. Existing stats tests cover the
output, so the refactor is low-risk.

> Implementation note for DRY: rather than change `PrecisionCell`, `stats/aggregate.ts`
> keeps its existing `byProvider` loop for `declined`/severity bookkeeping but
> derives `tp`/`fp`/`precision` per provider from `perProviderPrecision` (a single
> pass), so the precision arithmetic lives in ONE place. If that coupling proves
> awkward in code, the acceptable fallback is to leave `stats/aggregate.ts`
> untouched and document the ~5-line duplication — correctness over DRY purity. The
> implementer chooses based on what reads cleanly; either way the gate path uses
> `perProviderPrecision`.

### 2. Schema — `src/schemas/finding.ts`

Add an optional annotation field (mirrors the existing `scope_demoted` /
`reputation_demoted` / `low_confidence` optionals — all post-hoc, all optional):

```ts
// #8: historical precision of the base provider(s) that raised this finding,
// attached at report-write time as ADVISORY context (never affects severity/
// verdict). Only providers with >= MIN_DECISIONS of decision history are listed.
reviewer_precision: z
  .array(
    z.object({
      provider: z.string(),
      tp: z.number().int().nonnegative(),
      fp: z.number().int().nonnegative(),
      precision: z.number().min(0).max(1).nullable(),
    }),
  )
  .optional(),
```

This is the INTERNAL `Finding` schema — **separate** from the codex-strict
`REVIEW_OUTPUT_SCHEMA` (`src/providers/review-output.ts`), so it does not touch
reviewer-output strict-mode validity.

### 3. Orchestrator wiring — `src/core/orchestrator.ts`

Between `aggregate()` (~line 1639) and `writeReport(... agg.dedupedFindings ...)`
(~line 1691), in **gate mode only** (`this.input.reportMode !== "one-shot"`), if
`phases.review.providerPrecisionContext` is enabled:

```ts
let reportFindings = agg.dedupedFindings;
if (this.input.reportMode !== "one-shot" && this.input.config.phases.review.providerPrecisionContext) {
  try {
    const precision = loadProviderPrecision(repo, { windowDays: PROVIDER_PRECISION_WINDOW_DAYS, now });
    reportFindings = annotateFindingsWithPrecision(reportFindings, precision, {
      minDecisions: PROVIDER_PRECISION_MIN_DECISIONS,
    });
  } catch (err) {
    console.warn(`[reviewgate] provider-precision annotation failed (non-fatal): ${String(err)}`);
  }
}
// ... writeReport(opts, start, settled, reportFindings, agg.verdict, agg.counts, ...)
```

- `now` is the orchestrator's existing `now` (a `Date`).
- **Cache safety:** `putCachedReview` stores only `{ verdict, counts }` (no
  findings), and a cache HIT writes empty findings — so the annotation is purely
  for the live report and can never be cached or re-served stale.
- The annotation runs ONLY on the fresh-aggregate panel path; all other
  `writeReport` call sites pass `[]`/synthetic findings (nothing to annotate).
- Constants live in `provider-precision.ts`: `PROVIDER_PRECISION_WINDOW_DAYS = 90`,
  `PROVIDER_PRECISION_MIN_DECISIONS = 5`.

### 4. Rendering — `src/core/report-writer.ts` `fmtFinding`

When `f.reviewer_precision` is present and non-empty, add ONE metadata line after
the `**Category:** … **Confidence:** …` line:

```
**Reviewer track record:** codex 88% (22 TP / 3 FP) · openrouter 41% (7 TP / 10 FP)
```

- Each entry: `<provider> <precision%> (<tp> TP / <fp> FP)`. A `null` precision
  (only when `tp+fp===0`, which `minDecisions ≥ 1` already excludes) renders as
  `n/a` defensively.
- **No new badge.** The reputation-demote badge (`📉 reviewer reputation low`)
  signals an actual demote; precision here is advisory data, so it stays a plain
  metadata line to avoid implying a suppression happened.
- Entries sorted by provider name for deterministic output.

### 5. Config — `src/config/define-config.ts` + `defaults.ts`

Add under `phases.review`:

```ts
// #8: annotate each finding in pending.md/json with the historical precision
// (tp/fp) of the provider(s) that raised it — ADVISORY context for the agent's
// accept/reject decision; never changes severity/verdict. Default on.
providerPrecisionContext: z.boolean().default(true),
```

`defaults.ts`: `providerPrecisionContext: true`. Window/min-decisions are module
constants (not config) — YAGNI; promote later if a repo needs to tune them.

## Behavior summary

- Fresh repo / no decision history → empty precision map → no annotation (silent).
- A provider with `< MIN_DECISIONS` (5) of history → omitted from the line (a
  1-decision "100%" is meaningless).
- Best-effort: any load/aggregate error → no annotation, never blocks the gate.
- Toggle off → no annotation, no audit load.
- Per-iteration recompute is correct: it picks up the prior iteration's freshly
  written decisions (their `ts` is in the past, so `until = now` keeps them).
- Cost is bounded by the 90-day window (≤ ~90 day-dir scans) — but ONLY because
  `loadProviderPrecision` passes BOTH `since` and `until` (see Data source);
  passing only one bound would scan the entire audit tree.

## Testing

Unit:
1. `perProviderPrecision`: tp/fp counted per provider across multi-provider
   decisions; INFO decisions excluded; `declined` ignored; `precision = tp/(tp+fp)`;
   `null` at zero samples.
2. `annotateFindingsWithPrecision`: attaches `reviewer_precision` only for a
   finding's contributing providers with ≥ `minDecisions`; a finding whose
   providers all lack history is unchanged; immutability (input not mutated).
3. `fmtFinding` (report-writer): renders the `Reviewer track record:` line when
   `reviewer_precision` is present; omits it otherwise; deterministic ordering.
4. Toggle/window: `providerPrecisionContext: false` → `annotateFindingsWithPrecision`
   not invoked (verify via orchestrator-level or a focused test that findings carry
   no `reviewer_precision`).
5. `loadProviderPrecision` best-effort: a missing/corrupt audit dir → empty Map (no
   throw).
6. If `stats/aggregate.ts` is refactored to reuse `perProviderPrecision`: the
   existing stats precision tests must stay green (byProvider unchanged output).

Plus: `bunx tsc --noEmit`, `bun run lint`, `bun test tests/unit --timeout 20000`
all clean.

## Files touched

- `src/core/provider-precision.ts` — new (aggregation + load + annotate + constants).
- `src/schemas/finding.ts` — new optional `reviewer_precision` field.
- `src/core/orchestrator.ts` — annotate `agg.dedupedFindings` before `writeReport` (gate mode, toggle-gated, best-effort).
- `src/core/report-writer.ts` — render the track-record line in `fmtFinding`.
- `src/config/define-config.ts` + `defaults.ts` — `providerPrecisionContext` toggle.
- `src/stats/aggregate.ts` — (optional DRY) reuse `perProviderPrecision` for `byProvider`.
- `tests/unit/` — new tests for the helpers + rendering.
