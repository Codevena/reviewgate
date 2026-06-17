# Non-Convergence Remediation — location-keyed guards & severity floor

**Date:** 2026-06-17
**Source:** flashbuddy field report #2 ("non-convergence on a 5-line change"): the gate ran 5
iterations / 0 real defects because the reviewer (claude-code, 78-82% TP) raised
**contradictory findings on the SAME file:line across iterations**, each with a *different*
rule_id/signature, each fix re-triggering the prior. 3 smoking guns, all one root cause.

## Root cause (cross-cutting)

**Every cross-iteration guard is SIGNATURE-keyed; re-litigating the same LOCATION with a fresh
signature defeats them all AND fools the convergence accounting.**
- `cycleRejected` / `claimedFixed` (aggregator), `signature-recurrence` (#5), `stuck-signatures`
  — all keyed on `f.signature` → 4 distinct signatures on the same line → none fires.
- `churnProgressing` (loop-driver.ts:880, `recurring < prevReal`) credits "different signatures
  than last round" as **progress** → a churning reviewer reads as healthy convergence → the loop
  runs soft-cap(2) → hard-cap(4) for a ≤30-line diff (the "4/3 without escalate").
- The ONE location-aware piece — `priorAdjudications` (adjudications.ts) — already joins
  decisions↔pending.json file:line and injects an advisory prompt ("do NOT argue the OPPOSITE of
  a prior disposition"), BUT it is (a) a **1-iteration window** and (b) **advisory-only** (no
  deterministic flag, no escalation) → the reviewer ignored it.

## G0 — shared primitive (build FIRST)

- **State field** `adjudicated_location_history` — one row per non-passing reviewed iteration,
  **index-aligned with `signature_history`**, each row = the `{file, line_start, line_end,
  finding_id, verdict:'addressed'|'rejected'}` regions from joining that iter's
  `decisions/<iter>.jsonl` to **that iter's** pending.json. `.default([])` (back-compat).
- **Region-extraction helper** factored from the `priorAdjudications` join. **Correctness bug to
  fix:** `priorAdjudications` reads the *current* pending.json; the accumulator must snapshot
  each iter's regions AT that iter (append-per-iter), never re-derive old iters from the current
  pending.
- **Bucket-tolerant region key** (reuse `signature.ts` lineBucket ~10) so a few-line drift across
  edits still matches the same logical region.
- **Accumulate** the just-run iter's regions in the non-passing `state.update` (index-aligned
  with `signature_history`); **reset to `[]`** at every point `cycle_rejected_signatures` resets
  (re-arm). Reader follows the never-throw → `[]` contract.

## Slices

| # | Slice | Reporter ask | Type | Dep | Effort |
|---|---|---|---|---|---|
| **G3** | Hypothetical/future-marker CRITICAL→WARN demote | #2 severity floor | demote-only (1 step) | none | M |
| **G0** | Shared `adjudicated_location_history` primitive | — | state + helper | none | M |
| **G2** | Location-recurrence escalation + `churnProgressing` subset-fix | #2 hardstop | escalation + accounting | G0 | M |
| **G1** | Contradiction flag + escalate-on-undo-accepted-fix | #1 (top) | flag + escalation | G0 | M |
| **G3b** | Stable-Code-Guard (advisory) | #2 bonus | render-only flag | G0 | L (deferred) |

**Sequencing:** G3 (independent, ships first — relieves the treadmill *for free*: CRITICAL→WARN
means the inflated finding no longer hard-FAILs unconditionally) → G0 → G2 → G1 → G3b (deferred).

### G3 — Hypothetical-severity demote
New `src/core/hypothetical-demote.ts`, called after `demoteSelfRefuting`, before `groundFindings`
(mirrors `grounding.ts`). Demote CRITICAL→WARN **one step** (never drop, never INFO) when:
(a) severity CRITICAL, (b) a POSITIVE forward/hypothetical marker matches message+details+
suggested_fix ("currently safe/fine", "no current issue", "hypothetical", "if a future change",
"could become", "would break if", "in the future", "down the line"), AND (c) NO present-defect
backstop marker ("currently broken/fails/crashes/leaks/vulnerable", "right now", "already
wrong/failing", "as written … breaks"). **EXEMPT security/correctness** (untrusted prose; an
injected reviewer could append "currently safe" to a real vuln — the codebase never softens the
hard-veto categories on a text signal). Flag `hypothetical_demoted`, badge, config
`phases.review.hypotheticalSeverityGuard` (default true). Distinct from self-refutation (verified:
its if/would/could guard rejects forward-looking text). The literal F-005 (testing/afterEach,
"currently safe") is exactly this.

### G2 — Location-recurrence escalation + churnProgressing fix
- New `src/core/location-recurrence.ts` mirroring `signature-recurrence.ts`:
  `recurringBlockingLocations(history, blockingLocations, threshold)` → regions present in EVERY
  one of the last `threshold` rows. New `EscalationReason 'location-recurrence'`, wired right
  after signature-recurrence; threshold `max(loop.maxLocationRecurrence, stuckThreshold+1)` (knob
  default 3, 0=disable, clamped > stuckThreshold **in code**, not a zod refine). Off-ramp grace
  (exclude just-rejected), `deferableOnQuota=true`, block-once, **never suppresses**.
- **Fix `churnProgressing`** (loop-driver.ts:880): credit churn as progress only if ≥1 current
  blocking finding sits on a region **NOT** in any prior adjudicated row (genuinely new location).
  If every current finding is on an already-adjudicated region → it's a treadmill, not approach-
  switching → no progress credit → the soft-cap escalate fires at the **soft** cap with the right
  diagnosis. **Key on region-was-ADJUDICATED (had a decision), never merely-touched.**

### G1 — Contradiction flag + escalate-on-undo
New `src/core/adjudication-overlap.ts`: `flagContradictions(findings, adjudicatedLocations,
currentIter)` — a finding overlapping an earlier-iter adjudicated region gets
`contradicts_adjudication:{iter,finding_id,prior_verdict}` (badge: "contradicts the iter-k decision
— verify this is a genuinely new issue, do not blindly re-fix"). **FLAG only — never demote**
(a real new CRITICAL on a touched line stays blocking, now with context). The ONLY non-advisory
action: **escalate** (new `EscalationReason 'adjudication-contradiction'`, block-once,
fail-closed) when a BLOCKING finding overlaps a region whose prior_verdict==='addressed' (asks to
UNDO an accepted fix). Applies only to still-blocking findings (skip already-demoted INFO).

### G3b — Stable-Code-Guard (deferred, advisory)
Flag a finding on a file:line unchanged since the last green/unflagged iteration
(`stable_since_baseline`, render-only). Needs per-iteration baseline plumbing (heaviest) → a
separate advisory-first slice once G0 matures.

## Cross-cutting fail-safe constraints (non-negotiable)

- **REJECT auto-demote-to-INFO on location overlap** (the investigation's Option C) — it silently
  hides a real new CRITICAL on a churning line. The forbidden unsound suppressor.
- G1/G3b: **flag by default**, escalate (fail-closed, surface to human) only on the narrow
  undo-an-accepted-fix case. Never demote.
- G2/G1 escalations mirror signature-recurrence: block-once, write ESCALATION.md, off-ramp grace,
  `deferableOnQuota=true`; the hardCap max-iterations escalate (loop-driver:888) stays
  `deferableOnQuota=false` as the un-deferrable backstop. Clamp `maxLocationRecurrence >
  stuckThreshold` in code.
- G3: one-step CRITICAL→WARN, positive marker + present-defect backstop, EXEMPT security/correctness.
- New schema fields `z.optional()`; new `phases.review` flags `z.boolean().optional()`+defaults.ts
  (NOT `.default(true)`); new loop knob `.default()`-style.
- G2/G1 location checks are **additive** to the signature-keyed guards (escalateAndDecide returns
  at the first matching precondition; order stuck → signature-recurrence → location-recurrence so
  the whole-set/per-signature stalls still win; a pure location-treadmill reaches the new check
  precisely because the signature ones returned []). Honor `protectHighPrecisionReviewers`
  precedence in G3 (skip demote on a protected finding).

## Status
- [x] Investigation (4-agent workflow) + cross-check
- [x] Plan (this doc)
- [ ] G3 / G0 / G2 / G1 / (G3b deferred)
- [ ] DoD (opus senior — codex quota-locked) · merge · push · deploy
