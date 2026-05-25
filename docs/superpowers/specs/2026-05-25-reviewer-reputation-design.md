# Reviewer Reputation (Slice 1: demote-only, per-repo) — Design Spec

**Status:** approved 2026-05-25 (brainstorming). Next: implementation plan.

**Goal:** Give the gate a persisted, per-repo sense of which reviewers are reliable
*here*, learned from confirmed outcomes, and use it to **demote** (never drop, never
block-open) the lone findings of a chronically-wrong reviewer. This is the first
mechanism that makes the gate get smarter on its own across sessions — instead of only
escalating a faulty reviewer to the human ([[project_reviewer_fp_runaway_loop]]).

**Non-goals (Slice 1):** reviewer quarantine/skip; cross-repo reputation; promoting
findings; learning *what* the code should be (that's the Brain). Demote-only.

---

## 1. Data model

New persisted artifact: `.reviewgate/reputation.json`, written atomically (tmp+rename)
under a `flock`, mirroring `BrainStore`/`StateStore`. Schema (zod, source of truth):

```
reviewgate.reputation.v1
{
  schema: "reviewgate.reputation.v1",
  reviewers: {
    "<provider>::<persona>": {
      correct: [ { ts: ISO } ],   // confirmed-correct events (accepted + action:fixed)
      wrong:   [ { ts: ISO } ],   // confirmed-wrong events (rejected + reviewer_was_wrong:true)
    }
  }
}
```

Key = `provider::persona` (a reviewer = a provider running a persona; the same provider
on a different persona is tracked separately). Events store only a timestamp — the score
is derived on read, so decay needs no rewrite.

**Derived score (on read):**
- Apply exponential time-decay to each event: `weight = 0.5 ^ (ageDays / halfLifeDays)`.
- `c = Σ weight(correct)`, `w = Σ weight(wrong)`, `samples = c + w`.
- `trust = (c + 1) / (c + w + 2)` (Beta(1,1) smoothing → neutral 0.5 at zero data, never
  hits 0/1 on small samples).
- A reviewer is **unreliable** iff `samples >= minSamples` **and** `trust < trustFloor`.

Old events past a horizon (e.g. `ageDays > 6 * halfLifeDays`, weight ≈ 0.016) are pruned
on write to keep the file bounded — purely a storage optimization, no behavioral effect.

## 2. Signal source (anti-abuse anchored)

Reputation is updated **only** from confirmed decisions bound to **real** `pending.json`
finding ids — exactly the fabrication-proof anchor `computeRejectRate` uses. The
`(provider, persona)` of each decided finding comes from the finding object in
`pending.json` (panel-authored), **never** from agent-authored decision lines.

Per finding id that has a valid `DecisionEntry`:
- `verdict:"accepted"` with `action:"fixed"` → one **correct** event for that finding's
  `(provider, persona)`.
- `verdict:"rejected"` with `reviewer_was_wrong:true` → one **wrong** event.
- any other decision (rejected without `reviewer_was_wrong`, e.g. won't-fix) → **neutral**
  (no event).

A finding merged across providers (the aggregator clusters cross-provider confirmations)
credits/debits **each** contributing `(provider, persona)` once (dedup per pair per
finding), mirroring `learnFromDecisions` in the FP-ledger.

**Update timing & idempotency:** updated once per iteration, at the decision-gate in
`LoopDriver.run()` — the same point where the `fp-streak` accumulator folds in iteration
`state.iteration`. Uses a **separate** `reputation_counted_through_iter` marker in
`state.json` (NOT the `fp_counted_through_iter` one): the fp-streak marker resets on
re-arm, but reputation is cross-cycle, so it must not be reset with it. The marker
guarantees a re-stop of the same iteration cannot double-count within a cycle; the
`reputation.json` events themselves are **per-repo and persistent** — **NOT** reset on
re-arm / clean PASS / commit. Reputation only fades via time-decay.

## 3. Effect (in the aggregator)

The aggregator already demotes findings (diff-scoping demotes out-of-hunk findings to
INFO; the critic demotes). Reputation adds one more **demote-only** input, applied during
aggregation:

For a surviving finding, if **all** of these hold, demote it **one severity step**
(`CRITICAL→WARN`, `WARN→INFO`; INFO unchanged — **never dropped, never below INFO**):
1. reputation is enabled,
2. the finding's consensus is **singleton** (this reviewer is its only source — a
   corroborated finding, `unanimous`/`majority`, is **never** reputation-demoted),
3. its sole `(provider, persona)` is **unreliable** (`samples >= minSamples && trust <
   trustFloor`).

Mark the demoted finding (e.g. `reputation_demoted: true` + a note in `details`) so
`pending.md` and the audit show *why* it was demoted. A reputation-demoted finding still
appears in the report; it just no longer hard-blocks alone.

Interaction with the singleton-CRITICAL rule
([[reference_critical_single_reviewer]]): that rule makes a **lone** CRITICAL a hard FAIL
when the panel collapsed to one reviewer. Reputation demotion runs **before** the verdict
tally, so a lone CRITICAL from an *unreliable* sole reviewer becomes a lone WARN — which
under `softPassPolicy:"block"` still blocks, and under `"allow"` soft-passes. This is the
intended, bounded effect.

## 4. Anti-abuse: reputation poisoning (accepted risk + mitigations)

**Risk:** the agent authors the decisions, so it could repeatedly reject a reviewer's
*real* CRITICALs as `reviewer_was_wrong`, tank that reviewer's reputation, and thereby
get future *real* CRITICALs from it demoted to non-blocking — a persistent gate bypass.

**Accepted for Slice 1, with layered mitigations:**
- **Demote-only, one step, lone-only, never below INFO, never corroborated** — a poisoned
  reviewer's CRITICAL becomes at most a lone WARN, which still blocks under
  `softPassPolicy:"block"`; corroborated findings are untouched.
- **Expensive & time-gated** — `trustFloor` requires *many* confirmed-wrong events,
  decayed over time, so poisoning takes sustained effort across cycles.
- **Leaves a trail** — every rejection wave still feeds the per-cycle `reject-rate` and
  cross-iteration `reviewer-fp-streak` escalations, so sustained mass-rejection surfaces
  to the human regardless.
- **`reviewer_was_wrong` is already a trusted channel** (that is how rejection works
  today); reputation only makes it persistent, while the existing backstops remain.

If field experience shows poisoning is a real problem, a later slice can require
corroboration to *lower* reputation, or cap reputation's effect under `"allow"` policy.

## 5. Config & default

Shipped default **ON** in `defaults.ts`. New config section under `phases` (alongside the
other learning subsystems `brain` / `fpLedger`):

```ts
phases.reputation = { enabled: true, minSamples: 8, trustFloor: 0.35, halfLifeDays: 45 }
```

Neutral-start (`minSamples`) guarantees **no effect** without accumulated data,
so the test suite and fresh repos are unaffected (no `reputation.json` → neutral → no
demotion → no network, no behavior change). `enabled:false` fully disables it.

## 6. Doctor surfacing

Extend `reviewgate doctor` with a `reviewer reputation` line (analogous to the new
`brain memory` line): per tracked reviewer, show `provider::persona N correct / M wrong
(trust 0.NN)` and flag `⚠ demoting` for any that are currently unreliable. Informational
(status ok), or `warn` when a reviewer is actively being demoted (so the human notices).

## 7. Testing

TDD, reproducing the real scenario first:
- **Demotes a lone CRITICAL** from a reviewer whose `reputation.json` is below floor →
  becomes WARN (verdict SOFT-PASS instead of FAIL).
- **Does NOT demote a corroborated CRITICAL** (≥2 reviewers) even if one is unreliable.
- **Neutral-start:** below `minSamples`, no demotion (trust ignored).
- **Decay/recovery:** a reviewer with old wrong events + recent correct events climbs back
  above floor → no longer demoted.
- **Anti-abuse anchor:** reputation updates ignore decision lines for finding ids not in
  `pending.json` (no fabrication), and credit the correct `(provider, persona)`.
- **Persistence:** reputation survives a clean PASS / re-arm (NOT reset), unlike fp-streak.
- **Doctor line** renders counts + `⚠ demoting`.
- Full suite green; `bunx tsc --noEmit` + `bun run lint` clean.

## 8. File map

- Create: `src/schemas/reputation.ts` (zod schema), `src/core/reputation/store.ts`
  (locked atomic read/write + derived score + decay), `src/core/reputation/score.ts`
  (pure decay/trust math — unit-testable in isolation).
- Modify: `src/core/loop-driver.ts` (update reputation at the decision-gate, no re-arm
  reset), `src/core/aggregator.ts` (reputation demote-only pass, before the verdict
  tally), `src/schemas/state.ts` (`reputation_counted_through_iter` marker, default 0,
  NOT reset on re-arm), `src/config/defaults.ts` + `src/config/define-config.ts`
  (`phases.reputation` section), `src/cli/commands/doctor.ts` (reputation line).
- Tests: `tests/unit/reputation-score.test.ts`, `tests/unit/reputation-store.test.ts`,
  `tests/unit/aggregator-reputation.test.ts`, `tests/unit/loop-driver.test.ts` (update
  timing), `tests/unit/doctor-reputation.test.ts`.

Related: [[project_reviewer_fp_runaway_loop]], [[project_reviewer_fp_unchanged_code]],
[[reference_critical_single_reviewer]]. Supersedes the proposal in
`docs/design/reviewer-reputation.md` (which stays as the higher-level rationale).
