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

   | Decision outcome | Bucket |
   | --- | --- |
   | `accepted` + `action:"fixed"` | **TP** (true positive) |
   | `rejected` + `reviewer_was_wrong:true` | **FP** (false positive) |
   | `accepted` + `action:"acknowledged-low-value"` | **valid-but-declined** |
   | `rejected` + no `reviewer_was_wrong` | **valid-but-declined** |

   **Precision = TP / (TP + FP)**, reported as `null` when `TP + FP == 0` (never
   disguise "no data" as 100%). The valid-but-declined count is surfaced
   alongside, but is in neither numerator nor denominator.

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
  finding_id: z.string(),
  severity: z.enum(["critical", "warn", "info"]),
  bucket: z.enum(["tp", "fp", "declined"]),
  reviewer_was_wrong: z.boolean().optional(),
  providers: z.array(z.string()), // provider(s) that raised the finding
}).optional()
```

`bucket` is computed at emit time (so the reader never re-derives classification).
`providers` comes from the finding snapshot, enabling per-provider precision.

### B. `src/core/loop-driver.ts` — emit `decision.applied`

At the point where the previous iteration's decisions are finalized and joined
against the `pending.json` snapshot (the existing `lastDecisionPerId(prevIter)` /
N4-join site), emit one `decision.applied` event per decision:

- Map `finding_id` → severity + provider(s) via the pending snapshot (machinery
  already present).
- Classify into `tp` / `fp` / `declined` per the table above.
- **Idempotency:** key on `(run_id, iter, finding_id)`. A finding re-reviewed in
  a later iteration (new id) is a new decision; the *same* `(run_id, iter,
  finding_id)` must never be emitted twice. Guard at the emit site so a re-run of
  the same iteration's finalization does not double-count.
- **Best-effort posture:** own try/catch, `.catch`-wrapped like the existing
  `run.complete` emit — a logging failure must **never** change the verdict or
  block the gate.

### C. `src/stats/load.ts` — surface decision events

`loadAuditWindow` currently extracts only `run.complete` (`run_summary`) events
into `LoadedRun`. Extend it to also collect `decision.applied` events within the
same window (same `*.jsonl` scan, same `--since`/`--last` window logic). Expose
them on `AuditWindow` (e.g. `decisions: DecisionOutcome[]`) without disturbing the
existing `runs` shape.

### D. `src/stats/aggregate.ts` — precision math

Extend `StatsReport` with a `precision` block:

```ts
precision: {
  overall: { tp: number; fp: number; declined: number; precision: number | null };
  bySeverity: { critical: {…}; warn: {…} };      // info findings are non-blocking → excluded
  byProvider: Record<string, { tp; fp; declined; precision: number | null }>;
}
```

- Count buckets from the window's `decision.applied` events.
- `precision = (tp + fp) === 0 ? null : tp / (tp + fp)`.
- CRITICAL precision is the headline; per-provider precision is the actionable
  signal (which reviewer is noisy). `info` excluded — non-blocking, no decision
  required.
- **Multi-provider findings:** when a finding was raised by >1 provider
  (consensus), the outcome is attributed to **each** provider in `providers[]` —
  a TP credits all who raised it, an FP debits all who confirmed it. Overall
  counts dedup per `finding_id` (each decision counts once); per-provider counts
  do not (a finding can appear in two providers' tallies). This is intentional:
  per-provider precision measures each reviewer's own signal quality.

### E. `src/stats/render.ts` — "Precision" section

Render a "Precision" section: overall, a CRITICAL/WARN split, and a per-provider
line. `null` precision renders as `—` with a "no decisions recorded yet" note.
The `--json` output gets the new fields automatically (it serializes the report).

## Error handling & concurrency

- Emit is fully isolated (own try/catch, `.catch` on the async append) — it can
  never affect the verdict, mirroring the existing best-effort `run.complete`
  emit.
- Audit log is append-only; idempotency is enforced by the `(run_id, iter,
  finding_id)` key at the emit site, not by post-hoc dedup in `stats`.
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

- Pure `aggregate()` unit tests: classification of all four decision outcomes
  into the three buckets, precision math, `null`-on-zero, severity split, provider
  split.
- Emit test: a single decision-finalization writes exactly one correct
  `decision.applied` event; idempotency — re-running the same iteration's
  finalization does not double-count.
- Schema test for the new `decision_outcome` payload (strict shape).
- `loadAuditWindow` test: `decision.applied` events are collected within the
  window and respect `--since`/`--last`.

## Out of scope (YAGNI)

- Inline precision on every PASS / in the run summary.
- Any dashboard, weekly-report integration, or trend charts.
- Any change to gate behavior, verdicts, or suppression tuning (this change only
  *measures* — acting on the number is a separate, later decision).
- Backfilling precision from historical `decisions/` files (ephemeral, already
  wiped).
