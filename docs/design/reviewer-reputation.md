# Design Proposal: Reviewer Reputation (signature-independent self-learning)

> Status: **proposal**, not yet planned/implemented. Written 2026-05-25 after the
> `reviewer-fp-streak` fix (PR #27). Honest scope below — this is the *next* step
> toward a gate that gets smarter on its own, not a claim that it already does.

## The problem this addresses

Today every false-positive / runaway defense is **signature-keyed** or
**single-iteration-scoped** (FP-ledger suppression, stuck-signatures, reject-rate).
A reviewer that is simply *unreliable* — producing confirmed-wrong findings that are
each phrased differently / located differently — is invisible to all of them, because
there is **no notion of "this reviewer, as a source, has been wrong a lot here."**

`reviewer-fp-streak` (PR #27) is the first cross-iteration, signature-independent
signal — but it only **escalates to the human**. It does not change how the gate
treats that reviewer next time. That is the gap: the gate doesn't *learn* a reviewer
is noisy; it just complains once and resets on re-arm.

## What "reputation" would add

A persisted, per-(provider, persona, repo) reliability score that the gate updates
from confirmed outcomes and then *uses* to weight that reviewer's findings.

### Signal (what updates the score)

Anchored to the same fabrication-proof source as `computeRejectRate` (real
`pending.json` finding ids → agent can't pad it):

- **confirmed false positive** (`reviewer_was_wrong: true` reject of a finding that
  reviewer raised) → reputation down.
- **confirmed true positive** (`accepted` + `action: fixed`) → reputation up.
- plain `rejected` without `reviewer_was_wrong` (design/won't-fix) → neutral.

Stored as a decaying count or a Beta(α,β)-style score so recent behavior dominates
and a reviewer can recover after it's fixed/swapped.

### Use (what the score changes) — escalating severity, all opt-in

1. **Demote-only weight (safe default).** Feed reputation into the aggregator's
   existing confidence/consensus weighting: a low-reputation reviewer's lone finding
   is demoted (CRITICAL→WARN→INFO) rather than blocking — it can still surface, but a
   chronically-wrong reviewer can no longer hard-block alone. Never *promotes* a
   finding (can't manufacture blocks), so it's safe.
2. **Quarantine threshold.** Below a floor, skip that reviewer for the rest of the
   cycle (like the quota-cooldown skip) and note it in the report — stops burning
   time/quota on a known-bad source. Auto-clears on re-arm or score recovery.
3. **Doctor surfacing.** `reviewgate doctor` shows per-reviewer reputation so the
   human sees "gemini-security: 2/14 confirmed correct here" and can disable/replace.

## Why not just reuse the FP-ledger

The FP-ledger answers "**is THIS finding** a known FP?" (signature-keyed, needs a
≥2-provider quorum so one reviewer can't silence a finding class). Reputation answers
a different question: "**is THIS reviewer** reliable *here*?" — which is intentionally
single-provider and signature-independent. They're complementary: the ledger suppresses
specific recurring findings; reputation down-weights an unreliable source.

## Anti-abuse (must preserve)

The agent authors the decisions files, and reputation could become an escape hatch
("mass-reject to quarantine all reviewers → trivial pass"). Guards:

- Only count decisions anchored to **real** finding ids (as `computeRejectRate` does).
- **Demote-only** (option 1) can never *open* the gate — worst case a finding drops a
  severity; a CRITICAL FP demoted to WARN still blocks under default policy.
- Quarantine (option 2) only *skips* a reviewer; the panel's remaining reviewers +
  the singleton-CRITICAL rule ([[reference_critical_single_reviewer]]) still gate. If
  quarantine would empty the panel, fail closed (don't pass un-reviewed).
- Reputation writes go through the locked, atomic state store; reset/decay on re-arm.

## Scope / cost

- New persisted artifact (`.reviewgate/reputation.json`) or a field in `state.json`
  scoped per cycle vs. per repo (open question: cross-cycle memory is the point, but
  needs a longer-lived store than `state.json`, which resets on session reset).
- No new external calls — it's bookkeeping over data the gate already has.
- Interacts with: aggregator weighting, quota-cooldown-style skip, doctor, and the
  `reviewer-fp-streak` escalation (reputation would make that escalation *actionable*
  automatically instead of human-only).

## Honest caveats

- This is **heuristic reliability tracking**, not "the gate understands code better."
  It makes the gate robust to a bad *reviewer*, which is real value, but it is not the
  grand "self-improving reviewer intelligence."
- Per-repo reputation needs enough samples to be meaningful; early in a repo it should
  default to neutral (no effect) to avoid penalizing a reviewer on 1–2 data points.
- Decay/recovery tuning is the hard part — too sticky punishes a fixed reviewer; too
  loose never accumulates signal.

## Suggested first slice (if approved)

Option 1 only (demote-only reputation weight), per-cycle, behind a config flag
default-off, with the same reproducing-test discipline as `reviewer-fp-streak`. Prove
it demotes a chronically-wrong reviewer's lone CRITICAL to non-blocking, then decide
whether to add quarantine + cross-cycle persistence.

Related: [[project_reviewer_fp_runaway_loop]], [[project_reviewer_fp_unchanged_code]].
