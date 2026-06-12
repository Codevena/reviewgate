# Design — Precision metric for `reviewgate stats`

Status: approved design (brainstorm 2026-06-11). Next step: implementation plan.

## Problem

The gate produces a lot of operational telemetry (`reviewgate stats`: verdict
distribution, escalation rate, cost, per-provider findings/demote-rate/error-rate,
top signatures, FP-ledger stages, brain status) — but it does **not** report the
one number that decides whether the gate is net-positive: **precision**, i.e. of
the findings that blocked and the human acted on, how many were real bugs that
got fixed vs. confirmed false positives that got overridden.

That signal exists in the raw data but is **not durable across sessions**:

- `decisions/<iter>.jsonl` records each disposition (`accepted`+`action`, or
  `rejected`+`reviewer_was_wrong`) — but it is session-local and wiped on
  reset/re-arm.
- `state.json` carries `cumulative_fp_rejects` — also session-local.

`reviewgate stats` reads the **audit log** (`loadAuditWindow` → `run.complete`
events carrying `RunSummary`), which captures severity counts, cost, providers,
`demoted` — but never the human decision outcome.

Without a precision number, every false-positive-suppression subsystem (FP-ledger,
reputation, critic, consensus) is tuned by vibe, and the OSS/website story
("catches N real bugs at P% precision") can't be told.

## Decisions (from brainstorm)

1. **Persist decisions durably via the audit log.** The `EventType` enum in
   `src/schemas/audit-event.ts` already declares a `decision.applied` value that
   is **never emitted** — a prepared-but-unwired stub. We wire it: emit one
   durable `decision.applied` audit event per decision, so precision can be
   computed over the existing `stats` window across sessions. (Alternatives —
   aggregating from `state.json` or reading the ephemeral `decisions/` dir — were
   rejected: both are session-local and cannot produce the cross-session window
   that `stats` is built around.)

2. **Three buckets, not two.** There are four decision outcomes; the two
   ambiguous ones get their own bucket and are reported separately, never folded
   into the precision formula:

   The `accepted` action is one of FOUR values in `DecisionEntrySchema`
   (`src/schemas/decision.ts`): `fixed`, `addressed-elsewhere`,
   `deferred-with-followup`, `acknowledged-low-value`. Full mapping:

   | Decision outcome | Bucket | Rationale |
   | --- | --- | --- |
   | `accepted` + `action:"fixed"` | **TP** | real finding, fixed |
   | `accepted` + `action:"addressed-elsewhere"` | **TP** | real finding, fixed in another place |
   | `rejected` + `reviewer_was_wrong:true` | **FP** | confirmed hallucination |
   | `accepted` + `action:"deferred-with-followup"` | **declined** | valid but not fixed now |
   | `accepted` + `action:"acknowledged-low-value"` | **declined** | valid but cosmetic, not worth fixing |
   | `rejected` + no `reviewer_was_wrong` | **declined** | rejected with reason, not flagged as reviewer error |

   **Precision = TP / (TP + FP)**, reported as `null` when `TP + FP == 0` (never
   disguise "no data" as 100%). The valid-but-declined count is surfaced
   alongside, but is in neither numerator nor denominator.

   Principle: **TP = the finding was real AND got fixed** (anywhere);
   **declined = the finding was valid but not fixed**; **FP = the reviewer was
   wrong.** (`addressed-elsewhere` → TP and `deferred-with-followup` → declined
   are the natural extension of this principle; confirm with the maintainer if a
   different split is wanted.)

3. **Scope = measurement only (YAGNI).** Visible only in `reviewgate stats`
   (text + `--json`). No inline display on every PASS, no dashboard, **no change
   to gate behavior or verdicts.**

## Architecture / Components

Data flow:

```
Agent writes decisions/<iter>.jsonl
   │
   ▼  loop-driver finalizes prevIter decisions (lastDecisionPerId — join already exists)
   │     ⟶ join against the iteration's pending.json snapshot ⟹ severity + provider(s) per finding_id
   ▼  NEW: emit one decision.applied audit event per decision (idempotent, append-only)
   │
   ▼  stats: loadAuditWindow collects decision.applied events in the window
   ▼  aggregate(): classify → TP / FP / valid-but-declined → precision (overall + by severity + by provider)
   ▼  renderStats(): new "Precision" section
```

### A. `src/schemas/audit-event.ts` — `decision_outcome` payload

Add an optional `decision_outcome` object to `AuditEventSchema` (the
`decision.applied` enum value already exists). Shape:

```ts
decision_outcome: z.object({
  finding_id: z.string(),                          // iteration-local, for debugging only — NOT a count/dedup key
  severity: z.enum(["CRITICAL", "WARN", "INFO"]),   // uppercase, matches src/schemas/finding.ts `Severity`
  bucket: z.enum(["tp", "fp", "declined"]),
  reviewer_was_wrong: z.boolean().optional(),
  providers: z.array(z.string()),                  // normalized, de-duped BASE provider ids (see Component B)
}).strict().optional()
```

- `bucket` is computed at emit time (the reader never re-derives classification).
- `severity` is uppercase to match the existing `Severity` enum — no case
  normalization at read time.
- `.strict()` on the nested object (the existing top-level `AuditEventSchema` is
  not strict; this change does not alter that).
- **`finding_id` is iteration-local and reused across cycles (`F-001` recurs);
  it is NEVER used as a count or dedup key in `stats` (see Component D). Each
  emitted event already represents exactly one finalized decision** (the emit
  watermark in Component B guarantees exactly-once), so `stats` counts events
  directly.

### B. `src/core/loop-driver.ts` — emit `decision.applied`

Add a **dedicated, single-purpose helper** in `loop-driver.ts` — e.g.
`emitDecisionOutcomes(prevIter)` — rather than overloading any of the several
existing folds (`priorAdjudications`, `priorIterationDecisionSignatures`, the
FP-ledger / reputation learners). It emits one `decision.applied` event per
finalized decision of `prevIter`:

- **Read decisions with the existing last-wins semantics.** Use the same
  last-valid-decision-per-`finding_id` read the gate already applies to
  `decisions/<prevIter>.jsonl`, so a superseded early line is never emitted —
  only the final disposition per finding.
- **Join against the `prevIter` `pending.json` snapshot** to resolve each
  decision's `severity` and raising providers. (The snapshot read + decision
  read both already exist; the helper composes them — it does not invent a new
  data source.)
- **Provider normalization (WARN 4).** A finding's raising providers are NOT a
  ready field. Collect from `reviewer.provider` (base) **and** each
  `members[].provider` (base); if any value is a `provider:persona` reviewer key
  (e.g. from `confirmed_by`), strip the persona suffix to the base provider.
  De-dup to a set of BASE provider ids. That set becomes `providers[]`.
- **Classify** into `tp` / `fp` / `declined` per the Decision-#2 table.
- **Emit timing (WARN 2).** Emit only **after the iteration's decisions-gate has
  passed** — i.e. once every blocking finding of `prevIter` is addressed and the
  gate is advancing/clean — never from `absorbPriorDecisions` before evaluation.
  At that point the `prevIter` decision lines are final.
- **Idempotency via a state watermark (CRITICAL 1).** `(run_id, iter,
  finding_id)` is NOT durable: `run_id` is `state.session_id`, `iteration`
  **resets to 0 on a clean PASS / commit re-arm**, and `finding_id` (`F-001`) is
  reused — so the triple collides across cycles. Instead, mirror the existing
  `fp_counted_through_iter` pattern: add a per-cycle watermark
  `decisions_emitted_through_iter` to `state.json` (see Component F). The helper
  emits decisions only for iterations strictly above the watermark, then advances
  it. A re-stop of the same iteration re-reads the watermark and emits nothing.
  The watermark resets with the cycle (re-arm), which is correct: a new cycle's
  `F-001` is a genuinely new decision and SHOULD be emitted as a distinct event.
  Counting stays correct because `stats` counts events, never dedups by
  `finding_id` (Component D).
- **Best-effort posture + crash ordering.** Own try/catch, `.catch`-wrapped like
  the existing `run.complete` emit — a logging failure must **never** change the
  verdict or block the gate. **Advance the watermark (state write) BEFORE
  appending the events**, giving **at-most-once** semantics: a crash between the
  two loses at most one iteration's decision events (rare under-count) but can
  **never double-count** — which is what preserves the "count events directly, no
  dedup" invariant in Component D. (At-most-once with a rare crash-loss is the
  correct failure mode for a measurement metric; inflation would be worse.)

### C. `src/stats/load.ts` — surface decision events

`loadAuditWindow` currently extracts only `run.complete` (`run_summary`) events
into `LoadedRun`. Extend it to also collect `decision.applied` events. Expose them
on `AuditWindow` (e.g. `decisions: DecisionOutcome[]`) without disturbing the
existing `runs` shape.

**Decision-window semantics — explicit, NOT 1:1 run-correlated.** Decisions for
iteration N are emitted after N's gate passes but *before* the next iteration's
`run.complete` is appended (see the emit point in Component B). So a decision and
the run it enabled are not cleanly co-indexed, and reusing the run-anchored
windowing naively would let a tight `--last 1` include run N+1 while excluding the
iter-N decision that enabled it. Define decision windowing by the **decision
event's own `ts`**, independently of run correlation:

- `--since T` → include `decision.applied` events with `ts >= T`.
- `--last N` → resolve the time span of the N selected runs (first selected run
  `ts`, keeping the existing −1-day guard, through the window end) and include
  decision events whose `ts` falls in that span.
- **Documented caveat:** precision is windowed by decision timestamp, not
  correlated one-to-one to the selected runs. At a tight `--last 1` boundary a
  decision and the run it enabled may land on opposite sides. This is acceptable
  and stated in the rendered note; precision is a rate over a time window, not a
  per-run figure.

**Both `aggregate()` call sites must be updated together (INFO 2):**
`src/cli/commands/stats.ts` AND `src/stats/weekly-assemble.ts` both call
`aggregate(...)`. Adding a `decisions` parameter must keep the weekly path
compiling and its existing output intact (the weekly report may surface precision
too, or simply pass the decisions through — but it must not break).

### D. `src/stats/aggregate.ts` — precision math

Extend `StatsReport` with a `precision` block:

```ts
precision: {
  overall: { tp: number; fp: number; declined: number; precision: number | null };
  bySeverity: { CRITICAL: {…}; WARN: {…} };      // INFO is non-blocking → excluded
  byProvider: Record<string, { tp; fp; declined; precision: number | null }>;
}
```

- **Count events directly — never dedup by `finding_id`.** Each
  `decision.applied` event is exactly one finalized decision (the Component-B
  watermark guarantees exactly-once emit). Overall counts = number of events per
  bucket. `finding_id` is iteration-local and reused across cycles, so deduping
  by it would wrongly collapse unrelated decisions across the window (this was the
  bug in the original draft).
- `precision = (tp + fp) === 0 ? null : tp / (tp + fp)`.
- CRITICAL precision is the headline; per-provider precision is the actionable
  signal (which reviewer is noisy). `INFO` excluded — non-blocking, no decision
  required.
- **Multi-provider findings:** when a decision's `providers[]` has >1 entry
  (consensus), the outcome is attributed to **each** base provider — a TP credits
  all who raised it, an FP debits all who confirmed it. The **overall** tally
  counts the event once (it's one decision); the **per-provider** tally counts it
  once per provider in `providers[]` (so one event can appear in two providers'
  rows). Intentional: per-provider precision measures each reviewer's own signal
  quality.

### E. `src/stats/render.ts` — "Precision" section

Render a "Precision" section: overall, a CRITICAL/WARN split, and a per-provider
line. `null` precision renders as `—` with a "no decisions recorded yet" note.
When a window is active, include a one-line caveat that precision is a rate over
the decision-time window, not a per-run figure (per Component C). The `--json`
output gets the new fields automatically (it serializes the report).

### F. `src/schemas/state.ts` — emit watermark

Add a per-cycle watermark field, mirroring the existing `fp_counted_through_iter`
guard:

```ts
decisions_emitted_through_iter: z.number().int().nonnegative().default(0),
```

- The Component-B helper emits decisions only for iterations strictly above this
  value, then advances it (state write) **before** appending the events.
- It resets with the cycle on a clean PASS / commit re-arm (same lifecycle as
  `fp_counted_through_iter` and the other per-cycle accumulators), which is
  correct: a new cycle's decisions are genuinely new and should be emitted afresh.
- `default(0)` keeps existing `state.json` files forward-compatible (no migration).

## Error handling & concurrency

- Emit is fully isolated (own try/catch, `.catch` on the async append) — it can
  never affect the verdict, mirroring the existing best-effort `run.complete`
  emit.
- Audit log is append-only. **Exactly-once emit is enforced by the per-cycle
  `decisions_emitted_through_iter` watermark (Component F), advanced before the
  append for at-most-once crash semantics — NOT by any `(run_id, iter,
  finding_id)` key** (that triple is non-durable: `run_id`=`session_id`,
  `iteration` resets on re-arm, `finding_id` is reused). `stats` therefore counts
  events directly and never dedups.
- `stats` is read-only over the audit window; malformed/old events are skipped by
  schema validation (the `decision_outcome` is optional, so pre-deployment events
  simply carry none).

## Edge cases

- **No decisions in window** → `precision: null`; section shows
  "— (no decisions recorded yet)".
- **Backfill:** historical runs predating this change have no `decision.applied`
  events. Precision builds up only from deployment forward — communicated
  honestly in the rendered note, never faked.
- **Reset/re-arm** keeps wiping `decisions/` — irrelevant now, the signal lives
  in the audit log.

## Testing

- Pure `aggregate()` unit tests: classification of **all six** decision outcomes
  (fixed, addressed-elsewhere, deferred-with-followup, acknowledged-low-value,
  rejected+wrong, rejected-without-wrong) into the three buckets; precision math;
  `null`-on-zero; severity split (uppercase keys, INFO excluded); per-provider
  split including a **multi-provider** event counted once overall but in two
  provider rows.
- Provider-normalization unit test: `reviewer.provider` + `members[].provider` +
  a `provider:persona` value collapse to a de-duped set of base provider ids.
- Emit + watermark test: finalizing iteration N writes exactly one correct
  `decision.applied` event per decision and advances
  `decisions_emitted_through_iter`; a **re-stop of the same iteration emits
  nothing** (watermark idempotency); after a re-arm (watermark reset) a new
  cycle's `F-001` decision IS emitted as a distinct event.
- Emit timing test: a superseded early decision line (overwritten by a last-wins
  line in the same iteration) is NOT emitted — only the final disposition.
- Schema test for the new `decision_outcome` payload (`.strict()`, uppercase
  severity).
- `loadAuditWindow` test: `decision.applied` events are collected and windowed by
  their own `ts` — `--since T` includes only `ts >= T`; `--last N` includes
  decisions in the selected runs' time span; an iter-N decision emitted just
  before run N+1 is windowed by decision time, not run index (the documented
  caveat). `weekly-assemble` still compiles and produces its existing output with
  the new `aggregate()` signature.

## Out of scope (YAGNI)

- Inline precision on every PASS / in the run summary.
- Any dashboard, weekly-report integration, or trend charts.
- Any change to gate behavior, verdicts, or suppression tuning (this change only
  *measures* — acting on the number is a separate, later decision).
- Backfilling precision from historical `decisions/` files (ephemeral, already
  wiped).
