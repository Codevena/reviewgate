# Reputation Slice A: Event-Pruning + Setup-Toggle — Design Spec

**Status:** approved 2026-05-25 (brainstorming). Next: implementation plan.

**Goal:** Two small, low-risk reputation follow-ups bundled into one slice, neither of
which changes the scoring/demotion algorithm:

1. **Event-pruning** — keep `.reviewgate/reputation.json` bounded by dropping events whose
   time-decayed weight is negligible. Effect on the derived score is **negligible and
   bounded** (quantified in *Invariants*), not literally zero — both buckets prune
   proportionally so `trust` stays near-invariant.
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
with **negligible** behavioral effect (quantified under *Invariants* below — not literally
zero, but bounded and immaterial to the unreliable/reliable classification).

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

`learnReputationFromDecisions` (`learn.ts`) already receives `nowIso`; add an **optional**
`halfLifeDays?: number` field to its input and forward `{ now: new Date(nowIso),
halfLifeDays }` to `record`. Optional (not required) so the existing call sites in
`tests/unit/reputation-learn.test.ts` (3 calls) keep typechecking; when omitted, `record`'s
own `45` default applies. The loop-driver caller (`loop-driver.ts:426`) passes
`this.i.config.phases.reputation.halfLifeDays` (always present — `phases.reputation` has a
zod `.default(...)`).

### Invariants
- **Negligible behavioral effect (quantified):** each pruned event weighs ≤0.0156. The
  pruned tail is geometric: integrating a steady event rate beyond the 6× horizon yields
  a decayed mass ≈ `rate · halfLifeDays · 0.0225` — for ~1 event/day this is ≈1 decayed
  sample against a kept mass of ≈64, i.e. **~1.5%** of total. Crucially, **both** the
  `correct` and `wrong` buckets prune proportionally, so the `trust` ratio
  `(c+1)/(c+w+2)` is near-invariant; only `samples` shifts slightly. A reviewer whose
  events are so sparse that the pruned tail could push `samples` below `minSamples` is by
  definition mostly inactive over >6 half-lives (>270d) and *should* drift toward the
  neutral default — pruning does not misclassify an active reviewer.
- **No double-count of a logical decision (code-enforced by the `eid` namespace):**
  `record` de-dupes by `eid` against the bucket *before* pruning. The theoretical ordering
  hole — an incoming duplicate of a beyond-horizon stored event is skipped, that event is
  pruned, then a later replay of the *same* `eid` is re-admitted — **cannot occur**, because
  the `eid`'s `session_id` component is a **ULID minted per state-initialisation**
  (`gate.ts:99` → `loadOrRecover(ulid())`; a fresh ULID on every SessionStart reset /
  corruption-recovery). A ULID embeds a millisecond timestamp + 80 random bits, so an `eid`
  from a long-dead session is **never reproducible** in a future session — there is no
  expiry guard to add because the namespace itself makes cross-session collision
  cryptographically impossible. The *only* way the same full `eid` recurs is an immediate
  in-session crash-retry / re-stop (same ULID + monotonic `cycle_seq` + `iter`), where the
  original event is minutes-to-hours old — far inside the 270-day horizon, hence still
  present for dedup and never pruned. Dedup-before-prune is therefore safe; no reordering
  needed. (Even in the impossible cross-session case the re-admitted event would carry a
  fresh `ts` and represent a genuinely new review cycle's decision — i.e. correct to count,
  not a stale double-count.)
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
`enabled: true` equals the schema default (`defaultConfig.phases.reputation` is already
`{ enabled: true, … }`), so `diffFromDefaults` strips it → enabling produces **no** config
line (correct — it's already the default). Only `enabled: false` serializes as
`reputation: { enabled: false }`. **Note this DIFFERS from `fpLedger`**, whose schema
default is `null`/off, so *its* `enabled:true` is NOT stripped. The shape tests must
therefore assert reputation's *own* behavior (enabled→stripped, disabled→one line), not
reuse the fpLedger "default-on" assertion as a proxy.

### Tests
- **`tests/unit/setup-prefill.test.ts`:** assert the new `reputation` field in both
  `RECOMMENDED_DEFAULTS` and `answersFromConfig` (true when `phases.reputation.enabled`,
  false when disabled).
- **`tests/unit/setup-build-config.test.ts`:** assert `buildQuickPreset` and
  `buildCustomConfig` emit `phases.reputation.enabled` **on the returned partial**
  (reflecting the answer) — assert the raw partial, NOT a `defineConfig`-normalized config,
  because `defineConfig({})` already enables reputation by default and would mask a missing
  emit.
- **`tests/unit/config-diff-serialize.test.ts`:** add a reputation-specific case —
  `enabled:true` is stripped (no line), `enabled:false` serializes one line. Do not rely on
  the fpLedger assertion as a proxy (different default; see *Diff behavior*).

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
  `tests/unit/setup-build-config.test.ts`, `tests/unit/config-diff-serialize.test.ts`.
  Also verify `tests/unit/reputation-learn.test.ts` still typechecks/passes (3 existing
  `learnReputationFromDecisions` call sites — the `halfLifeDays` input is optional so they
  need no change; optionally add a case asserting `halfLifeDays` is forwarded to `record`).

Related: `[[2026-05-25-reviewer-reputation-design]]`, `[[project_reviewer_reputation]]`,
`[[project_reviewer_fp_runaway_loop]]`.
