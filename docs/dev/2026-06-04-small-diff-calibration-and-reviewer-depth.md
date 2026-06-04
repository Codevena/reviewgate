# Small-Diff Calibration & Reviewer-Depth — Remediation Plan

> **For agentic workers:** This is a milestone/slice roadmap (effort + risk + acceptance),
> NOT a task-by-task TDD plan. When a slice is picked up for implementation, expand it into a
> full `superpowers:writing-plans` TDD plan (or implement inline with TDD). Steps use checkbox
> (`- [ ]`) syntax so progress can be tracked.

**Goal:** Make Reviewgate proportionate on *small, low-risk* diffs and *better-grounded* on
diffs that touch unchanged collaborators — without re-introducing the fail-open /
reviewer-hostage failure modes earlier hardening fixed.

**Trigger:** Field report from an external agent on a production project. Three trivial layout
fixes (+15/−13 lines, 3 files) ran **3 iterations × 4 reviewers × ~250–360 s ≈ 15+ min** and
then ESCALATED. The gate **did** catch two real, mobile-breaking CSS-chain bugs that tsc/eslint
missed (genuine value) — but the cost was wildly disproportionate to the change, the visual
review was blind (no rendering), one finding was based on an unverified premise
(`Card` "might not be flex" — `card.tsx:7` is hard `flex flex-col`), the escalation report was
stale, and several WARNs were cosmetic.

**Relationship to prior work:** Complements
`docs/dev/2026-06-03-convergence-scope-remediation.md` (single-reviewer noise calibration;
S0/S1/S6/S7 already merged — master `5af3a38`). That plan fixed *noise* and *self-contradiction*
under a 1-reviewer panel. This plan is orthogonal: it fixes *cost-proportionality on small
diffs*, the *count-only convergence heuristic*, the *stale escalation report*, *premise
verification* against unchanged collaborators, and *concern-mixing in one finding*. No overlap
with S6 grounding (that catches fabricated tokens *inside* the corpus; N5 here is about files
*missing* from the corpus).

---

## Triage ledger — verified against the code (4 read-only investigation agents)

| Field-report claim | Verdict | Evidence (file:line) |
|---|---|---|
| Effort/benefit skewed on small changes; no size/severity gating | ✅ **confirmed** | `triage` computes `budgetTier`+`loopCap` (`schemas/triage.ts:11-12`, `triage/matrix.ts:38-112`) but **both are dead** — `loop-driver.ts:590` uses global `config.loop.maxIterations` (default 3, `defaults.ts`). `totalAdded/totalRemoved` are computed (`diff-facts.ts:77-78`) and **never read** by triage. |
| No visual/runtime verification; CSS guessed; `gap-3` misread | ✅ confirmed | CLI reviewer adapters are text-in/text-out — **cannot consume images**. Reviewers see only diff text; `gap-3`(12px) vs `gap-6`(24px) is never resolved. |
| Reviewers read codebase too flat ("Card might not be flex") | ✅ confirmed | `collectChangedFileContents` (`utils/git.ts`) returns only **changed** files; adjacent/imported collaborators (`card.tsx`) are never in the corpus, so the premise is unverifiable. Grounding S6 catches invented tokens *in* the corpus, not files *missing* from it. |
| Escalation "findings not decreasing" too coarse (count 2→3→6 = approach churn) | ✅ confirmed | `loop-driver.ts:630` `progressing = lastReal < prevReal` — pure **real-finding count**. No signature-recurrence, no severity trend. |
| ESCALATION.md stale (shows iter-start findings already fixed) | ✅ confirmed | `escalate()` (`loop-driver.ts:1266,1295`) reads `pending.json` as a precondition (before decisions are applied) and passes those raw findings to the report. The earlier `b862cc7` fix only populated the (previously empty) section; it did not apply decisions. |
| Severity inflation + mixed concerns under one finding ID | ✅ confirmed | `aggregator.ts` merges different-category findings under one representative (one `severity`, one `category`; `schemas/finding.ts:23-24`) and only warns "dispositions ALL of them" (`aggregator.ts:313-315`). |
| No off-ramp before escalation (only accept / reject-as-FP) | ✅ confirmed | `schemas/decision.ts`: verdicts are only `accepted`/`rejected`. `deferred-with-followup` still counts as accept + recurrence-flag. No "acknowledge low-value, proceed". |

**Self-criticism in the report (kept in view):** the agent admits a good part of the loop was
its own doing (fragile flex layouts on a broken height-chain) and that the gate *correctly* and
repeatedly caught the regressions and pushed it to the right fixed-height approach. So the gate
**worked**; the path was expensive. The remediation must reduce cost and blindness **without**
weakening the net that caught the real bugs.

---

## Design constraints that MUST hold (regressions if violated)

- Do **not** re-introduce fail-open: 0 successful reviewer runs → ERROR, not PASS
  (`orchestrator-fail-closed`).
- Do **not** weaken the security/correctness-CRITICAL hard-FAIL: it must stay blocking after
  every demote pass (`aggregator.ts`), except the *existing* grounding demote.
- Do **not** convert any `ALLOW_STOP_ESCALATIONS` member into a hard block (reviewer-hostage
  runaway — see memory `reviewer-fp-runaway-loop`).
- Keep config a plain object hashed into the cache key; any new **review-content** knob lands in
  `ConfigSchema` + `defaults.ts` + serialize round-trip + behavior-hash. A knob that only affects
  the **iteration cap** (not review content) does NOT need to feed the cache key.
- Verify provider/prompt changes against a **real CLI call**, not just stubs (memory
  `feedback_real_verification` — stubs hid 8+ bugs).
- The repo **dogfoods itself**: these changes will be reviewed by the gate on the implementing
  turn. Expect to drive the FAIL→fix→re-review loop on our own diff.

---

## Build status — 2026-06-04

**N1, N3, N4, N5, N6 IMPLEMENTED (TDD)** — `bunx tsc --noEmit` clean, `bun run lint` clean,
`bun test` 1453 pass / 0 fail. NOT committed; dist binary NOT rebuilt (the
`~/.local/bin/reviewgate` symlink deploys to ALL repos — awaiting Markus). Remaining DoD:
the N5 **real-CLI premise check** (a live reviewer confirming the false premise vanishes) is
owed — the orchestrator integration test proves the injection end-to-end with a stub reviewer,
but a real codex/agy run is the repo's verification standard. **N2 (off-ramp) and N7 (UI/CSS
block) deferred** to their own PRs with the design fixed below.

Files touched: `schemas/triage.ts`, `triage/matrix.ts`, `schemas/state.ts`,
`core/orchestrator.ts`, `core/loop-driver.ts`, `core/aggregator.ts`, `core/report-writer.ts`,
`cache/behavior-hash.ts`, `config/define-config.ts`, `config/defaults.ts`,
`research/imports.ts` (export), **new** `research/collaborators.ts`. New/updated tests:
`triage-matrix`, `loop-driver` (N1 cap, N3 convergence, N4 report), `report-writer` (N4),
`aggregator*` (N6 + 3 updated), `behavior-hash` (N5), **new** `collaborators` +
`orchestrator-collaborator-context`, `review-prompt-git-context` (N5 preamble).

## Slices

Effort: **S** ≈ ½ day · **M** ≈ 1–2 days · **L** ≈ 3+ days. Each slice is independently
shippable and independently testable. **N1, N3, N4, N5, N6 are in scope for the current
build** (user decision 2026-06-04); **N2, N7 are planned-next** with the design fixed below.

### N1 — Size/risk-tiered iteration cap · **M** · medium risk · BUILD NOW

**Problem:** A 15-line low-risk CSS fix gets the same 3-iteration soft cap (6 hard) as a
500-line auth refactor. `triage.loopCap` exists but is dead.

**Change (non-regressing override, NOT a rewrite of the cap model):**
- `schemas/triage.ts` — add `maxIterationsOverride: z.number().int().positive().nullable()`
  (default `null` ⇒ "use config"). Keep the existing `loopCap` field documentary for now.
- `research/diff-facts.ts` is unchanged (`totalAdded/totalRemoved` already present).
- `triage/matrix.ts:triageFromFacts` — for a **small** diff
  (`totalAdded + totalRemoved ≤ SMALL_DIFF_LINES`, default **30**) in a **low-risk** tier
  (`default` or `minimal` — i.e. NOT `sensitive`, NOT `docs`), set
  `maxIterationsOverride: SMALL_DIFF_MAX_ITERATIONS` (default **2**). Sensitive/docs/standard-large
  diffs keep `null`. Constants exported from `matrix.ts` (cap is not review-content → no cache
  hashing needed). `2`, not `1`: one round to find, a second to verify the fix landed clean.
- Persist the override so the cap precondition (which runs in `LoopDriver` *before* the next
  iteration, where triage isn't recomputed) can read it: add
  `max_iterations_override: z.number().int().positive().nullable().default(null)` to
  `ReviewgateStateSchema`; the orchestrator returns the triage decision in `IterationResult`
  (or just the override), and `LoopDriver` writes it into state at the same point it appends
  `signature_history`/`iteration_stats`.
- `loop-driver.ts:590` — `const maxIter = Math.min(this.i.config.loop.maxIterations,
  state.max_iterations_override ?? Infinity)`. The hard cap stays `maxIter * 2`. Everything
  else (convergence, stuck, fp-streak) is unchanged and still bounds the loop.

**Acceptance:**
- Unit (`matrix.test.ts`): a 12-line `.tsx`-only diff → `maxIterationsOverride: 2`; a 12-line
  `auth/…` diff → `null` (sensitive stays heavy); a 400-line `.ts` diff → `null`.
- Unit (`loop-driver` convergence test): with `max_iterations_override: 2` and a
  non-progressing 2-iteration history → escalates at iteration 2 (not 3). With `null` →
  escalates at the config cap (unchanged).
- `bun test` green; state round-trips the new field (back-compat default `null`).

**Risk:** A genuinely tricky 15-line bug gets only 2 rounds before escalation. Mitigated:
escalation is loud + the agent can re-arm with a commit; sensitive paths are exempt; the cap is
a *soft* cap (a converging loop still runs to the hard cap `2×`). Severity is never weakened.

---

### N3 — Convergence by signature-recurrence + severity trend (not raw count) · **M** · medium risk · BUILD NOW

**Problem:** `progressing = lastReal < prevReal` reads raw real-finding count. When the agent
switches approach (flex→fixed), the reviewers see *different* findings each round; the count
rises (2→3→6) though the code is converging. The heuristic confuses "code not converging" with
"reviewer attention not converging".

**Change (augment `progressing`, never weaken the hard backstops):** treat the loop as
progressing if ANY of:
1. `lastReal < prevReal` (existing — fewer real findings), OR
2. **recurring-set shrinking**: `|lastSigs ∩ prevSigs| < |prevSigs ∩ prevPrevSigs|` is overkill;
   simpler and sufficient — the count of signatures that **persist** from the previous reviewed
   round into the latest one is strictly fewer than the previous round's real count
   (`recurring(last,prev) < prevReal`) — i.e. the *persistent* issues are being cleared even as
   new ones appear, OR
3. **severity improving**: the max severity present strictly drops across the last two reviewed
   rounds (any-CRITICAL → no-CRITICAL, else CRITICAL-count strictly down), OR
4. `lastReal === 0 && fpStreakOn` (existing).

Data sources already persisted: `state.signature_history[k]` (per-round signature sets) and
`state.iteration_stats[k]` (`{critical,warn,info}`). Compute over the two most-recent **reviewed**
rounds (reuse the existing `reviewedIdx` skip-ERROR-rows logic, `loop-driver.ts:613-619`).
Severity uses `iteration_stats`; the latest row backfills from live `pending.json` counts the way
`escalate()` already does.

Also: when the cap escalation *does* fire, label the **reason** with the diagnosis —
`"real findings not decreasing (N recurred from the prior round)"` vs
`"findings changed between rounds (approach churn) but severity did not improve"` — so the human
reads the right story (the report-stale fix N4 surfaces this).

**Acceptance:**
- Unit: history where round2 fully replaces round1's signatures (no overlap) and severity flat →
  `progressing = true` via rule 2 (don't escalate at the soft cap). Backstopped: still escalates
  at the hard cap.
- Unit: round2 has the SAME signatures as round1, same severity → `progressing = false`
  (escalate) — the genuine-stall case, unchanged outcome.
- Unit: round2 count rose but max severity dropped CRITICAL→WARN → `progressing = true` via
  rule 3.
- Regression: the existing `lastReal < prevReal` path still passes.

**Risk:** A loop that churns forever without improving could run to the hard cap (`2×`) instead
of the soft cap — bounded, but more rounds. Acceptable: the hard cap, stuck-signatures,
reject-rate, fp-streak, and cost-cap all still fire. We deliberately do NOT let pure churn extend
past the hard cap.

---

### N4 — Escalation report reflects post-decision state · **S** · low risk · BUILD NOW

**Problem:** `escalate()` (`loop-driver.ts:1266`) reads `pending.json` (pre-decision) and renders
those findings as "Final findings (last iteration)". By escalation time the agent has often
written `decisions/<iter>.jsonl` fixing/rejecting them, so the report shows already-resolved bugs
as open.

**Change:**
- New helper next to `priorIterationDecisionSignatures` (`loop-driver.ts:130`):
  `lastDecisionsById(repoRoot, iter): Map<string, DecisionEntry>` — the last-wins decision per
  finding_id from `decisions/<iter>.jsonl` (reuse the existing parse/never-throws pattern).
- In `escalate()`, after reading `pending`, join each finding to its decision and bucket:
  **addressed** (accepted/fixed or addressed-elsewhere/deferred), **rejected** (with reason),
  **open** (no decision). Pass the enriched list to `writeEscalation`.
- `report-writer.ts:writeEscalation` — render "Final findings" with a per-finding **status**
  (`✓ addressed` / `✗ rejected: <reason>` / `● open`) and a one-line summary
  `"N open · M addressed · K rejected (as of the latest decisions)"`. Open findings sort first.

**Acceptance:**
- Unit (`report-writer` or a `loop-driver` escalate test with fixtures): pending has F-1,F-2,F-3;
  `decisions/<iter>.jsonl` marks F-1 fixed, F-2 rejected, F-3 absent → the escalation report shows
  F-1 ✓, F-2 ✗(reason), F-3 ● open, and the summary "1 open · 1 addressed · 1 rejected".
- Regression: with NO decisions file, all findings render `● open` (today's behavior, just
  labelled).

**Risk:** Low (read-only join + render). Never throws (decision read is best-effort → all-open).

---

### N5 — Adjacent-collaborator context + premise-verification directive · **M/L** · medium risk · BUILD NOW

**Problem:** Reviewers get only the **changed** files. A finding whose premise lives in an
unchanged collaborator (`Card` is/ isn't a flex container, defined in `card.tsx`) cannot be
verified, so confident-but-wrong findings fire on unread premises.

**Change (two coordinated parts):**

**(a) Inject imported-collaborator source as trusted research context.**
- New module `src/research/collaborators.ts`:
  `collectCollaboratorSources(repoRoot, changedFiles, opts): { path, content }[]`. For each
  changed file, extract its **first-party import targets** (reuse the import-extraction in
  `src/research/imports.ts` / `symbol-graph.ts` `getLanguage`), resolve them to repo paths
  (respect `tsconfig` path aliases the contextDocs work already parses), read the (unchanged,
  not-in-diff) ones, dedupe, and **byte-budget** the total (default ~6 KB, smallest-first) so a
  fan-out can't blow the prompt. 1-hop only (YAGNI).
- `research/research-writer.ts` — accept an optional `collaborators` input and render a trusted
  `## Imported collaborators (unchanged — read before asserting about them)` section with each
  file fenced and path-labelled, before the diff fence.
- `core/orchestrator.ts` — gate behind the new opt-in config flag (below), call the collector
  after the symbol-graph step, pass it to the research writer, and **fold its corpus identity
  into `computeBehaviorHash`** (new `collaborators` segment) so changing a collaborator
  invalidates the cached verdict (the B2a cache-bug class).
- Config: `phases.review.collaboratorContext: { enabled: boolean, maxBytes?: number,
  maxFiles?: number } | null` (default `null` = off), mirroring the `contextDocs` opt-in pattern
  in `config/define-config.ts`. Default OFF (cost/size); the dogfood + UI repos opt in.

**(b) Premise-verification directive in the reviewer preamble.**
- `orchestrator.ts` `REVIEW_PROMPT_PREAMBLE` (~:168-194) — add: *"If a finding's premise can be
  confirmed or refuted by a file you were given (the changed files or the imported-collaborators
  section), VERIFY it before reporting. Do not assert a property of a symbol (e.g. 'X is not a
  flex container', 'Y is undefined') that the provided source contradicts. If the deciding file
  was NOT provided to you, say so explicitly and lower your confidence rather than asserting."*
- This is *guidance* (prompt-level), not a hard aggregator drop. The existing grounding pass (S6)
  remains the deterministic backstop for fabricated tokens.

**Acceptance:**
- Unit (`collaborators.test.ts`): a changed `Widget.tsx` that imports `./card` →
  `collectCollaboratorSources` returns `card.tsx`'s content (when unchanged), respects `maxBytes`
  (drops largest first), and never includes a file already in the diff.
- Unit (`research-writer`): given collaborators, the rendered research contains the fenced
  `card.tsx` under the collaborators heading, before the diff.
- Unit (`behavior-hash`): adding/altering a collaborator's content changes the hash.
- Unit (preamble): the assembled prompt contains the premise-verification sentence when the
  feature is on.
- **Real-CLI check** (per the verification rule): one live review on a fixture where a finding's
  premise lives in an imported file → the reviewer no longer fires the false premise.

**Risk:** Prompt/corpus growth (cost) — bounded by the byte budget + opt-in default-off. Import
resolution is best-effort (alias edge cases) → fail-open to "no collaborators", never crash the
gate. Could leak an unchanged file's *pre-existing* issue into scope — mitigated: the preamble's
"report issues INTRODUCED OR AFFECTED BY THIS diff … pre-existing issues in unchanged code are
out of scope" (already present, `orchestrator.ts:185-186`) still governs; collaborators are
*reference*, not review surface.

---

### N6 — One concern per finding (don't merge across category boundaries) · **S/M** · low-med risk · BUILD NOW

**Problem:** The aggregator clusters co-located findings of **different categories** (correctness
+ quality) under one representative with one severity, and only appends a "this finding merges
concerns … your decision dispositions ALL of them" note (`aggregator.ts:313-315`). One decision
must address a real bug AND a cosmetic nit together; severity inflates to the max.

**Change (merge-guard, the minimal correct fix):**
- `core/aggregator.ts` clustering (`~:239-299`) — before merging a candidate into a cluster,
  compute the would-be category set. If it would mix a **high-stakes** category
  (`security` or `correctness`) with a **non-high-stakes** one (`quality`/`docs`/`testing`/etc.),
  **do not merge** — keep them as separate representatives. Co-located findings of the *same*
  stakes-class still merge (today's dedup behavior for genuine duplicates is preserved).
- Keep the existing multi-category note for the *remaining* legitimately-merged cases (e.g.
  correctness + architecture, both high-stakes-ish) — but those no longer bury a cosmetic nit
  under a CRITICAL.

**Acceptance:**
- Unit (`aggregator.test.ts`): two co-located findings, one `correctness`/CRITICAL and one
  `quality`/WARN → **two** findings out (not one merged CRITICAL); the cosmetic one keeps its WARN
  and its own decision id.
- Unit: two co-located `correctness` findings (same stakes) from two providers → still merge
  (consensus/dedup unchanged).
- Regression: the multi-category note still renders for any cluster that legitimately retains
  >1 category.

**Risk:** Slightly more findings surface (each now individually dispositioned) — that is the
point (clean disposition). Could split a genuine single issue a reviewer happened to tag with two
categories — acceptable: separate INFO/WARN lines are cheaper to disposition than a forced bundle,
and consensus still merges same-category duplicates.

---

### N2 — Off-ramp verdict `acknowledged-low-value` · **S/M** · medium risk · PLANNED NEXT (design fixed)

**Decision (2026-06-04): conservative-bounded.** Add `action: "acknowledged-low-value"` to the
**accepted** decision branch (`schemas/decision.ts`), accepted by the decisions-gate as a valid
disposition, but VALID ONLY when the finding is `severity ∈ {INFO, WARN}` AND
`category ∉ {security, correctness}`. An acknowledged finding: counts as addressed (does not
block, does not re-escalate), is **logged** (audit event), does **not** suppress recurrence beyond
the current cycle (no permanent FP-pin — it is not a false positive), and still counts toward the
reject-rate / fp-streak denominators so it can't be used to silently defeat those breakers. A
CRITICAL, or any security/correctness finding, **cannot** be acknowledged — those stay blocking.
This keeps the gate's core promise (real bugs cannot be waved away) while giving a sanctioned
"noted, not now" for cosmetic nits. Build after N1 (N1's lower cap already removes most of the
pain that motivated the off-ramp). Touches `schemas/decision.ts`, `loop-driver.ts`
(`evaluateDecisions` validation of the new action against the finding's severity/category — needs
the finding lookup), `core/aggregator.ts` (don't recurrence-pin an acknowledged signature),
`report-writer.ts`, and `docs/AGENTS.md` + the global CLAUDE.md protocol snippet.

### N7 — Static CSS/Tailwind fact block · **L** · medium risk · PLANNED NEXT (design fixed)

**Decision (2026-06-04): static text block, no browser.** Opt-in `phases.review.uiAnalysis`
(default `null`). A new `src/research/ui-analysis.ts` detects changed `.tsx/.jsx/.css/.scss`
files, extracts Tailwind class tokens (regex) + CSS custom properties, resolves the tokens to
computed values against the repo's `tailwind.config.*` when present (`gap-3 → 0.75rem (12px)`,
`gap-6 → 1.5rem (24px)`, `flex-col → display:flex; flex-direction:column`, `h-screen →
height:100vh`) and a small built-in default-scale fallback, plus a JSX layout-semantics sketch,
injected as a trusted `## UI/CSS facts (static)` research block before the diff. Deterministic →
feeds `computeBehaviorHash`. Directly fixes the `gap-3`-misread class of error and the
"flex behavior guessed" subjunctive findings **without** a browser, dev-server knowledge, or
images (CLI adapters cannot consume images). **Full Playwright/screenshot rendering is OUT OF
SCOPE** (no dev-server discovery, headless sandbox, project-script-execution security,
~300 MB binary bloat) — a separate spike-doc may revisit it. ~500 LoC; mirror the `contextDocs`
opt-in + behavior-hash + budget pattern.

---

## Recommended sequencing (current build)

1. **N4** (stale report) — smallest, isolated, no schema churn beyond a render change. Warm-up.
2. **N1** (size cap) — schema + triage + state + one `min()` in the cap precondition.
3. **N3** (convergence heuristic) — same file as N1's cap change; do together.
4. **N6** (merge-guard) — isolated to the aggregator clustering.
5. **N5** (collaborator context + premise) — largest; new module + research/orchestrator/config
   + behavior-hash + real-CLI verify. Last.

N2 and N7 follow in their own PRs with full TDD plans + real-CLI verification.

## Open decisions — RESOLVED 2026-06-04

- **Scope this session:** N1 + N3 + N4 + N5 + N6 (calibration + reviewer accuracy). N2, N7 deferred.
- **Off-ramp (N2):** conservative-bounded (INFO/WARN, non-security/correctness, logged,
  cycle-scoped, counts toward breakers).
- **Visual (N7):** static CSS/Tailwind text block, opt-in; no Playwright now.

## Self-review (against the field report)

- All 7 report problems map to a slice (N1–N7); none orphaned.
- The two real bugs the gate caught (height-chain collapse, mobile flex invisibility) stay
  catchable: no severity weakening, no security/correctness demote, grounding untouched.
- N1's cap is a *soft* cap with the hard backstop, stuck-detection, cost-cap, fp-streak all
  intact — no fail-open, no runaway.
- N3 only *augments* `progressing`; the genuine-stall case (same signatures, flat severity) still
  escalates exactly as today.
- N5 collaborators are reference-only; the existing "pre-existing issues out of scope" preamble
  still bounds review surface.
- New identifiers (`maxIterationsOverride`, `max_iterations_override`,
  `collectCollaboratorSources`, `collaboratorContext`, `lastDecisionsById`,
  `SMALL_DIFF_LINES`, `SMALL_DIFF_MAX_ITERATIONS`) are used consistently across the slices.
