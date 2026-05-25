# Reputation Slice A: Event-Pruning + Setup-Toggle — Design Spec

**Status:** approved 2026-05-25 (brainstorming). Next: implementation plan.

**Goal:** Two small, low-risk reputation follow-ups bundled into one slice, neither of
which changes the verdict logic:

1. **Event-pruning** — keep `.reviewgate/reputation.json` bounded by dropping events whose
   time-decayed weight is negligible (storage-only, no behavioral effect).
2. **Setup-wizard toggle** — surface `phases.reputation` in `reviewgate setup` as a simple
   on/off confirm, the way `fpLedger`/`brain` already are (Slice 1 deliberately skipped it).

**Non-goals:** any change to scoring, demotion, or verdict behavior; persona-granularity
(Slice B); quarantine (Slice C); exposing the tuning knobs (`minSamples`/`trustFloor`/
`halfLifeDays`) in the wizard.

Builds on `[[2026-05-25-reviewer-reputation-design]]` (Slice 1, shipped PR #29).
Related memory: `[[project_reviewer_reputation]]`.

---

## Item 1 — Event-Pruning (storage-only)

### What & why
`ReputationStore.record` appends `{ ts, eid }` events and never removes them, so
`reputation.json` grows unbounded over a repo's lifetime. The derived score already
time-decays each event (`weight = 0.5 ^ (ageDays / halfLifeDays)`), so events far past
the half-life contribute almost nothing. Dropping them on write keeps the file bounded
with **no behavioral effect**.

### Rule
- New constant `PRUNE_HALF_LIVES = 6` (weight at the horizon `0.5^6 ≈ 0.0156`).
- Horizon: `horizonMs = PRUNE_HALF_LIVES * halfLifeDays * 86_400_000`.
- An event is **dropped** iff its `ts` is parseable **and** `now - Date.parse(ts) >
  horizonMs`.
- An event is **kept** if `ts` is future-dated or unparseable — mirroring `decayedCount`
  in `score.ts`, which treats a non-finite / negative age as fresh (weight 1). Such events
  never age out (correct: a future ts stays "fresh"; an unparseable ts is an edge case we
  do not silently discard).

### Where
In `ReputationStore.record`, **after** merging the new events into their buckets and
**before** `writeAtomic`. Prune **both** the `correct` and `wrong` buckets of **every**
reviewer in the snapshot (not just touched ones) — the write already happens, so global
pruning is free hygiene and keeps the whole file bounded.

### Signature change
`record` needs `now` and `halfLifeDays`, which it does not currently receive. Thread them
through the existing caller chain rather than baking config into the store:

```ts
// store.ts
async record(
  events: RecordInput[],
  opts?: { now?: Date; halfLifeDays?: number },
): Promise<void>
```
- `opts.now` defaults to `new Date()`.
- `opts.halfLifeDays` defaults to the schema default (`45`) when omitted, so a bare
  `record(events)` call (e.g. existing tests) still prunes sanely.

`learnReputationFromDecisions` (`learn.ts`) already receives `nowIso`; add a `halfLifeDays`
field to its input and forward `{ now: new Date(nowIso), halfLifeDays }` to `record`. The
loop-driver caller (`loop-driver.ts:426`) passes
`this.i.config.phases.reputation.halfLifeDays`.

### Invariants
- **No behavioral effect:** only events with weight ≈0.0156 or less are removed; derived
  `trust`/`samples` change by a negligible amount.
- **No resurrection of a deduped event:** `record` de-dupes by `eid`. Re-applying an
  iteration's decisions (crash-retry / re-stop) happens within the same cycle, so those
  events are fresh — never past the 6× horizon — and pruning cannot drop then re-admit
  them.
- Writes still go through the existing `flock` + tmp+rename atomic path.

### Tests (extend `tests/unit/reputation-store.test.ts`)
- Old events (`ts` older than `6 * halfLifeDays`) are pruned on the next `record`; recent
  events survive.
- Future-dated and unparseable `ts` events are kept.
- Pruning one reviewer's write does not drop another reviewer's recent events.

---

## Item 2 — Setup-Wizard Toggle (enabled-only)

### What & why
Slice 1 shipped `phases.reputation` as a default-on, config-overridable feature **without**
a wizard prompt to keep the slice focused. `reviewgate setup` therefore can't toggle it.
This item adds an on/off confirm mirroring `fpLedger`/`brain` — **only `enabled`**; the
tuning knobs (`minSamples`/`trustFloor`/`halfLifeDays`) stay config-file-only.

### Changes (mirror the `fpLedger` pattern exactly)
- **`src/cli/setup/prefill.ts`:**
  - `WizardDefaults` gains `reputation: boolean`.
  - `RECOMMENDED_DEFAULTS.reputation = true` (matches the schema default-on).
  - `answersFromConfig` returns `reputation: Boolean(cfg.phases.reputation?.enabled)`.
- **`src/cli/setup/build-config.ts`:**
  - `CustomAnswers` gains `reputation: boolean`.
  - `buildCustomConfig` adds `phases.reputation = { enabled: a.reputation }`.
  - `buildQuickPreset` adds `reputation: { enabled: true }` to its `phases`.
- **`src/cli/commands/setup.ts` (`runCustom`):**
  - Add one `confirm` directly **after** the `fpLedger` confirm, **before** `contextDocs`:
    `confirm({ message: "Enable reviewer reputation (down-weight a chronically-wrong reviewer)?", initialValue: defaults.reputation })` with the usual `isCancel` guard.
  - Pass `reputation: Boolean(rep)` into the `buildCustomConfig({...})` call.

### Diff behavior
`enabled: true` equals the schema default, so `diffFromDefaults` strips it → enabling
produces **no** config line (correct — it's already the default). Only `enabled: false`
serializes as `reputation: { enabled: false }`. This keeps `--print` / written-config
output minimal and is what the shape tests must assert.

### Tests
- **`tests/unit/setup-prefill.test.ts`:** assert the new `reputation` field in both
  `RECOMMENDED_DEFAULTS` and `answersFromConfig` (true when `phases.reputation.enabled`,
  false when disabled).
- **`tests/unit/setup-build-config.test.ts`:** assert `buildQuickPreset` emits
  `phases.reputation.enabled === true` and `buildCustomConfig` emits
  `phases.reputation.enabled` reflecting the answer.
- Adjust any other config-shape assertion that breaks because the wizard now emits
  `phases.reputation` (e.g. `tests/unit/config-diff-serialize.test.ts` if it snapshots the
  full custom/quick output).

---

## Verification
TDD: write the failing test first for each item. Full suite green; `bunx tsc --noEmit` +
`bun run lint` clean. The known intermittent "compiled binary > doctor" test is unrelated —
re-run once if it flakes.

## File map
- **Modify:** `src/core/reputation/store.ts` (prune + `opts` arg), `src/core/reputation/learn.ts`
  (`halfLifeDays` input + forward), `src/core/loop-driver.ts` (pass `halfLifeDays`),
  `src/cli/setup/prefill.ts`, `src/cli/setup/build-config.ts`, `src/cli/commands/setup.ts`.
- **Tests:** `tests/unit/reputation-store.test.ts`, `tests/unit/setup-prefill.test.ts`,
  `tests/unit/setup-build-config.test.ts` (+ any other shape test that breaks).

Related: `[[2026-05-25-reviewer-reputation-design]]`, `[[project_reviewer_reputation]]`,
`[[project_reviewer_fp_runaway_loop]]`.
