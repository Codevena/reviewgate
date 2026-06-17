# Precision-Calibration Field-Report Remediation — Plan & Status

**Date:** 2026-06-17
**Branch:** `feat/precision-calibration-fieldreport`
**Source:** A field report from running the **deployed** Reviewgate binary on a
production project (a 40-line, 2-file change → push-to-main → Coolify auto-deploy
workflow). The report **praised** the triage metadata, reviewer-reputation
transparency, the accountability decision-loop, the Required/Advisory split, and a
real catch (a 158 KB untracked `.git_last_commit.diff` debug artifact, 3-reviewer
consensus @ 0.98, secrets already redacted). It then flagged a **precision** problem:
in that session **1 real WARN + 1 wrongly-demoted real bug vs 12 noise findings**.

This report is from a **different** project than the 2026-06-16 flashbuddy report
(which is 10/10 shipped). The praised "Reviewer track record" line IS the flashbuddy
#8 (provider-precision) that already shipped — so this report runs a binary that
already has those fixes and surfaces the **next** layer of calibration gaps.

## Guiding principle (carried from prior remediations)

**A suppressor MUST fail safe.** Three flashbuddy items (#3/#8/#4) were pivoted from a
literal suppressor to a non-suppressing/advisory form once the literal version was
found to fail open. This batch holds the line: of the 8 slices, **7 are
report-only / anti-suppression / prompt-directive**, and the 1 genuinely-new demote
pass (T1) is **INFO-demote (never DROP) + positive-signal + negation backstop**.

The whole batch is **precision, not completeness** — fewer, sharper findings.

## Slices (mapped to the report's 7 priorities + bundling friction)

| # | Slice | Report item | Type | Effort |
|---|---|---|---|---|
| **T1** | Self-refuting-finding demote | #1 (biggest quick win) | NEW demote-only pass (INFO) | S |
| **T2** | In-diff vs repo-wide section split | #2 | render-only | S |
| **T3** | Solo low-track-record INFO collapse | #3/#5 | render-only (+safe learn) | M |
| **T4** | Protect high-precision reviewers from soft demoters | #4 (the dangerous direction) | anti-suppression | M |
| **T5/T6** | House-rule citation (prompt directive + advisory demote) | #6 | prompt + demote-only | M |
| **T_timing** | Preliminary-pass labelling | #3-timing | render-only | M |
| **T7** | Size-aware per-reviewer timeout cap | #7 | calibration (never drops a reviewer) | M |
| **T8** | Folded-concerns enumeration | bundling | render-only | S |

### T1 — Self-refuting-finding demote (NEW pass)
**Symptom:** ~6/14 findings ended literally "This appears safe", "No issue", "No defect".
**Root cause:** `mapReviewOutputToFindings` ignores the finding's own conclusion; no pass
inspects the message for a benign verdict, so a self-contradicting WARN/CRITICAL blocks.
**Fix:** new `src/core/self-refutation.ts` `demoteSelfRefuting()`, wired as the FIRST
demote pass in `orchestrator.ts` right after `validateFindingFacts` (~1532), BEFORE
grounding/critic/aggregate so the demoted INFO flows through severity counting.
- Demote to **INFO** (sets `self_refuted:true` + advisory note), **never drop**.
- **Positive-signal only:** match a *terminal* benign conclusion (the benign clause is
  the trailing clause of message OR details, per-field).
- **Negation/conditional backstop:** abort the demote if a trailing
  `but/however/unless/if/except/not ` precedes the benign token → "this WOULD be safe IF
  X but X is missing" never matches.
- **Security/correctness EXEMPT** (dogfood-gate DoD CRITICAL): unlike `fact-check` (provable
  ground truth), this keys on the reviewer's UNTRUSTED prose, so a confused/injected reviewer
  could retract a real vuln. The hard-veto categories stay blocking (matches reputation/
  grounding/critic). Other categories demote regardless of severity.
- Flag `phases.review.selfRefutationFilter` (default true; `z.boolean().optional()` + defaults.ts).
- **Files:** `src/core/self-refutation.ts` (new), `orchestrator.ts`, `schemas/finding.ts`
  (`self_refuted?`), `config/{defaults,define-config}.ts`, `report-writer.ts` (note).
- **Tests:** `tests/unit/self-refutation.test.ts` — positives across all severities/categories;
  negatives = the conditional/negation guardrails (first-class regression); idempotence;
  the demoted INFO no longer contributes to FAIL/SOFT-PASS.
- **REJECTED:** Option 2 (DROP) — irreversible/invisible, one regex miss kills a real finding.

### T2 — In-diff vs repo-wide section split (render-only)
**Symptom:** ≥8/13 INFO were on files never touched (Redis/SQL on untouched files), mixed
into the must-read list.
**Already shipped:** `scopeToDiff` (default on) already demotes out-of-diff to INFO + a
`scope_demoted:true` flag + a 📍 badge, and they are already non-blocking & decision-free
(verified: aggregator verdict counting + `loop-driver.ts:117-124` gate only CRITICAL/WARN).
**Gap:** presentation only — `report-writer` lumps `scope_demoted` (repo-wide) and plain
in-diff INFO into one Advisory section.
**Fix:** in `report-writer.ts renderMd`, partition Advisory into `outOfDiff =
advisory.filter(f => f.scope_demoted)` → a distinct **"Existing code (advisory —
pre-existing, not gated)"** section, vs in-scope advisory. No schema change; consumers can
partition pending.json on the already-serialized `scope_demoted`.
- **Files:** `report-writer.ts`, `tests/unit/report-writer-advisory.test.ts`.
- **Decision:** use Option 1 (group all `scope_demoted`). Strict file-level (Option 3,
  `scope_demoted_reason` enum) only if the user later asks to exclude same-file/line-outside.

### T3 — Solo low-track-record INFO collapse (render-only + safe learn)
**Symptom:** ~13 INFO from openrouter (29% TP) the agent must mentally filter.
**Root cause (two reinforcing):** (a) the reputation demoter early-returns on INFO
(`aggregator.ts:628`) so a low-trust INFO flood is never down-weighted; (b) trust is
learned only from CRITICAL/WARN decisions, so an all-INFO 71%-FP reviewer never crosses
`trustFloor` → never quarantined.
**Fix:** **Option A** (report-only): in `report-writer.ts`, move a finding that is
(INFO) AND (singleton/minority) AND (sole reviewer below the low-trust threshold) AND
(NOT security/correctness) into a collapsed `<details>` "N low-track-record advisory
notes from <provider> (X%)" block — full text preserved, nothing dropped, pending.json
unchanged. Key off the `reviewer_precision` cell already attached by #8 (shared
threshold module — see Cross-cutting). Plus the **safe half of Option C**: an explicit
`reviewer_was_wrong` decision on an INFO books one `wrong` event (already mostly folds;
verify) — **NOT** the silent-ignore inference (fails open).
- Flag `phases.review.collapseLowTrustSoloInfo` (default true).
- **Files:** `report-writer.ts`, `provider-precision.ts`/`reputation` (shared threshold),
  `reputation/learn.ts` (safe-C), tests.
- **REJECTED:** hard suppression below a surfacing floor (could vanish a real solo INFO);
  Option C silent-ignore-as-FP (erodes valid reviewer trust → quarantine fails open).

### T4 — Protect high-precision reviewers from the soft demoters (anti-suppression)
**Symptom:** F-005 (real Safari `-webkit-box-decoration-break` bug from claude-code @78%
TP / 0.87 conf) was demoted INFO via "critic likely_fp" + "below confidence floor" — the
**dangerous** direction (a demoted true positive).
**Root cause:** the critic-`likely_fp` demote (`aggregator.ts:461-499`) and the
confidence-floor demote (`589-616`) gate ONLY on consensus + category; neither consults
the raising reviewer's precision or the finding's own confidence. On a low-overlap panel
nothing is corroborated, so a lone-but-correct high-trust finding is demoted like a blind
guess.
**Fix:** plumb `protectedReviewers: Set<string>` (precision ≥ 0.70 AND samples ≥
minSamples) into `aggregate()`; add it as an exemption to BOTH soft demoters (the critic
may still TAG `critic_verdict` informatively but must not lower severity; confidence-floor
returns unchanged). Source from `loadProviderPrecision()` (already imported for #8) —
**move the load BEFORE `aggregate()`** and reuse it for the #8 annotation too.
- **MUST NOT** exempt: a T1 `self_refuted` finding, or any HARD suppressor (scopeToDiff,
  fpActive, cycleRejected, fact-check, grounding) — only the 2 SOFT demoters.
- Flag `phases.review.protectHighPrecisionReviewers` (default true).
- **Files:** `aggregator.ts`, `orchestrator.ts`, `provider-precision.ts`, `reputation/{store,score}.ts`,
  `config/*`, `schemas/finding.ts` (optional `protected_high_precision` tag), tests.
- Inherently fail-safe (only PREVENTS a demote). Guard: min-samples so a 1/1=100%
  newcomer is never "trusted"; precision (decayed, trusted) over gameable self-confidence.

### T5/T6 — House-rule citation provenance
**Symptom:** F-004 cited "CLAUDE.md says: DO NOT ADD ANY COMMENTS" — a rule NOT in the
repo (it's the Claude Code training-prior convention); unfalsifiable; flagged comments
mostly pre-existed.
**Fix (combine, defense in depth):**
1. **Prompt directive** (must-ship, root-cause, zero risk): add to `REVIEW_PROMPT_PREAMBLE`
   + `DOC_REVIEW_PROMPT_PREAMBLE`: any finding relying on a project/house rule MUST quote
   the exact file:line; the well-known Claude Code defaults are NOT this repo's rules unless
   written in its CLAUDE.md/config; uncited → at most INFO. Ensure the preamble is in the
   cache behavior hash so it invalidates cached verdicts.
2. **Deterministic advisory backstop** (`src/core/rule-citation.ts`, applied alongside
   `groundFindings` ~1543): a finding whose message matches a rule-assertion regex AND
   carries no verifiable file:line citation → demote ONE step + `rule_citation_unverified`,
   note "asserts a project rule without a verifiable citation". EXEMPT security/correctness
   (mirror `grounding.ts:76`), positive-signal only, never DROP.
- Flag `phases.review.ruleCitationCheck` (default true).
- **Files:** `orchestrator.ts` (preamble), `rule-citation.ts` (new), `schemas/finding.ts`,
  `report-writer.ts`, `cache/behavior-hash.ts` (confirm preamble hashed), tests.

### T_timing — Preliminary-pass labelling (render-only) + escalate the residual
**Symptom:** turn-1 SOFT-PASS "clean" → user push to main → turn-2 GATE CLOSED with 14
findings (759s heavy panel). The clean pass and the deep review reviewed DIFFERENT states;
the deep review can land AFTER the Coolify deploy.
**Root cause:** every passing verdict emits an identical silent `allow_stop` regardless of
panel depth (triage-skip $0 / cache / degraded single-reviewer / full 4-reviewer all read
"Clear to finish"). A clean PASS re-arms; the next edit captures a FRESH base = current
HEAD, so turn-2 reviews a different/larger diff. No "preliminary / not deploy-ready" cue.
**Fix:** **Option A** (report-only): enrich the PASS/SOFT-PASS `allow_stop` message with a
panel-depth descriptor — when `RunSummary.source ∈ {skipped,cache,checks}` OR
`effectiveReviewerCount(okRuns) < |configured reviewers|`, append
"⚠ PRELIMINARY: reviewed by N of M configured reviewers (or triage-skipped) — a fuller
review may surface more; not deploy-ready." Depth = ok-vs-configured (NOT absolute count —
single-reviewer is a supported config and must NOT be mislabelled).
- **Files:** `loop-driver.ts`, `run-summary.ts` (thread configured count), tests.
- **RESIDUAL (escalate to human):** the deeper "deep review BEFORE push" ask is structurally
  outside the Stop-hook (it fires at turn-end, no authority over a later user push). The
  real fix is a **pre-push / CI gate** that consults `.reviewgate/state.json` for a recent
  full-panel PASS on the pushed SHA. Document it; do not fake it inside the gate.
- Optional follow-up: Option B `loop.acknowledgePassWhenShallow` (opt-in) to surface the
  preliminary note to the AGENT in-chain before it confirms clean.

### T7 — Size-aware per-reviewer timeout cap (calibration)
**Symptom:** 12.6 min for a 40-line diff. Only the iteration cap scales with size
(`SMALL_DIFF_LINES=30 → 2 iters`); panel breadth + per-reviewer timeout do not. Per-iter
wall-clock = slowest parallel slot at the 300s default.
**Fix:** **Option A** (timeout cap, never narrows the panel): `matrix.ts` emits
`reviewerTimeoutCapMs` (e.g. tiered: ≤10 lines→60s, ≤30→120s) for small **non-sensitive**
diffs; `orchestrator.ts` clamps the slot `cfg.timeoutMs` to `min(providerCfg.timeoutMs,
cap)`. The FULL panel still runs (≥2 reviewers untouched → singleton-CRITICAL invariant
intact).
- **MUST:** a triage-capped timeout is **gate-imposed, not provider-fault** → it must NOT
  trigger `timeoutCooldownMs` or a reputation/FP penalty (mirror the existing gate
  self-deadline-abort carve-out).
- **Files:** `matrix.ts`, `schemas/triage.ts`, `orchestrator.ts` (slot build + carve-out),
  `config/*`, tests.
- **REJECTED here:** Option B panel-narrowing — reverses the deliberate "never silently
  drop a user-enabled reviewer" decision, needs a non-existent adversarial/slow tag, and
  gives the default single-reviewer config no benefit.

### T8 — Folded-concerns enumeration (render-only)
**Symptom:** "F-001 merges docs, quality" / "F-009 merges architecture, quality — your
decision dispositions ALL of them" — the agent must re-derive the folded concerns from one
run-on `details` sentence.
**Fix:** **Option B** (render-only): in `report-writer.ts fmtFinding`, when `members[]`
span >1 category, render an enumerated **"Folded concerns (one decision covers all)"**
bullet list (per concern: category + rule_id + own message for wording-merged), from data
already on the Finding. Keep the merge + decision-fold accounting exactly as-is (one
`finding_id` dispositions all folded signatures).
- **Files:** `report-writer.ts`, tests.
- **REJECTED:** Option A (split cross-category merges) — reverses intentional dedup, drops
  cross-reviewer corroboration (majority→singleton) → can flip a FAIL to SOFT-PASS. NOT
  fail-safe.

## Sequencing (dependencies first)

1. **T4-plumbing** — move `loadProviderPrecision` before `aggregate()` + extract ONE shared
   precision/threshold module (feeds the opposite-direction T3 & T4 reads).
2. **T1** — self-refutation (front of demote chain; T4 must see `self_refuted`).
3. **T6-directive** — prompt preamble (zero deps, root-cause, cheap).
4. **T4-protect** — high-precision exemption (skips `self_refuted`).
5. **T2** — Advisory section split (establishes the section structure T3 nests into).
6. **T3** — solo low-trust collapse (nests into T2's structure).
7. **T8** — folded-concerns enumeration.
8. **T6-backstop** — rule-citation deterministic demote.
9. **T_timing** — preliminary-pass label.
10. **T7** — size-aware timeout cap (orthogonal; matrix/triage/orchestrator-slot).

Implementation is **inline TDD, serial, one commit per slice** — NOT subagent-parallel:
6 slices mutate `report-writer.ts renderMd/fmtFinding` and 3 mutate the `orchestrator.ts`
demote chain / `aggregator.ts` demote passes, so disjoint-file ownership is impossible and
the cross-check explicitly recommends serial single-author edits. Subagents (codex + opus)
are used for the **DoD review gate**, not for parallel implementation.

## Cross-cutting constraints

- **One shared precision-map load + one threshold module.** T3 (low-trust) and T4
  (high-trust) read the SAME signal in opposite directions — divergent windows/floors could
  make a reviewer simultaneously "collapsed" and "protected". Single source of truth.
- **T4 protect exempts ONLY the 2 soft demoters** (critic `likely_fp`, confidence-floor) —
  never a hard suppressor and never a T1 `self_refuted` finding.
- **Every new schema field `z.optional()`; every new config flag `z.boolean().optional()` +
  a `defaults.ts` default — NOT `.default(true)`** (the ~30 partial-config-fixture foot-gun).
- **Render precedence:** a `scope_demoted` INFO that is also solo-low-trust → the repo-wide
  (T2) bucket wins, then collapse (T3) within it. Define explicitly to avoid double-render.
- **Reject the two fail-open temptations:** T1-DROP and T3-Option-C-silent-ignore.
- **`bun run build` deploys via the `~/.local/bin/reviewgate` symlink to ALL repos** — do
  NOT build before merge + user OK. **Never `git add -A`** (sweeps local `.reviewgate/` state).

## Decisions taken (house-convention defaults; flagged for the user)

- All new flags **default-on** and **fail-safe** (matches settleBeforeReview /
  providerPrecisionContext / fpFragmentationHint precedent).
- T2 = group-all-`scope_demoted` (not strict file-level) unless asked.
- T7 = timeout-cap default-on with the no-cooldown carve-out (not opt-in), since it never
  drops a reviewer; revisit if a zero-regression default is required (then gate behind
  `phases.review.smallDiffPanel`).
- T_timing = report-only label now; the pre-push/CI gate is an escalated follow-up, not
  built this batch.

## Definition of Done (per CLAUDE.md)

Per slice: `bunx tsc --noEmit` + `bun run lint` + the slice's `bun test` green. After the
batch: full `bun test`, then the review gate — **codex ×(quality) + opus (final
whole-branch)** must PASS — then merge + (with permission) push + `bun run build` deploy.

## Status

- [x] Investigation (9-agent workflow) + cross-check
- [x] Plan (this doc)
- [x] **T1** self-refutation demote — `self-refutation.ts`, default ON (commit `feat(#1)`)
- [x] **T6-directive** rule-citation prompt directive (commit `feat(#6)`)
- [x] **T2** in-diff vs "Existing code" section split (commit `feat(#2,#8)`)
- [x] **T8** folded-concerns enumeration (commit `feat(#2,#8)`)
- [x] **T4** protect high-precision reviewers from soft demoters (commit `feat(#4)`)
- [x] **T_timing** preliminary-pass label (commit `feat(#3-timing)`)
- [x] **T3** solo low-track-record INFO collapse (commit `feat(#3,#5)`)
- [x] **T7** size-aware reviewer timeout cap (commit `feat(#7)`)
- [x] **DoD review gate (codex + opus)** — 4 real findings caught + fixed; 1 rejected (below)
- [ ] Merge + push + deploy (await user OK)

### DoD review outcome (codex foreground + opus whole-branch agent)

Both reviewers ran `bunx tsc --noEmit` + `bun run lint` + `bun test` themselves. Real findings,
all **fixed + regression-tested**:

1. **[CRITICAL, opus]** self-refutation fail-open: the matcher demoted imperative-mood
   recommendations ("Verify the path is safe", "Ensure the chain is valid", "Make sure the
   encoding is correct") → de-gated real bugs. **Fix:** dropped the ambiguous correctness
   adjectives (correct/valid/sound/secure/…) from the all-clear family (clearance signal is
   safety/no-issue, not correctness) + a RECOMMENDATION/imperative guard. (`fix(#1,#6)`)
2. **[WARN, codex]** self-refuted finding could be DROPPED end-to-end (critic INFO+likely_fp →
   drop), breaking the "demote-to-INFO, never drop, stays visible" contract. **Fix:** the
   critic pass now skips `self_refuted` findings. (`fix(#1)`)
3. **[WARN, codex]** `protected_high_precision` stamped before the hard suppressors → a later
   scope/fp demote to INFO left a misleading "🛡 kept blocking" badge. **Fix:** gate the badge
   on a non-INFO severity. (`fix(#4)`)
4. **[WARN, opus+codex]** the #6 prompt directive wasn't in the cache key (only RG_VERSION on
   deploy). **Fix:** fold the preamble sha256 into the cache key. (`fix(#1,#6)`)

**Rejected (reviewer_was_wrong):** codex's final WARN — "`reviewer_precision` in pending.json
violates render-only" — is **pre-existing #8 behavior** (master `orchestrator.ts:1749` +
`finding.ts:105`, shipped `f39bf98 feat(#8)`), NOT introduced by this branch: T4 only *reused*
the already-loaded precision map, so pending.json is byte-identical to master's #8 output.
`reviewer_precision` is intentional, schema-documented **advisory** metadata that never affects
the verdict/gating. The "render-only / pending.json unchanged" claim applies to the new render
slices (T2/T3/T8/T_timing), which touch **pending.md only**; #8's advisory annotation is the
sole (pre-existing, by-design) pending.json writer. Opus (senior tiebreaker) confirmed #8
render-only/verdict-unchanged and returned **PASS** after fix #1.

Final: `bunx tsc --noEmit` clean · `bun run lint` clean · `bun test tests/unit` = **1918 pass /
0 fail**.

### Scope decisions taken during implementation

- **T6-backstop (deterministic rule-citation demote) DEFERRED** — per the investigation's own
  recommendation ("ship Option 1 [the prompt directive] alone first; add the deterministic
  backstop only if field data shows the directive is insufficient"). The prompt directive
  attacks the root cause at zero risk; the regex-demote backstop adds schema + report-writer
  surface for a marginal, lower-confidence gain. Revisit if F-004-class hallucinations recur.
- **T7 cap value = 240s (conservative)** — memory records real reviews at ~130-185s, so a
  120s cap (the investigation's first suggestion) would clip legitimate reviews. 240s bounds a
  STALLED reviewer while never clipping a genuine one; tune `reviewerTimeoutCapMs` lower per
  repo if reviewers are known-fast. The panel-narrowing lever (Option B) stays rejected.
- **Residual escalated to the human (rec #3 deep half):** the gate runs at turn-end and has no
  authority over a later user push; the "deep review BEFORE push-to-deploy" guarantee belongs
  in a **pre-push / CI hook** that consults `.reviewgate/state.json` for a recent full-panel
  PASS on the pushed SHA. Not built this batch — surfaced for a separate decision.

### Verification

`bunx tsc --noEmit` clean · `bun run lint` clean · `bun test tests/unit` = **1911 pass / 0
fail**. New tests: self-refutation, review-prompt-rule-citation, report-writer-advisory (T2),
report-writer-folded-concerns, aggregator-protect-high-precision, provider-precision (min-
samples), loop-driver-preliminary-pass, report-writer-low-trust-collapse, triage-matrix (T7),
orchestrator-timeout-cap. All new flags `z.boolean().optional()` + `defaults.ts` (default ON).
