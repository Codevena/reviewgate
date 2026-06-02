# Implicit-Outcomes Signal Pipe (P0 Self-Improving) — Design

**Status:** Approved (2026-06-02). Slice 1 of the self-improving roadmap
(`audit.md` Part 6 §4.1 + §4.5).

## Problem

Today the largest available learning signal is discarded. A finding the
aggregator **demotes** (out-of-diff `scope_demoted`, `fp_ledger_match`,
`low_confidence`, `reputation_demoted`, critic `likely_fp`) or **drops**
(critic `likely_fp` on an INFO finding → removed entirely) requires **no agent
decision** — the decisions-gate only tracks CRITICAL/WARN. So neither the FP
ledger nor reputation (both read `decisions/<iter>.jsonl`) ever learns from the
*majority* of reviewer hallucinations: the ones the pipeline already softened.
The downstream learners (FP ledger, reputation, the future risk model and
FP-prediction) all read from a join fed only by the small slice of findings that
reach an explicit human decision.

## Goal

Capture every demoted/dropped finding outcome as a **write-only** learning-signal
corpus and surface it in `reviewgate learn status`. This is the data pipe later
slices consume — it does **not** change any verdict or reviewer behavior.

**Non-goals (later slices, explicitly out of scope here):**
- Feeding these outcomes into reputation / verdict (P1+, behind a flag, after the
  corpus is validated).
- Risk-model or FP-prediction consumption (those *read* this corpus later).

## Decisions (from brainstorming)

- **Scope:** pure signal capture + observability. No verdict/behavior change.
- **Activation:** a config flag `phases.implicitOutcomes`, **default ON**.
- **Retention:** bounded — prune-at-write to `cap` lines (oldest-drop), default
  `cap: 5000` (mirrors the fp-ledger candidate pruning pattern).

## Architecture

Additive, file-based, no new runtime deps. One new schema, one new core module,
a small aggregator return-shape extension, one orchestrator wire-in point, one
config key, and a `learn status` render addition.

```
runIteration() ── aggregate() ──► AggregateResult { …, criticDropped: Finding[] }
        │
        ▼  (after verdict computed; best-effort, non-blocking)
  if phases.implicitOutcomes.enabled:
    derive ImplicitOutcome[] from demoted survivors + criticDropped
        │
        ▼
  appendImplicitOutcomes(repoRoot, outcomes, cap)   ── flock + atomic + prune
        │
        ▼
  .reviewgate/learnings/implicit-outcomes.jsonl     ── read by `learn status`
```

### Components

**1. `src/schemas/implicit-outcome.ts`** — zod schema, source of truth for one
NDJSON record:
```ts
ImplicitOutcomeSchema = {
  schema: "reviewgate.implicit_outcome.v1",
  signature: string,
  reviewer_key: string,   // `${provider}:${persona}` of the representative reviewer
  category: string,
  demote_reason: "scope_demoted" | "fp_ledger_match" | "low_confidence"
               | "reputation_demoted" | "critic_likely_fp" | "critic_dropped",
  run_id: string,         // the iteration run id (orchestrator runId)
  iter: number,           // 1-based iteration
  created_at: string,     // ISO; passed in (no Date.now() in pure code paths)
}
```

**2. `src/core/learnings/implicit-outcomes.ts`** + `implicitOutcomesPath(repoRoot)`
in `src/utils/paths.ts` (`.reviewgate/learnings/implicit-outcomes.jsonl`):
- `appendImplicitOutcomes(repoRoot, outcomes: ImplicitOutcome[], cap: number): void`
  — under `flock`, read existing lines, append the new ones, if total > cap drop
  the OLDEST (head) so length ≤ cap, write atomically via `writeFileAtomic`
  (tmp+rename). No-op on empty `outcomes`. Each line validated by the schema
  before write (skip malformed-on-read defensively).
- `loadImplicitOutcomes(repoRoot): ImplicitOutcome[]` — parse + schema-filter the
  NDJSON (tolerant: skip unparseable/invalid lines), for `learn status`.

**3. `src/core/aggregator.ts`** — extend `AggregateResult` with
`criticDropped: Finding[]` (the findings removed at the `INFO → drop` branch).
`criticDroppedCount` is derived (`criticDropped.length`) — the existing standalone
counter is replaced by this array to make the dropped findings attributable.
Update the single existing `demoted` computation in the orchestrator accordingly
(`agg.criticDropped.length`).

**4. `src/core/orchestrator.ts`** — after `aggregate()` (the existing `demoted`
computation site, ~line 1150) and gated on `phases.implicitOutcomes?.enabled`:
map to `ImplicitOutcome[]`:
- For each `f` in `agg.dedupedFindings` carrying a demote tag, emit one outcome
  with the matching `demote_reason` (priority if multiple tags: `critic_likely_fp`
  > `scope_demoted` > `fp_ledger_match` > `reputation_demoted` > `low_confidence`).
- For each `f` in `agg.criticDropped`, emit `demote_reason: "critic_dropped"`.
- `reviewer_key = f.reviewer.provider + ":" + f.reviewer.persona`; `signature`,
  `category` from `f`; `run_id`/`iter` from the iteration; `created_at` = ISO now
  (stamped at the call site, not inside pure code).
Wrap the whole block in `try/catch` → on any error `console.warn` and continue.
**The verdict and report are computed and written exactly as before**; this is a
pure side-write after them.

**5. `src/cli/commands/learn-status.ts`** — add an "Implicit outcomes" section:
total count + a breakdown by `demote_reason` and the top reviewer_keys, read via
`loadImplicitOutcomes`. Empty/absent file → a "none yet" line (no error).

**6. Config** — `src/config/define-config.ts`: add
`implicitOutcomes: z.object({ enabled: z.boolean(), cap: z.number().int().positive() }).nullable().default(null).optional()`
under `phases`; `src/config/defaults.ts`: `implicitOutcomes: { enabled: true, cap: 5000 }`.
(Consistent with the cache key hashing the full config; toggling it invalidates
the review cache, which is acceptable since it is rare.)

## Error handling

- The append is **best-effort and non-blocking**: any failure (flock contention
  timeout, disk error, schema mismatch) is caught, `console.warn`-logged, and the
  gate proceeds unchanged. It can never fail a review or alter a verdict.
- `flock` serializes concurrent gate runs writing the same file.
- Atomic write (`writeFileAtomic`) means a crash never leaves a truncated JSONL.
- Reader is tolerant: malformed/old-schema lines are skipped, not fatal.

## Testing

All TDD-first; tsc + biome clean; full `bun test` after.

1. **Schema** (`tests/unit/implicit-outcome-schema.test.ts`): accepts a valid
   record; rejects an unknown `demote_reason`; rejects a missing required field.
2. **Writer** (`tests/unit/implicit-outcomes-store.test.ts`): two appends → two
   lines; prune-at-cap drops the OLDEST and keeps length == cap; empty input is a
   no-op; written lines re-load + validate.
3. **Aggregator** (`tests/unit/aggregator-critic.test.ts`, extend): a dropped INFO
   likely_fp appears in `agg.criticDropped` (and `criticDroppedCount` ==
   `criticDropped.length`).
4. **Orchestrator wire-in** (`tests/unit/orchestrator-panel.test.ts` or new
   `orchestrator-implicit-outcomes.test.ts`): a run producing a demoted finding
   (e.g. out-of-diff `scope_demoted`) + a critic-dropped finding writes the
   correct outcome lines with right `demote_reason`/`reviewer_key`; and the
   verdict + pending.json are byte-identical to the same run with
   `implicitOutcomes.enabled = false` (proves no behavior change).
5. **learn status** (extend its test): renders the implicit-outcomes section from
   a seeded JSONL; renders "none yet" when absent.
6. **Config** (`tests/unit/config-*.test.ts`): default is `{enabled:true,cap:5000}`;
   an override is honored.

## Files

- Create: `src/schemas/implicit-outcome.ts`, `src/core/learnings/implicit-outcomes.ts`,
  `tests/unit/implicit-outcome-schema.test.ts`,
  `tests/unit/implicit-outcomes-store.test.ts`,
  `tests/unit/orchestrator-implicit-outcomes.test.ts`
- Modify: `src/utils/paths.ts` (+`implicitOutcomesPath`), `src/core/aggregator.ts`
  (+`criticDropped`), `src/core/orchestrator.ts` (wire-in + `demoted` source),
  `src/cli/commands/learn-status.ts` (render), `src/config/define-config.ts`,
  `src/config/defaults.ts`, and the existing aggregator/learn-status tests.
