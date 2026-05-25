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
    "<provider>": {
      correct: [ { ts: ISO, eid: string } ],  // confirmed-correct (accepted + action:fixed)
      wrong:   [ { ts: ISO, eid: string } ],  // confirmed-wrong (rejected + reviewer_was_wrong)
    }
  }
}
```

**Key = `provider`** (NOT `provider::persona`). Rationale (verified against the code): a
merged cross-provider finding's corroborating sources live in `finding.members[]`, which
carry `provider` but **NOT** `persona` (`src/schemas/finding.ts:55-62`); only the
representative has `reviewer.persona`. Persona-level reputation can't be reconstructed for
members, so Slice 1 tracks reputation per provider. (Persona granularity is a later
refinement that would require adding `persona` to `members`.)

**Event id (`eid`) for crash-safe idempotency:** each event carries a stable id
`${session_id}:${iter}:${finding_id}:${verdict}`. Recording is **idempotent** — an event
whose `eid` already exists is skipped. This removes the need for any `state.json`
"counted-through" marker (the earlier marker design was broken: `state.iteration` resets
to 0 on re-arm, so a high-water mark would never re-trigger in later cycles), and it is
crash-safe: re-applying an iteration's decisions after a crash mid-write de-dupes by `eid`
rather than double-counting. Events store a timestamp + eid only — the score is derived on
read, so decay needs no rewrite.

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
finding ids — exactly the fabrication-proof anchor `computeRejectRate` /
`learnFromDecisions` use. The `provider`(s) of each decided finding come from the finding
object in `pending.json` (panel-authored: `finding.reviewer.provider` + every
`finding.members[].provider`), **never** from agent-authored decision lines.

Per finding id that has a valid `DecisionEntry`, for **each distinct provider** that
contributed to that finding (representative + members, deduped per provider per finding —
mirroring `learnFromDecisions`):
- `verdict:"accepted"` with `action:"fixed"` → one **correct** event.
- `verdict:"rejected"` with `reviewer_was_wrong:true` → one **wrong** event.
- any other decision (rejected without `reviewer_was_wrong`, e.g. won't-fix) → **neutral**
  (no event).

**Update timing & idempotency:** updated once per iteration, at the decision-gate in
`LoopDriver.run()` — the same point where the `fp-streak` accumulator folds in iteration
`state.iteration`. Idempotency is by **`eid` dedup** in `reputation.json` (see §1), so
**no `state.json` marker is added** and a re-stop / crash-retry of the same iteration
cannot double-count. The `reputation.json` events are **per-repo and persistent** — NOT
reset on re-arm / clean PASS / commit; they only fade via time-decay.

## 3. Effect (in the aggregator)

The aggregator already demotes findings (diff-scoping demotes out-of-hunk findings to
INFO; the critic demotes). Reputation adds one more **demote-only** input, applied during
aggregation:

For a surviving finding, if **all** of these hold, demote it **one severity step**
(`CRITICAL→WARN`, `WARN→INFO`; INFO unchanged — **never dropped, never below INFO**):
1. reputation is enabled,
2. **the finding is NOT security/correctness** — `touchesSecurityOrCorrectness(f)` (the
   representative OR any merged member's category) must be false. This is a hard
   exemption: a security/correctness CRITICAL is **never** reputation-demoted, because
   the aggregator hard-FAILs those regardless of consensus (`aggregator.ts:339-343`) and
   suppressing a real security finding because "this reviewer is often noisy" is exactly
   the wrong trade. (This also shrinks the poisoning blast radius to non-security
   findings — see §4.)
3. the finding is **un-corroborated** — `consensus ∈ {singleton, minority}`. Verified
   against `computeConsensus` (`aggregator.ts:46-52`): a lone flag is `singleton` on a
   ≤2-reviewer panel and `minority` on a ≥3-reviewer panel; both mean "one reviewer's
   un-backed call". `unanimous`/`majority` (corroborated) are **never** reputation-demoted.
4. **every** contributing provider is **unreliable** (`samples >= minSamples && trust <
   trustFloor`). For an un-corroborated finding there is effectively one provider; the
   "every" guard ensures a finding that happens to list a reliable provider among members
   is not demoted.

Mark the demoted finding (`reputation_demoted: true` + a note in `details`, like the
existing `scope_demoted` / `low_confidence` flags) so `pending.md` and the audit show
*why*. A reputation-demoted finding still appears in the report; it just no longer
hard-blocks alone.

Interaction with existing rules (all verified in `aggregator.ts:337-360`): demotion runs
**before** the verdict tally. The security/correctness hard-FAIL is exempted (above). The
singleton-CRITICAL-on-a-1-reviewer-panel hard-FAIL rule
([[reference_critical_single_reviewer]]) then sees the already-demoted WARN — i.e. an
*unreliable* lone reviewer's NON-security CRITICAL becomes a lone WARN. Under
`softPassPolicy:"block"` that still blocks; under the default `"allow"` it soft-passes
(see §4 for why this is acceptable).

## 4. Anti-abuse: reputation poisoning (accepted risk + mitigations)

**Risk:** the agent authors the decisions, so it could repeatedly reject a reviewer's
*real* CRITICALs as `reviewer_was_wrong`, tank that reviewer's reputation, and thereby
get future *real* CRITICALs from it demoted to non-blocking — a persistent gate bypass.

**Honest blast radius:** under the **default `softPassPolicy:"allow"`**, a poisoned
reviewer's demoted lone CRITICAL→WARN yields SOFT-PASS → it **passes by default** (not only
under an explicitly permissive config). So poisoning *can* make a reviewer's future
**non-security** lone findings non-blocking. We accept this for Slice 1, bounded by:

- **Security/correctness is fully exempt** (§3 rule 2) — the highest-stakes findings can
  **never** be reputation-demoted, so poisoning cannot suppress a real security/correctness
  CRITICAL regardless of policy. This is the key bound.
- **Demote-only, one step, un-corroborated only, never below INFO** — a poisoned reviewer's
  non-security CRITICAL becomes at most a lone WARN (still blocks under `"block"` policy);
  corroborated findings are untouched.
- **Expensive & time-gated** — `trustFloor` over `minSamples` decayed events requires
  *sustained* confirmed-wrong rejections across cycles, not a one-off.
- **Leaves a trail** — every rejection wave still feeds the per-cycle `reject-rate` and
  cross-iteration `reviewer-fp-streak` escalations, so sustained mass-rejection surfaces to
  the human regardless.
- **`reviewer_was_wrong` is already a trusted channel** (that is how rejection works today);
  reputation only makes it persistent, while the existing backstops remain.

If field experience shows poisoning is a real problem, a later slice can require
corroboration to *lower* reputation, or refuse demotion under `"allow"` policy.

## 5. Config & default

Shipped default **ON** in `defaults.ts`. New config section under `phases` (alongside the
other learning subsystems `brain` / `fpLedger`):

```ts
phases.reputation = { enabled: true, minSamples: 8, trustFloor: 0.35, halfLifeDays: 45 }
```

Neutral-start (`minSamples`) guarantees **no runtime effect** without accumulated data
(no `reputation.json` → neutral → no demotion → no network, no verdict change), so
existing behavior tests are runtime-unaffected. **However**, adding a default-on
`phases.reputation` object changes the effective-config SHAPE, so config-shape / setup
snapshot tests (e.g. `tests/unit/config-fpledger.test.ts`, `tests/unit/setup-prefill.test.ts`)
**will need updating** — that's expected work in the plan, not a behavior regression.
`enabled:false` fully disables it.

## 6. Doctor surfacing

Extend `reviewgate doctor` with a `reviewer reputation` line (analogous to the new
`brain memory` line): per tracked reviewer, show `provider::persona N correct / M wrong
(trust 0.NN)` and flag `⚠ demoting` for any that are currently unreliable. Informational
(status ok), or `warn` when a reviewer is actively being demoted (so the human notices).

## 7. Testing

TDD, reproducing the real scenario first:
- **Demotes a lone non-security CRITICAL** from a below-floor reviewer → becomes WARN
  (verdict SOFT-PASS instead of FAIL).
- **NEVER demotes a security/correctness CRITICAL** even from a below-floor reviewer
  (hard exemption — verdict stays FAIL).
- **Does NOT demote a corroborated finding** (`unanimous`/`majority`) even if a contributing
  provider is unreliable.
- **Un-corroborated covers both** `singleton` (≤2-reviewer panel) and `minority`
  (≥3-reviewer panel) — a real lone flag in a 3-reviewer panel IS demotable.
- **Neutral-start:** below `minSamples`, no demotion (trust ignored).
- **Decay/recovery:** a reviewer with old wrong events + recent correct events climbs back
  above floor → no longer demoted.
- **Anti-abuse anchor:** reputation updates ignore decision lines for finding ids not in
  `pending.json` (no fabrication), and credit/debit every contributing `provider`.
- **`eid`-dedup idempotency:** re-applying the same iteration's decisions (re-stop /
  crash-retry) does not double-count.
- **Persistence:** reputation events survive a clean PASS / re-arm (NOT reset), unlike the
  fp-streak counter.
- **Score math (pure unit):** decay half-life, Beta smoothing, floor/min-samples boundaries.
- **Doctor line** renders per-provider counts + `⚠ demoting`.
- Full suite green; `bunx tsc --noEmit` + `bun run lint` clean.

## 8. File map

- Create: `src/schemas/reputation.ts` (zod schema), `src/core/reputation/store.ts`
  (locked atomic read/write + derived score + decay), `src/core/reputation/score.ts`
  (pure decay/trust math — unit-testable in isolation).
- Modify: `src/core/loop-driver.ts` (update reputation at the decision-gate via `eid`-dedup
  — no `state.json` marker, no re-arm reset), `src/core/aggregator.ts` (reputation
  demote-only pass before the verdict tally, with the security/correctness exemption +
  `consensus ∈ {singleton, minority}` guard, reusing `touchesSecurityOrCorrectness`),
  `src/config/defaults.ts` + `src/config/define-config.ts` (`phases.reputation` section),
  `src/cli/commands/doctor.ts` (reputation line). Update config-shape/setup tests for the
  new field.
- Tests: `tests/unit/reputation-score.test.ts`, `tests/unit/reputation-store.test.ts`,
  `tests/unit/aggregator-reputation.test.ts`, `tests/unit/loop-driver.test.ts` (update
  timing), `tests/unit/doctor-reputation.test.ts`.

Related: [[project_reviewer_fp_runaway_loop]], [[project_reviewer_fp_unchanged_code]],
[[reference_critical_single_reviewer]]. Supersedes the proposal in
`docs/design/reviewer-reputation.md` (which stays as the higher-level rationale).
