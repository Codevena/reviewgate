# Convergence, Scope & Single-Reviewer Calibration — Remediation Plan

> **For agentic workers:** This is a milestone/slice roadmap (effort + risk + acceptance),
> NOT a task-by-task TDD plan. When a slice is picked up for implementation, expand it
> into a full `superpowers:writing-plans` TDD plan under `docs/superpowers/plans/`. Steps
> use checkbox (`- [ ]`) syntax so progress can be tracked.

**Goal:** Make Reviewgate *converge* and stay *low-noise* on low-risk diffs — without
re-introducing the fail-open / reviewer-hostage failure modes that earlier hardening fixed.

**Trigger:** Field report from an external agent (a11y quick-win PR + throwaway audit
tooling, single-reviewer deployment). Two gate runs, neither reached a clean PASS; both hit
the 3-iteration cap and escalated (`4→9→6→9` ESCALATE max-iterations; `8→9→7→5` ESCALATE
reviewer-fp-streak). ~8 iterations + dozens of decisions to land a low-risk change.

**Relationship to prior work:** Overlaps the 17-issue roadmap in
`docs/dev/2026-06-03-multi-agent-feedback-remediation.md` (I-16/I-17/F-003/F-033 there are
already in code). This plan is the **calibration layer** on top: it does not re-fix fail-open;
it addresses *noise, non-convergence, and single-reviewer collapse*.

---

## Root cause the field report could not see: single-reviewer collapse

The report's framing — "threshold too aggressive, no convergence/scope discipline" — is only
half right. The discipline mechanisms **exist**; the deployed config (the scaffold default of
**one primary reviewer** + failover chain, PR #36) **structurally disabled three of the four
noise-suppression layers**, because each one is gated on having ≥2 independent providers:

| Suppression layer | Gate | With 1 reviewer |
|---|---|---|
| Consensus demote (`aggregator.ts:303`, `:375`, `:498`) | needs `majority`/`unanimous` (≥2 reviewers) | **inert** — every finding is `singleton`, nothing is ever corroborated |
| `confidenceFloor` demote (`aggregator.ts:477-524`) | only demotes **uncorroborated** findings, floor `0.3` (`defaults.ts:71`) | the *only* live gate, and `0.3` barely demotes |
| FP-ledger promotion (`fp-ledger/store.ts:54-55`) | `active` needs `≥3 rejects AND distinct providers ≥2`; `sticky` needs `≥5 AND ≥2` | **never reaches `active`** — `distinct(...)` counts providers (`store.ts:50`), forever 1 → the `hsl()` FP recurs every session |
| Reputation demote | per-provider history, demotes lone non-security | partial only |

So the recurring `hsl()` false positive, the non-convergence, and the "every lone nitpick
blocks" are all the **same** structural cause: a single reviewer defeats consensus, defeats
the FP-ledger, and leaves a low confidence floor as the only brake. Raising "the threshold"
treats the symptom. The real levers are **(A) make single-reviewer deployments suppress
noise on their own**, and **(B) steer users toward ≥2 reviewers**.

---

## Triage ledger — do NOT rebuild what already exists

| Report claim | Verdict | Evidence |
|---|---|---|
| Non-convergence / moving goalposts | Symptom real; **guard exists** | `loop-driver.ts:544,581` convergence on real-findings-not-decreasing. Root cause = single-reviewer noise, not a missing guard. |
| Self-contradiction across iterations (quiz catch: 3 directions) | **GENUINE GAP** → Slice 1 | Per-cycle suppression (`orchestrator.ts:152`, fp few-shot `:838`) is **signature-keyed**; an opposite-direction finding on the same lines has a different signature → not suppressed. |
| `hsl()`-vs-hex FP recurs across sessions | **GENUINE GAP** → Slice 3 | FP-ledger promotion needs `distinct providers ≥2` (`store.ts:54-55`), unreachable single-reviewer. |
| Scope leak on gitignored/generated | **Partly WRONG** | `.gitignore`d files ARE excluded (`git.ts:195`, `--exclude-standard`). Untracked **non-ignored** throwaway IS included via `--no-index` → Slice 2. |
| Untouched file → CRITICAL | **GENUINE GAP** → Slice 5 | `scopeFindings` security escape hatch (`aggregator.ts:213-216`) keeps a security finding on a **file not in the diff at all** blocking. Meant for in-file-near-hunk (F-033), over-applied to file-absent branch. |
| "Dangerous silent escalation" | **MISFRAMED** → Slice 4 (UX only) | `reviewer-fp-streak` is **deliberately** allow-stop-with-loud-banner (`loop-driver.ts:50`, `:1174-1185`) — blocking would hold the dev hostage to a noisy reviewer (documented). NOT a fail-open. Banner wording reads as approval → reword, do **not** block. |
| Cost asymmetry (6–12 min/round) | Real | 12-min cap + single slow primary timing out. `maxIterations:3` (`defaults.ts:120`). |
| Severity inflation (plural nitpick @WARN) | Real | floor `0.3` + single reviewer → Slice 0. |

**Design constraints that MUST hold (regressions if violated):**
- Do **not** convert `reviewer-fp-streak` allow-stop into a hard block (re-introduces the
  reviewer-hostage runaway loop — see memory `reviewer-fp-runaway-loop`, `failover-only-quota`).
- Do **not** weaken security-CRITICAL: it must stay blocking even after every demote pass
  (`aggregator.ts:498`, `:43-44`).
- Do **not** re-introduce fail-open: 0 successful reviewer runs → ERROR, not PASS.
- Keep config a plain object (hashed into the cache key); any new knob lands in
  `ConfigSchema` + `defaults.ts` + serialize round-trip.

---

## Slices (prioritized)

Effort: **S** ≈ ½ day · **M** ≈ 1–2 days · **L** ≈ 3+ days. Each slice is independently
shippable and independently testable.

### Slice 0 — Single-reviewer-aware defaults + doctor warning · **S** · low risk

**Problem:** A single-reviewer deployment silently disables 3 of 4 suppression layers, and
the floor is too low for the one layer that still runs.

**Changes:**
- `src/config/defaults.ts:71` — raise `confidenceFloor` `0.3 → 0.6`. (Uncorroborated <0.6
  → INFO/advisory; security-CRITICAL and corroborated findings stay exempt, already coded.)
- `src/cli/commands/doctor.ts` — add a check next to `reviewersEnabledCheck` (`:46`): when
  the count of **enabled** reviewers ≤ 1, `status:"warn"` with detail "Single reviewer:
  consensus, FP-ledger promotion, and reputation demote are all inert; expect more lone-finding
  noise. Add a 2nd provider in `phases.review.reviewers`, or rely on Slices 0/3 single-reviewer
  paths." Reuse the enabled-set computation already in `reviewersEnabledCheck`.

**Acceptance:**
- A repo with 1 enabled reviewer prints the new `warn` line in `reviewgate doctor`.
- `bun test` green; a unit test asserts the floor default is `0.6` and the doctor warning
  fires at `reviewers ≤ 1` and is silent at `≥ 2`.

**Risk:** Higher floor could demote a real lone WARN to advisory. Mitigated by the existing
security-CRITICAL exemption and by Slice 1 (the genuine lone finding still appears once, just
non-blocking). **Decision needed (see Open Decisions):** floor `0.5` vs `0.6` vs `0.7`.

---

### Slice 1 — Cross-iteration "already adjudicated" prompt memory · **M** · medium risk

**Highest-value slice.** Kills the self-contradiction (quiz catch arguing 3 directions) at the
source: the reviewer re-derives from scratch each iteration with no memory of prior dispositions.

**Problem:** Suppression today is *post-hoc* and *signature-keyed* (`aggregator.ts` +
`cycleRejectedSignatures`). A reviewer that flags the *opposite* of last round ("now remove
the catch") produces a **new signature on the same lines** → not suppressed → re-litigation.

**Change:** Inject *pre-hoc* trusted context into the reviewer prompt — a new section beside
the existing "Known false positives" block (`orchestrator.ts:838`):

```
## Already adjudicated this cycle (TRUSTED — do not re-litigate)
- quiz.ts:40-45 — round 2: you asked for res.ok + Promise.allSettled; the agent ADDED it.
  Do not re-flag this region unless you find a NEW, distinct issue.
- quiz.ts:52 — round 3: rejected (reviewer_was_wrong): "TS narrows discriminated unions".
```

- Data source: prior `decisions/<iter>.jsonl` + `pending.json` (LoopDriver already reads
  these for the decisions-gate). Thread them into `runIteration({...})` as a new
  `priorAdjudications` field on `IterationRunner` (mirror the existing
  `cycleRejectedSignatures` / `claimedFixedSignatures` plumbing at `orchestrator.ts:152-156`).
- Render file:line-range + disposition (`fixed` / `rejected:<reason>`) per finding.
- Behavior-hash the rendered block into the cache key (so a changed adjudication set re-runs
  the panel deterministically — same pattern as fp few-shot).

**Acceptance:**
- Integration test: a 2-iteration cycle where round 1 rejected finding X on lines L; round 2's
  reviewer stub is handed the prompt → assert the prompt contains the adjudication line for L.
- The opposite-direction-on-same-lines case no longer blocks a 3rd iteration in a fixture run.

**Risk:** Could suppress a *genuinely new* issue on the same lines. Mitigate: wording says
"unless you find a NEW, distinct issue"; keep CRITICAL exempt from any prompt-level
de-emphasis; this is *guidance*, not a hard aggregator drop (the aggregator still sees the
finding and applies normal gates). **Requires a brainstorm pass** on the exact wording so it
de-litigates without blinding the reviewer.

---

### Slice 2 — Triage-by-file-context for tooling/throwaway · **M** · medium risk

**Problem:** Untracked, non-gitignored throwaway (one-shot audit scripts) is reviewed with
full prod standards (prod-DB-guard, hardcoded-cred). There is no "this is tooling/scratch"
signal; `classify()` (`diff-facts.ts:29-37`) only knows code/docs/tests/config/lockfile.

**Change (config-driven, not heuristic-guessed):**
- Add `phases.review.toolingGlobs: string[]` to `ConfigSchema` + `defaults.ts` (default a
  small list: `["scripts/**", "**/*.audit.*", "tools/**"]`), mirroring `docReview.globs`.
- `diff-facts.ts` — add a `tooling` boolean to `DiffFacts` (any file matches a toolingGlob and
  the diff is tooling-only).
- `triage/matrix.ts:triageFromFacts` — when `tooling` (and not sensitive), return a new
  `riskClass:"tooling"` with `budgetTier:"minimal"`, `loopCap:2`, and a **tooling persona**
  that explicitly relaxes prod-deployment standards (no prod-DB / secrets-rotation findings on
  scratch scripts; keep real correctness + real secret-in-source).

**Acceptance:**
- Unit test: a diff touching only `scripts/audit-foo.ts` triages to `riskClass:"tooling"`,
  `loopCap:2`.
- The tooling persona reaffirmation (in `orchestrator.ts` `PERSONA_REAFFIRM`) demonstrably
  drops a prod-DB-guard finding in a fixture review while keeping a hardcoded-API-key finding.

**Risk:** A glob marks real production code as tooling → under-review. Mitigate: default
globs are conservative; `sensitive` tags still override to the heavier path
(`matrix.ts:` sensitivity branch runs *before* the new tooling branch).
**Requires brainstorm** on the persona wording and default globs.

---

### Slice 3 — FP-ledger promotion reachable for single-reviewer · **M** · medium risk

**Problem:** `recompute()` (`fp-ledger/store.ts:50-55`) gates `active`/`sticky` on
`distinct providers ≥ 2`. With one provider that is permanently unreachable → the ledger never
suppresses → the `hsl()` FP recurs across sessions despite being rejected every time.

**Change:** Make the distinct-provider requirement adaptive to the effective panel size.

```ts
// store.ts — pass effectiveProviderCount (= number of enabled reviewers) into recompute()
const distinctReq = Math.min(2, effectiveProviderCount);   // 1 reviewer → 1 ; ≥2 → 2 (unchanged)
if (win90.length >= STICKY_REJECTS && distinct(win90) >= distinctReq) stage = "sticky";
else if (win60.length >= ACTIVE_REJECTS && distinct(win60) >= distinctReq) stage = "active";
```

- Keep reject-count thresholds (`ACTIVE_REJECTS=3`, `STICKY_REJECTS=5`) — a single reviewer
  still must reject the *same signature* 3× over 60 d before it suppresses, which is the
  field report's exact scenario.
- Thread `effectiveProviderCount` from config through to the ledger store handle
  (`orchestrator.ts:347`).

**Acceptance:**
- Unit test: with `effectiveProviderCount=1`, 3 same-signature rejects from one provider over
  60 d → `active`; 5 over 90 d → `sticky`. With `=2`, the old `distinct ≥ 2` requirement holds
  (regression test on the multi-provider path).
- Integration: the `hsl()` signature, once `active`, appears in the few-shot suppression block
  and is demoted by the aggregator.

**Risk:** A single chronically-wrong reviewer self-certifies a *real* finding as FP after 3
rejects. Mitigate: security-CRITICAL signatures are never ledger-suppressible (verify the
existing security exemption covers the ledger path); the agent had to *actively reject with a
≥20-char reason* 3× for it to promote — that is strong evidence it's an FP. The
`distinct ≥ 2` rule stays for genuine multi-reviewer panels (its correlated-reviewer purpose).

---

### Slice 4 — Unmistakable allow-stop escalation banner · **S** · low risk

**Problem:** On `reviewer-fp-streak` the gate allow-stops with
`"…NOT blocking your turn…"` (`loop-driver.ts:1179`). The field agent read this as approval
("goes silent / could be read as clean"). The banner exists; its wording fails.

**Change (wording + protocol only — NO control-flow change):**
- `loop-driver.ts:1170-1185` — lead every allow-stop escalation reason with a hard
  non-approval marker, e.g.:
  `"⛔ Reviewgate · ESCALATED — THIS IS NOT A PASS. The review did not succeed; the gate has
  stopped gating because the reviewer panel is unreliable here (not your code). You MUST
  surface .reviewgate/ESCALATION.md to the human in your final message. Run \`reviewgate
  reset\` to re-arm."`
- Add the same "allow-stop-escalate ≠ approval; surface ESCALATION.md to the human" sentence
  to the Reviewgate protocol blocks in `docs/AGENTS.md` and the global CLAUDE.md snippet.

**Acceptance:**
- Unit test asserts the allow-stop reason string contains "NOT A PASS" and the
  surface-to-human instruction for each `ALLOW_STOP_ESCALATIONS` member.
- `docs/AGENTS.md` updated.

**Risk:** Low (string + docs). **Guardrail:** do NOT move `reviewer-fp-streak` out of
`ALLOW_STOP_ESCALATIONS` — blocking is the documented wrong fix.

---

### Slice 5 — Scope: stop out-of-diff-file security findings blocking · **S/M** · low-med risk

**Problem:** `scopeFindings` file-absent branch (`aggregator.ts:213-216`) honors the
security escape hatch for a finding on a file **not touched by the diff at all** → "pre-existing
file I never touched raised to CRITICAL." The hatch was designed for the *in-file-outside-hunk*
case (reviewer cites the enclosing declaration a few lines above the changed call, F-033).

**Change:** Split the escape-hatch policy by branch.
- **File-absent branch** (`aggregator.ts:206-225`, `if (!ranges)`): a security finding on a
  file with **no diff ranges at all** should NOT stay CRITICAL. Demote to **WARN** (not silent
  INFO — a real cross-file regression deserves visibility) with a note
  `"↓ in a file this change did not touch — verify it is actually introduced here"`. Keep the
  harness-config I-17 demote unchanged.
- **In-file-outside-hunk branch** (`:228-236`): keep the security escape hatch but bound it to a
  proximity window — only stay blocking if `f.line_start` is within ±N lines (N≈15) of a changed
  range (the "enclosing declaration just above the call" case). Beyond the window → demote.

**Acceptance:**
- Unit tests: (a) security finding on a file absent from `changedRanges` → demoted to WARN, not
  CRITICAL; (b) security finding 8 lines above a changed hunk in a changed file → stays
  blocking; (c) security finding 200 lines from any hunk in a changed file → demoted.
- Regression: the F-033 "enclosing declaration" case still blocks.

**Risk:** A genuine cross-file security regression introduced indirectly is downgraded to WARN
(still surfaced, not silently dropped). Acceptable: the common case is the FP; WARN keeps the
signal. **Decision needed:** WARN vs keep-CRITICAL-with-proximity-only.

---

## Recommended sequencing

1. **Slice 0** (config + doctor) — cheap, immediately reduces noise on the existing
   single-reviewer deployments, no behavior risk. Ship first.
2. **Slice 1** (cross-iteration memory) — highest value; kills the worst symptom
   (self-contradiction / non-convergence). Brainstorm wording first.
3. **Slice 3** (FP-ledger single-reviewer) — fixes the recurring-FP class; pairs naturally
   with Slice 0 (both are "make single-reviewer work").
4. **Slice 5** (scope security hatch) — bounded, removes the CRITICAL-inflation surprise.
5. **Slice 4** (banner wording) — trivial, do alongside any of the above.
6. **Slice 2** (tooling triage) — fuzziest; needs a brainstorm on detection + persona. Last.

Slices 0, 4, 5 can land in one PR (all small, no shared surface). Slices 1, 2, 3 each merit
their own PR + full TDD plan + real-CLI verification (per the repo's verification rule — stubs
hid 8+ bugs historically).

---

## Open decisions (for Markus)

- **D-1:** `confidenceFloor` target — `0.5` (gentle), `0.6` (recommended), or `0.7`
  (aggressive)? Higher = quieter but risks demoting real lone WARNs to advisory.
- **D-2:** Slice 5 out-of-diff-file security — demote to **WARN** (recommended, keeps signal)
  or keep CRITICAL but only within a proximity window?
- **D-3:** Should the scaffold default flip to **2 reviewers** (e.g. codex + one more) so new
  installs get consensus suppression out of the box, or stay 1-primary + rely on Slices 0/3?
  (Cost vs. quality tradeoff — 2 reviewers ≈ 2× review time/tokens.)
- **D-4:** Slice 2 default `toolingGlobs` — opt-in empty (safe, user must configure) vs. a
  conservative built-in list (`scripts/**`, `tools/**`)?

---

## Self-review (against the field report)

- Report's 3 genuine catches (design-token, security-hygiene, quiz error-handling) — **kept**:
  nothing here weakens correctness/security detection; only the noise floor and out-of-scope
  inflation move.
- Each of the report's 7 "broken" items maps to a slice or the triage ledger (no orphan claim).
- Single-reviewer root cause (the report's blind spot) is the spine of Slices 0/3 and D-3.
- No control-flow change to fail-closed/allow-stop semantics (Slice 4 is wording only) — the
  prior fail-open hardening (I-16, M-A0) is untouched.
- Type/field names introduced (`priorAdjudications`, `toolingGlobs`, `effectiveProviderCount`,
  `riskClass:"tooling"`) are used consistently across the slices that reference them.
