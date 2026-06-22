# G0 — demoted-from-CRITICAL findings stay decision-required (soft-pass fail-open) — 2026-06-21

Grounded by a 3-agent design swarm (provenance, soft-pass-flow, adversarial). This is the
**highest-risk code in the repo** (verdict / soft-pass / decisions-gate). Every change is
judged against: it must NEVER auto-hide a real CRITICAL, and it must NOT introduce a loop.

## The bug (systemic soft-pass fail-open)
A CRITICAL demoted ONE step to WARN by a **value-judgment** demoter, if it's the sole finding,
yields a **SOFT-PASS**. Under the default `loop.softPassPolicy:"allow"`, `loop-driver.ts:1375-1383`
sets `passed=true` → re-arms (`iteration:0`) and ALLOW-STOPS with **no required decision** (the
decisions-gate at `loop-driver.ts:1060` only runs on `iteration>0`, which the re-arm skips). So a
possibly-real CRITICAL is silently auto-hidden.

## The 5 value-judgment demote sites (codex plan-gate: it's 5, not 4)
1. `hypothetical-demote.ts:33-40` `demote()` (sets `hypothetical_demoted`) — pre-aggregate, CRITICAL→WARN, security/correctness exempt.
2. `grounding.ts:20-27` `groundingDemote()` (sets `grounding_demoted`) — used by layer-1 `groundFindings` (`:89`, security/correctness exempt) AND layer-2 `applyGroundingJudgeVerdicts` (`:223-235`). **codex CRITICAL: layer-2 does NOT exempt security/correctness today** → FIX: add the same `touchesSecurityOrCorrectness` exemption to layer-2 (matching layer-1) so no value-judgment pass ever demotes a security/correctness CRITICAL.
3. `aggregator.ts:515-527` critic `likely_fp` — `next=DEMOTE[severity]`, sets `critic_verdict` but **NO `_demoted` flag today**; post-merge.
4. `aggregator.ts:702-711` reputation pure-quality — `next=DEMOTE[severity]`, sets `reputation_demoted`; post-merge; already security-exempt + correctness-CRITICAL-exempt.
5. **`aggregator.ts:647-657` confidence-floor (codex CRITICAL — the one I missed)** — a non-security/correctness low-confidence CRITICAL is sent **DIRECTLY to INFO** (NOT via `DEMOTE`), setting only `low_confidence`. It already exempts `CRITICAL && touchesSecurityOrCorrectness` (`:643`). FIX: it must CLAMP a from-CRITICAL at WARN (not INFO) + stamp `demoted_from_critical`.

After the layer-2 grounding fix, ALL 5 demoters exempt security/correctness, so **a
`demoted_from_critical` finding is non-security/correctness BY CONSTRUCTION** — which makes the
`acknowledged-low-value` off-ramp valid and the reject→`cycleRejected`→INFO off-ramp work (the G0b
ceiling only blocks suppressing security/correctness, which a from-CRITICAL never is).

(Structural / agent / ledger CRITICAL→INFO demoters — `scope_demoted` out-of-diff, `fact_invalid`
phantom-line, `redaction_demoted`, `self_refuted`, `cycleRejected` agent-reject, `fp_ledger_match` /
`fp_cluster_match` known-FP, `test_severity_demoted` — are NOT value judgments and set INFO DIRECTLY,
not via the clamp. They legitimately suppress a from-CRITICAL to INFO and must NOT arm the block. The
clamp keeps VALUE-JUDGMENT demotes at WARN; everything that legitimately reaches INFO is structural/
agent/ledger → the WARN-vs-INFO split IS the block-vs-suppress signal.)

## Design

### Part 1 — provenance: `demoted_from_critical` is the SINGLE source of truth (codex round-2 fix)
**Do NOT key the block on `original_severity`.** `original_severity` must be max()-propagated through
merge, which CONTAMINATES a representative: a structurally-demoted CRITICAL→INFO member (e.g.
`scope_demoted` out-of-diff) merged under a genuine WARN rep would push the rep's `original_severity`
to CRITICAL and wrongly arm the block (codex CRITICAL). Instead key everything on the boolean
`demoted_from_critical`, which is set **ONLY by the 5 value-judgment demoters** — a structural/agent/
ledger demoter NEVER sets it, so OR-propagation through merge can't contaminate from a structurally-
suppressed member.
- **FindingSchema** (`src/schemas/finding.ts`): add `demoted_from_critical: z.boolean().optional()`
  to the top-level finding AND the `members[]` schema. **MUST** add — `FindingSchema` is non-strict,
  so `safeParse` in `readPendingReport` would STRIP unknown keys and the re-arm check would go blind.
  (`original_severity` is NOT needed for the logic; skip it, or add it optional/audit-only.)
- **Set `demoted_from_critical:true`** at EACH of the 5 value-judgment sites, gated on the demote
  being FROM CRITICAL: `f.demoted_from_critical || f.severity === "CRITICAL"` (a second value-judgment
  demoter on an already-demoted WARN keeps the flag via the clamp; the flag never gets set by a
  WARN→INFO of a genuine never-CRITICAL WARN).
- **Merge propagation** (`aggregator.ts:204-212 memberOf` + the deduped push `:429-435`):
  `memberOf()` records `demoted_from_critical` per member; the representative gets
  `demoted_from_critical = OR(rep, all members)`. **Load-bearing**: without it, a CRITICAL-demoted
  member merged under an unflagged equal-severity WARN representative (`:386-391` ties-keep-first)
  silently loses the flag = fail-open. Because structural demoters never set the flag, OR is exactly
  right — it carries genuine value-judgment provenance and nothing else.

### Part 2 — CLAMP a from-CRITICAL finding at WARN (the second-demote / PASS-flip fix)
The headline adversarial risk: a from-CRITICAL WARN that a LATER value-judgment pass
(reputation/critic/confidence-floor) takes WARN→INFO becomes non-blocking, and if it was the sole
finding the verdict flips to **PASS** (not SOFT-PASS), bypassing a SOFT-PASS-only hook.
- **Clamp**: no value-judgment pass may take a `demoted_from_critical` finding below WARN. Apply at
  ALL value-judgment severity-lowering paths (codex round-4: there are **two direct WARN→INFO paths
  outside the DEMOTE map**, not one):
  - the DEMOTE-map ones — critic likely_fp `:516`, reputation pure-quality `:703` — via a
    `demoteOneStep(f)` helper = `DEMOTE[f.severity]` clamped to `"WARN"` when
    `f.demoted_from_critical || f.severity==='CRITICAL'`;
  - the **confidence-floor direct-INFO** (`:654-657`) — emit WARN (not INFO) + stamp the flag;
  - the **reputation CORRECTNESS direct WARN→INFO branch** (`:682-700`, fires only with
    `reputation.demoteCorrectness:true`) — likewise clamp a `demoted_from_critical` finding to WARN.
  The CRITICAL→WARN sites (hypothetical/grounding) already land at WARN. So a from-CRITICAL always
  lands at a SOFT-PASS-blocking WARN (or stays a SOFT-PASS CRITICAL), never a non-blocking INFO/PASS.
- **NOT clamped** (legitimately reach INFO = suppress, not block): `cycleRejected` (agent REJECT
  off-ramp), the ledger passes (`fp_ledger_match`/`fp_cluster_match`), `test_severity_demoted`, and
  the structural passes (`scope_demoted`/`fact_invalid`/`redaction`). These set INFO DIRECTLY (never
  via `demoteOneStep`/confidence-floor) and **never set `demoted_from_critical`** → a from-CRITICAL
  they push to INFO loses neither correctness nor safety: it drops out of the block count (INFO) AND
  out of the required-decision set, which is correct (out-of-diff / rejected / known-FP = suppress).

### Part 3 — keep it decision-required on SOFT-PASS (reuse the block machinery)
- **RunSummary** (`src/schemas/audit-event.ts` + `buildRunSummary`): add an **OPTIONAL** count
  `from_critical_demoted` = number of **CRITICAL or WARN** findings with `demoted_from_critical` in
  the written report (codex round-2: CRITICAL too, not WARN-only — a demoted member merged under a
  genuine CRITICAL rep makes the rep CRITICAL+flagged via OR, and a lone non-security CRITICAL is
  itself a SOFT-PASS that must not silently re-arm). Optional + `.default(0)` so old persisted audit
  events / stats fixtures stay valid. Avoids a second pending.json read / TOCTOU at the re-arm. On
  the FIRST stop of an iteration NO decisions exist yet, so every such finding is "undecided" → the
  count is the signal.
- **CACHE PATH (codex CRITICAL)**: a cached SOFT-PASS is served counts-only with `findings:[]`
  (`orchestrator.ts:948-979`), so `from_critical_demoted` would be 0 → re-arm = fail-open. The repo
  already has a `softPassNeedsFindings` guard that bypasses the counts-only short-circuit for policies
  that need the real WARNs. FIX: extend it so a SOFT-PASS is **never** served counts-only while G0 is
  active (it re-runs the panel → real findings → real count). Fail-closed + simplest; the SOFT-PASS
  counts-only cache is a minor optimization. (Optimization for later: persist `from_critical_demoted`
  in the cache entry so a cached SOFT-PASS can still short-circuit while carrying the count.)
- **STALE PRE-G0 CACHE (codex round-5 CRITICAL)**: a result cached BEFORE G0 ships — e.g. a
  confidence-floor CRITICAL→INFO (sole finding) that produced a clean **PASS** under the old behavior
  — would be served from cache after deploy and allow-stop, auto-hiding the from-CRITICAL. The
  `softPassNeedsFindings` change only covers SOFT-PASS; a stale PASS bypasses it. FIX: **bump the
  cache `schemaVersion`** (`computeCacheKey`, currently `"reviewgate.pending.v1"` → `…v2`) as part of
  G0, invalidating ALL pre-G0 entries so the first post-G0 review of any diff re-runs with the new
  clamp/flag. (G0 changes per-finding semantics, not just config, so a one-time schema bump is the
  correct invalidation — same pattern as the prompt-preamble sha fold.)
- **loop-driver** (`:1376`): `softPassBlocks = result.verdict === "SOFT-PASS" && (softPolicy === "block"
  || result.summary.from_critical_demoted > 0)`. This rides the EXACT existing `softPassPolicy:"block"`
  path (`passed=false` → `iteration:=nextIter`, flag kept, decisions NOT cleared) → next stop
  `iteration>0` → the decisions-gate (`:1125`) requires a decision per CRITICAL/WARN. **No new
  termination path** — convergence is owned by the existing iteration-cap escalation ladder. Use the
  GATE-CLOSED block reason (`:1520-1524`), NOT the `ask-once`/`acknowledgePass` one-time-ack path
  (which deletes the dirty flag + re-arms — that would re-open the hole). `ask-once` must be UPGRADED
  to the decision-block here (treat like `allow`: both need the decision), not its one-time ack.

### Part 4 — disposition off-ramps (no new ack rule needed)
The agent has three exits for a blocking from-CRITICAL WARN:
- **fix** → next panel doesn't produce it → re-arms.
- **reject** (`reviewer_was_wrong`) → `cycleRejected` demotes it to INFO next round → drops out of the
  CRITICAL/WARN required set + the `from_critical_demoted` count → re-arms (converges in ≤3 iters).
- **acknowledged-low-value** → already permitted for a WARN non-security/correctness finding
  (`evaluateDecisions:530-540`), and a from-CRITICAL is non-security/correctness BY CONSTRUCTION
  (hypothetical/grounding/reputation all exempt security/correctness). **No ack-bar relaxation is
  needed.** CAVEAT: ack does NOT fold into a suppressor, so the finding re-appears next panel and the
  agent must re-ack each iteration until the iteration-cap escalation fires (bounded by `maxIter*2`).
  This is fail-safe (surfaces to the human) — DOCUMENT it; recommend reject/fix over repeated-ack.
- **Wording-merge into a high-stakes cluster (codex round-4, bounded/fail-safe — not a fail-open):**
  a non-high-stakes from-CRITICAL WARN can wording-merge (`aggregator.ts:365-375`) into a cluster that
  ALSO contains a security/correctness member → the merged finding `touchesSecurityOrCorrectness`. Its
  REJECT off-ramp is then refused by the G0b ceiling (`aggregator.ts:581` won't demote a
  security/correctness signature to INFO), and `acknowledged-low-value` is forbidden for high-stakes.
  So such a finding converges via **fix only**, else loops to the iteration-cap escalation. This is
  STRICTLY fail-safe (it stays blocking — more conservative; never auto-hidden) but is a real friction
  path: DOCUMENT it + add a test asserting it blocks and escalates (does not auto-hide).

### Part 5 — visibility
- `report-writer.ts` badge (mirroring the `hypothetical_demoted` ⏳ badge): "⬇ was CRITICAL,
  one-step-demoted — decide before passing (don't reflexively acknowledge)".

## Fail-safe analysis
STRICTLY increases gating — a previously soft-passing demoted-from-CRITICAL finding now blocks until
decided. Can only ask for MORE decisions, never fewer. Bounded:
- Provenance survives merge (max/OR propagation) and the pending.json round-trip (schema fields).
- The clamp guarantees a from-CRITICAL never reaches a non-blocking INFO/PASS via value judgment.
- Read-error at the re-arm: `from_critical_demoted` comes from the summary computed in the same run
  (no separate read), so a corrupt pending.json doesn't blind it. If the count can't be computed,
  default to >0 (fail-CLOSED: block once) — never re-arm a SOFT-PASS we can't classify.
- Reuses the existing block path → no new loop; the iteration-cap ladder bounds non-convergence.
- Scope-limited to SOFT-PASS multi-reviewer singleton/minority demoted findings; FAIL (real blocking
  CRITICAL), PASS (clean), single-reviewer (lone CRITICAL hard-FAILs), and one-shot mode are untouched.

## Open design decisions (defaults chosen = the swarm's strictly-fail-safe recommendation)
1. **Clamp-at-WARN** (chosen) vs also-instrument-the-PASS-branch. Clamp is simpler + strictly fail-safe.
2. **Exclude structural demoters** (scope/fact_invalid/redaction) from arming the block (chosen) — they
   aren't value judgments; blocking an out-of-diff/phantom finding would be wrong.
3. **Ack stays iteration-cap-bounded** (chosen) — no new ack-convergence suppressor (keeps G0 minimal).

## Slices / files
- `finding.ts` (+`demoted_from_critical` on the top-level finding AND the `members[]` schema;
  `original_severity` NOT needed for the logic — skip, or add optional/audit-only).
- `orchestrator.ts` (extend `softPassNeedsFindings` so a SOFT-PASS is never served counts-only under G0).
- `grounding.ts` (**add security/correctness exemption to layer-2** `applyGroundingJudgeVerdicts`;
  `groundingDemote` sets `demoted_from_critical`).
- `hypothetical-demote.ts` (set `demoted_from_critical`).
- `aggregator.ts` (`demoteOneStep` clamp + `demoted_from_critical` for critic+reputation;
  **confidence-floor clamps a from-CRITICAL to WARN not INFO + sets the flag**; `memberOf` +
  representative merge **OR-propagation of `demoted_from_critical`** — NOT max(original_severity),
  which would contaminate the rep from a structurally-demoted member).
- `audit-event.ts` + `run-summary.ts` (optional `from_critical_demoted` count = **CRITICAL or WARN**
  findings with `demoted_from_critical`).
- `loop-driver.ts` (`softPassBlocks |= SOFT-PASS && summary.from_critical_demoted>0`; route via the
  GATE-CLOSED block, NOT ask-once/acknowledgePass; treat `ask-once` like the decision-block here).
- `report-writer.ts` (badge) · docs (AGENTS.md off-ramps + the ack-loop-is-iteration-cap-bounded caveat).
- **Tests** (TDD): merge-propagation keeps the flag (incl. demoted member under an equal-severity
  WARN rep AND under a CRITICAL rep → both counted); clamp keeps a from-CRITICAL ≥WARN through a 2nd
  value-judgment demote (reputation + confidence-floor); a sole demoted-from-CRITICAL WARN under
  `allow` BLOCKS (not re-arm); a plain WARN still re-arms; a `scope_demoted` CRITICAL→INFO member
  merged under a genuine WARN rep does NOT contaminate/block (flag-keyed, not original_severity);
  reject→cycleRejected→INFO converges; single-reviewer lone CRITICAL still hard-FAILs (unchanged);
  ask-once upgraded; cached SOFT-PASS does not bypass the block. **Intentional fixture updates
  (codex WARN):** `orchestrator.test.ts` AND `grounding-judge.test.ts` currently expect layer-2
  grounding (`applyGroundingJudgeVerdicts`) to demote a security/correctness CRITICAL to WARN — G0
  makes layer-2 exempt security/correctness, so both must change to assert the high-stakes CRITICAL
  stays blocking. Audit all softPassPolicy/SOFT-PASS/hypothetical_demoted/reputation_demoted/cache
  fixtures (the cache schemaVersion bump may shift cache-hit/miss expectations).
