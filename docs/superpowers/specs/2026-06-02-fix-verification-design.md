# Fix-Verification (§4.3) — Design

**Status:** Approved in principle (2026-06-02). Roadmap §4.3. P1 of the
self-improving track. Builds on the per-cycle-signature plumbing from 2b
(`cycle_rejected_signatures`), which is the structural template.

## Problem

When the agent marks a finding `accepted` with `action:"fixed"`, the gate trusts
that the fix worked: the finding is dispositioned, reputation credits the reviewer
as `correct`, and the cycle moves on. But nothing verifies the fix actually
resolved the issue. An agent can "paper over" a real finding — mark it fixed
without fixing it — and the gate never notices when the SAME finding recurs.

## Goal

Close the "did-the-fix-work?" loop at the GATE level: when a finding the agent
marked `accepted`/`action:"fixed"` in an earlier iteration of the current cycle
RECURS (same signature) in a later iteration, re-flag it as still-blocking and
warn prominently that the claimed fix did not resolve it. No corpus dependency —
uses the existing per-finding signatures + the re-review loop.

**Non-goals:** escalation-on-repeated-paper-over (deferred); any reputation change
(`accepted` already credits the reviewer `correct`, so recurrence adds no
reputation signal — the value is purely the gate-level re-flag).

## Mechanism

1. **Track claimed-fixed signatures.** After an iteration's decisions are written,
   for each decision with `verdict:"accepted"` AND `action:"fixed"`, resolve its
   `finding_id` → signature (via the prior `pending.json`) and record
   `signature → iteration` in a new `state.claimed_fixed_signatures`. Keep the
   EARLIEST iteration if a signature is claimed-fixed more than once. Reset on
   re-arm (clean PASS / escalation re-arm), exactly like `cycle_rejected_signatures`.
   Only `action:"fixed"` counts — `addressed-elsewhere`/`deferred` are not claims
   of an in-diff fix.
2. **Detect recurrence.** The accumulated map is passed into `aggregate()` as
   `claimedFixed: Map<string, number>`. A deduped finding whose representative OR
   any member signature is in `claimedFixed` is a recurrence of a claimed-fixed
   finding.
3. **Re-flag (the teeth).** Such a finding is tagged
   `claimed_fixed_recurred: { iter }` and kept BLOCKING — EXEMPT from the critic,
   cycle-rejected, fp-ledger, and scope demote passes (a confirmed-real,
   falsely-claimed-fixed finding must not be softened). It keeps its reviewer
   severity.
4. **Warn.** `report-writer` renders a prominent note on the tagged finding:
   "⚠ You marked this fixed at iteration N — it is still present; the fix did not
   resolve it."

**Escape hatch:** if the recurrence is genuinely a different issue at the same
signature, the agent can still reject it with `reviewer_was_wrong` (→ flows to
`cycle_rejected_signatures`, 2b). So this is not a hard trap.

**Disjointness:** `claimed_fixed_signatures` (accepted+fixed) and
`cycle_rejected_signatures` (rejected) are disjoint by construction — a decision
is either accepted or rejected. No conflict between the two passes.

## Architecture

### Components

**`src/schemas/state.ts`** — add `claimed_fixed_signatures: z.record(z.string(), z.number().int().nonnegative()).default({})` (signature → earliest claimed-fixed iteration). `.default({})` for back-compat. Reset to `{}` on the three re-arm sites (mirrors `cycle_rejected_signatures`).

**`src/core/loop-driver.ts`** —
- A helper `priorIterationClaimedFixedSignatures(repoRoot, prevIter): Array<string>` (mirrors `priorIterationRejectedSignatures`): read `decisions/<prevIter>.jsonl` + prior `pending.json`; for each `verdict:"accepted"` with `action:"fixed"`, map `finding_id` → signature. Never throws.
- In the `iteration > 0` block (next to the 2b accumulation), fold the prior iteration's claimed-fixed signatures into `state.claimed_fixed_signatures` (recording the prevIter, keeping the earliest if already present), persist, and update the local `state`.
- Reset `claimed_fixed_signatures: {}` at the three re-arm state-updates (clean PASS at ~717, escalation re-arm at ~377, HEAD-move re-arm at ~419) alongside `cycle_rejected_signatures`.
- Pass `claimedFixedSignatures: state.claimed_fixed_signatures` to both `runIteration` calls.

**`src/core/orchestrator.ts`** —
- `runIteration` opts gain `claimedFixedSignatures?: Record<string, number>`.
- Pass it into `aggregate()` as `claimedFixed: new Map(Object.entries(...))` (when non-empty).

**`src/core/aggregator.ts`** —
- `AggregateInput` gains `claimedFixed?: Map<string, number>`.
- A NEW pass (placed AFTER the existing demote passes — critic, scope, fp, cycleRejected — so it can OVERRIDE them): for each finding whose representative or member signature is in `claimedFixed`, set `claimed_fixed_recurred: { iter }` and RESTORE its pre-demote blocking severity if a demote pass softened it. Simplest correct form: compute the recurrence tag on the ORIGINAL (pre-demote) finding severity and, if matched, emit the finding at its original CRITICAL/WARN severity with the tag, bypassing the demote results. (Implementation: run the claimedFixed pass on the survivors BEFORE the demote chain, mark matched findings as "pinned-blocking", and have the demote passes skip pinned findings — OR run it last and overwrite severity from the dedup `sample`. The plan picks the cleaner of the two; the contract is: a claimed-fixed-recurrence is tagged AND blocking regardless of other passes.)

**`src/schemas/finding.ts`** — add `claimed_fixed_recurred: z.object({ iter: z.number().int().nonnegative() }).optional()`.

**`src/core/report-writer.ts`** — when rendering a finding with `claimed_fixed_recurred`, prepend/append the warning note to its details/section.

### Error handling
- Accumulation is best-effort (never throws; missing files → no-op), like 2b.
- A signature that is BOTH claimed-fixed (prior iter) and freshly rejected this iter cannot occur (disjoint decisions); but if data is malformed, the claimedFixed pass runs last and wins (blocking) — fail toward surfacing, not suppressing.

## Testing (TDD)

1. **loop-driver accumulation** (`loop-driver.test.ts`): seed pending.json (F-001 sig-X) + decisions/1.jsonl (accepted, action:"fixed") at iteration 1; run with a stub orchestrator that records opts → `claimedFixedSignatures` contains `sig-X`; and `state.claimed_fixed_signatures["sig-X"] === 1`. An `accepted` with `action:"addressed-elsewhere"` is NOT recorded.
2. **Reset on re-arm:** after a clean PASS, `claimed_fixed_signatures` is `{}`.
3. **aggregator tag + blocking** (`aggregator-claimed-fixed.test.ts`): a finding whose signature ∈ `claimedFixed` is tagged `claimed_fixed_recurred` and its verdict-blocking severity is preserved EVEN WHEN a critic `likely_fp` (or cycleRejected, or scope) would otherwise demote it. Member-signature match also works.
4. **No-op:** a finding NOT in `claimedFixed` is untouched; empty `claimedFixed` → identical to today.
5. **report-writer:** a tagged finding renders the "claimed fixed at iteration N" warning.

## Files

- Create: `tests/unit/aggregator-claimed-fixed.test.ts`
- Modify: `src/schemas/state.ts` (+ field + 3 resets), `src/schemas/finding.ts` (+ tag),
  `src/core/loop-driver.ts` (+ helper, accumulation, resets, runIteration pass-through),
  `src/core/orchestrator.ts` (opts + aggregate pass), `src/core/aggregator.ts` (claimedFixed pass),
  `src/core/report-writer.ts` (warning note), and `tests/unit/loop-driver.test.ts` (+ accumulation test).
