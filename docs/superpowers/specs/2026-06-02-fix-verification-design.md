# Fix-Verification (§4.3) — Design (rev. 2)

**Status:** Approved in principle; revised after a 2-reviewer pass (R1 FAIL, R2
PASS-with-corrections) that found a real escape-hatch trap + an incoherent
aggregator option + an over-broad exemption. Roadmap §4.3. Builds on the 2b
plumbing (`cycle_rejected_signatures`), the structural template.

## Problem

When the agent marks a finding `accepted` with `action:"fixed"`, the gate trusts
the fix worked: the finding is dispositioned and the cycle moves on. Nothing
verifies the fix actually resolved it — an agent can "paper over" a real finding
and the gate never notices when the SAME finding recurs.

## Goal

Close the "did-the-fix-work?" loop at the GATE level: when a finding the agent
marked `accepted`/`action:"fixed"` in an earlier iteration of the current cycle
RECURS (same signature) later, re-flag it as still-blocking + warn that the
claimed fix did not resolve it. Uses existing per-finding signatures + the
re-review loop. No corpus dependency.

**Non-goals:** escalation-on-repeated-paper-over (deferred); any reputation change
(`accepted` already credits the reviewer `correct` — verified `reputation/learn.ts:50`).

## Known limitation (documented, accepted for slice 1)

Recurrence is detected by **exact post-symbol-graph signature** (same space as
`cycle_rejected`/stuck-detection). When the agent's "fix" edit shifts the
enclosing tree-sitter symbol or moves the line across the signature bucket, the
recurrence carries a DIFFERENT signature and is MISSED → no re-flag → degrades to
today's behavior (safe direction: a miss is never a false force-block). This slice
catches the common "marked-fixed-but-barely-touched" paper-over; drift-tolerant
matching `(file, normalizeRuleId, category)` is a possible later enhancement.

## Mechanism

1. **Track claimed-fixed signatures.** For each prior-iteration decision with
   `verdict:"accepted"` AND `action:"fixed"` (the exact `decision.ts` literal;
   `addressed-elsewhere`/`deferred-with-followup` do NOT count), resolve
   `finding_id` → the finding's FULL signature set (its representative signature AND
   every clustered member signature) via the prior `pending.json`, and record EACH of
   those `signature → iteration` in `state.claimed_fixed_signatures` (keep the
   EARLIEST iteration per signature). Recording the members too — not just the
   representative — is required because `aggregate()` pins a recurrence on rep-OR-member;
   if only the representative were stored, a recurrence later flagged under one of the
   prior finding's MEMBER signatures (a different reviewer, or after the representative
   selection changes) would not match and would escape the pin. Reset on re-arm.
   Accumulated in the SAME `state.update` as the 2b `cycle_rejected_signatures` fold
   (one flock cycle, no torn state).
   - **Last-decision-wins per finding_id.** The decisions file is append-only and the
     agent may append a SUPERSEDING disposition for a finding within an iteration (e.g.
     `accepted/fixed` then later `accepted/deferred-with-followup`). The fold asks "what
     did the agent ultimately decide", so it uses ONLY the LAST valid decision line per
     `finding_id` — a stale earlier `fixed` line that the agent later down-graded must
     NOT record a claimed-fix (which would force-FAIL a recurrence the agent no longer
     claims to have fixed). This is distinct from `evaluateDecisions`, which only asks
     "did the agent decide at all" (any valid line counts) — a different question.
     Symmetric for the rejected fold. Both helpers share one `priorIterationDecisionSignatures(repoRoot, prevIter, match)`
     (last-valid-per-id, joined to rep+member sigs) and differ only in the `match` predicate.
2. **Detect recurrence.** The map is passed into `aggregate()` as
   `claimedFixed: Map<string, number>`. A deduped finding whose representative OR
   any member signature is in `claimedFixed` (and NOT also currently
   suppressed-as-rejected — see tie-break) is a recurrence.
3. **Re-flag (pin-first, the teeth).** Detected recurrences are PINNED before the
   demote chain: the critic, confidence-floor, and reputation demote passes SKIP a
   pinned finding (`if (pinned.has(f.signature)) return f`), so it keeps its
   reviewer CRITICAL/WARN severity. It is tagged `claimed_fixed_recurred: { iter }`
   with the EARLIEST matched iteration. NOT exempt from `scopeFindings` (see below).
3a. **Force FAIL (the actual block).** Preventing demotion is not enough: a
   *singleton* WARN recurrence keeps WARN but, under the default `softPassPolicy:
   "allow"`, would only SOFT-PASS — so the gate would still open and "still-blocking"
   would be a lie. Therefore, in the verdict-counting loop, a finding that STILL
   carries `claimed_fixed_recurred` AND is STILL `CRITICAL`/`WARN` at that point
   forces a hard FAIL (CRITICAL → `fail=true`; WARN → `warnFail=true`). This is the
   strongest possible signal — the agent explicitly claimed to fix it and it is still
   present — so the gate must not open until the agent fixes it for real OR contests
   it as a reviewer FP (which routes it through `cycle_rejected`, where the tie-break
   frees it). A recurrence that was scope/fp-demoted to INFO does NOT force FAIL (it
   is no longer CRITICAL/WARN at the count, so it stays advisory — out-of-diff
   recurrences remain non-blocking per the exemption).
4. **Warn.** `report-writer` adds a system badge (via the existing `demoteBadges`
   mechanism) "⚠ claimed fixed @ iter N — still present" so it renders in the
   BLOCKING section with a clear note (kept short, the demote-note 2000-char cap
   does not apply since pinned findings skip the note-appending passes).

### Exemption scope (corrected from rev.1)

The pin exempts ONLY the passes that can actually soften a FRESH recurrence:
**critic (`likely_fp`), confidence-floor, reputation** — these run unaware of the
claimed-fix history and would demote a singleton recurrence. The pin does NOT
cover:
- **`scopeFindings`** — a recurrence on code NO LONGER in the diff is weak evidence
  of paper-over (the agent may have moved/deleted the code); force-blocking it
  would resurrect the unchanged-code hallucination class M5 scoping exists to kill.
  So scope-demote still applies; only in-diff recurrences stay blocking.
- **`cycleRejected`** — by construction it cannot fire on a claimed-fixed signature
  in the SAME decision (accepted vs rejected are disjoint per finding_id). But
  across iterations a signature can be in BOTH maps (accepted/fixed @ iter1, then
  rejected/`reviewer_was_wrong` @ iter4). **Tie-break: cycleRejected WINS** — once
  the agent has explicitly contested the recurrence as a reviewer FP (on the
  representative OR any clustered member signature), it is demoted/suppressed and NOT
  re-pinned/tagged. This keeps the escape hatch working permanently (rev.1 had this
  backwards, trapping the agent).
  - **Key-space symmetry (required).** The tie-break is only sound if BOTH maps are
    populated over the SAME key space. Because `claimed_fixed_signatures` records a
    fixed finding's representative AND member signatures (mechanism §1), the
    `cycle_rejected_signatures` fold MUST do the same — i.e.
    `priorIterationRejectedSignatures` also records representative + member signatures.
    Otherwise a clustered finding fixed then contested would have only its
    representative in `cycle_rejected` while its member is in `claimed_fixed`; a
    member-flagged recurrence would then be pinned (and now force-FAILed) despite the
    agent's rejection — re-introducing the escape-hatch trap. (This also strengthens
    2b: a contested cluster's member-flagged recurrence is now suppressed too.)

### Escape hatch

If a recurrence is genuinely a different issue at the same bucketed signature, the
agent rejects it with `reviewer_was_wrong` → it enters `cycle_rejected_signatures`,
and the tie-break (cycleRejected wins) means it is no longer force-blocked on the
NEXT recurrence. So the agent is never permanently trapped.

## Architecture

**`src/schemas/state.ts`** — add `claimed_fixed_signatures: z.record(z.string(), z.number().int().positive()).default({})` (signature → earliest claimed-fixed iter; `positive` since a claim only follows iteration ≥1's findings). Add `claimed_fixed_signatures: {}` to the explicit `initialState()` return (REQUIRED — the output type lists it; tsc fails otherwise). Reset to `{}` at the SAME three sites as `cycle_rejected_signatures`: clean-PASS re-arm (`loop-driver.ts:~790`), escalation re-arm (`~422`), and the HEAD-move-WHILE-ESCALATED branch ONLY (`~379`) — NOT on every HEAD move (a mid-FAIL commit must not reset cycle state).

**`src/core/loop-driver.ts`** —
- Helper `priorIterationClaimedFixedSignatures(repoRoot, prevIter): string[]` (mirrors `priorIterationRejectedSignatures`): read `decisions/<prevIter>.jsonl` + prior `pending.json`; for each `verdict:"accepted"` with `action:"fixed"`, map `finding_id` → the finding's representative signature AND every `members[].signature`, and emit ALL of them (so a recurrence under any clustered signature is caught). Never throws.
- In the `iteration > 0` block, FOLD into the SAME `state.update` that already updates `cycle_rejected_signatures` (one flock cycle): merge prior claimed-fixed sigs into `state.claimed_fixed_signatures`, keeping the earliest iter. Update the local `state`.
- Pass `claimedFixedSignatures: state.claimed_fixed_signatures` to BOTH `runIteration` calls.

**`src/core/orchestrator.ts`** — `runIteration` opts gain `claimedFixedSignatures?: Record<string, number>`; pass into `aggregate()` as `claimedFixed: new Map(Object.entries(...))` when non-empty.

**`src/core/aggregator.ts`** —
- `AggregateInput` gains `claimedFixed?: Map<string, number>`.
- Compute `pinned` UP FRONT on the `deduped` array (before ANY demote pass — the
  passes don't run in the spec's listed order; critic actually precedes
  `scopeFindings`, so the pin must exist before the chain regardless of ordering).
  Detection: a deduped finding matches if its representative OR any member signature
  ∈ `claimedFixed` AND NONE of its signatures (representative OR member) are in
  `cycleRejected` (tie-break). The tie-break checks members too — not only the
  representative — so a finding the agent contested via ANY clustered signature is
  neither re-pinned nor tagged. (Rationale: the `cycleRejected` demote pass is
  unguarded and matches on rep-or-member, so it would demote a member-matched pin to
  INFO regardless; matching the tie-break to the same key space prevents an incoherent
  INFO-finding-wearing-a-`claimed_fixed_recurred`-badge. The severity outcome is
  unchanged — cycleRejected still wins — only the misleading tag is suppressed.) Tag
  each matched finding `claimed_fixed_recurred: { iter }` (earliest matched iter).
  **`pinned` is a `Set<string>` of the matched findings' REPRESENTATIVE signatures**
  (NOT the matched member sig) — detection may match on a member, but the guard below
  keys on `f.signature` (the representative), so the set must store representatives or
  the guard misses.
- The critic, confidence-floor, and reputation demote passes get a guard:
  `if (pinned.has(f.signature)) return f;` (skip — keep blocking). `scopeFindings`
  and the fp/cluster passes are unchanged (a pinned finding still scope-demotes if
  out-of-diff; fp/cluster rarely apply and are not load-bearing here).
- In the final verdict-counting loop, a finding that still carries
  `claimed_fixed_recurred` at its CRITICAL/WARN branch forces the block: CRITICAL →
  `fail = true`, WARN → `warnFail = true` (so a singleton WARN recurrence FAILs
  instead of SOFT-PASS-ing). An INFO finding (scope/fp-demoted) is untouched.

**`src/schemas/finding.ts`** — add `claimed_fixed_recurred: z.object({ iter: z.number().int().positive() }).optional()`.

**`src/core/report-writer.ts`** — `demoteBadges()`-style badge for `claimed_fixed_recurred` ("⚠ claimed fixed @ iter N — still present; the fix did not resolve it"); `isAdvisory()` must keep it in the BLOCKING section (it carries no scope/fp demote flag and stays CRITICAL/WARN, so it already does).

## Error handling
- Accumulation best-effort (never throws; missing files → no-op), like 2b.
- Tie-break is explicit (cycleRejected wins); no "fail toward blocking" hand-wave.
- Signature drift → missed recurrence → safe-direction degradation (see Limitation).

## Testing (TDD)
1. **loop-driver accumulation:** seed pending.json (F-001 sig-X) + decisions/1.jsonl (`accepted`,`action:"fixed"`) @ iter 1; stub orchestrator records opts → `claimedFixedSignatures` has `sig-X`, `state.claimed_fixed_signatures["sig-X"] === 1`. An `accepted`/`action:"addressed-elsewhere"` is NOT recorded.
2. **Reset on clean-PASS re-arm** → `{}`.
3. **aggregator pin + blocking:** a finding ∈ claimedFixed is tagged + kept CRITICAL/WARN EVEN WHEN a critic `likely_fp` would demote it. Member-signature match works.
4. **Tie-break:** a signature in BOTH claimedFixed AND cycleRejected → cycleRejected wins (demoted to INFO, NOT pinned).
5. **scope still applies:** a claimedFixed finding on an out-of-diff file → still scope-demoted to INFO (NOT force-blocked).
6. **No-op:** empty claimedFixed → identical to today; non-matching finding untouched.
7. **report-writer:** tagged finding renders the badge in the blocking section.

## Files
- Create: `tests/unit/aggregator-claimed-fixed.test.ts`
- Modify: `src/schemas/state.ts` (field + initialState + 3 resets), `src/schemas/finding.ts` (tag),
  `src/core/loop-driver.ts` (helper + single-update accumulation + resets + runIteration pass),
  `src/core/orchestrator.ts` (opts + aggregate pass), `src/core/aggregator.ts` (pinned set + 3 pass guards),
  `src/core/report-writer.ts` (badge), `tests/unit/loop-driver.test.ts` (accumulation test).
