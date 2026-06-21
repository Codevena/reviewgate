# Field-Report Remediation — 2026-06-21

Two practitioner field reports from a production run (eBook feature-flag → GA on
flashbuddy/dealbarg) plus an 11-agent code-grounded investigation swarm. Each
problem below was verified against the **actual source** (with `/tmp` git/worktree
experiments where behavior was ambiguous), not assumed from the report.

**Governing principle (non-negotiable):** a suppressor/demoter MUST fail safe. A
fix that can silence a real CRITICAL (single reviewer hallucinates + agent rejects
once → a future real finding auto-hidden) is worse than the noise it removes. Every
slice below is judged against this. Several field requests are *deliberately not
implemented literally* because the literal form fails open — the safe equivalent is
shipped instead.

---

## Verdict table

| ID | Problem | Verdict | Effort | Risk | Tier |
|----|---------|---------|--------|------|------|
| **G0** | systemic: demoted-from-CRITICAL WARN can silently soft-pass (auto-hide) | **ship (opt-in this session)** | M | med | 0 |
| **G0b** | `cycleRejected` suppressor has no security/correctness ceiling | **ship (with G0)** | S | low | 0 |
| **P9** | init `.gitignore` root-anchored → nested `.reviewgate/` leaks | **ship** | S | low | 1 |
| **P10** | no monorepo/multi-app topology in reviewer context | **ship** | S | low | 1 |
| **P6** | no "valid finding, verified not-applicable" verdict | **ship** | M | low | 1 |
| **P11** | docs-only commit → harsh hard-FAIL CRITICAL, code framing | **ship** | S | low | 1 |
| **P4** | "PRELIMINARY (3 of 4)" PASS is non-deterministic & self-contradictory | **ship** | M | low | 2 |
| **P1** | sub-50%-precision reviewer solo-gates a CRITICAL | **ship (render-only)** | S | low | 2 |
| **P2** | N-times-rejected FP classes never auto-suppress (single-reviewer) | **render-only** (auto-suppressor rejected as fail-open) | S | low | 2 |
| **P5** | findings on "unchanged" code still gate | mostly-solved + tiny fix | S | low | 3 |
| **P3** | per-cycle finding-ID recycling / decision footgun | already-fixed + harden | S | low | 3 |
| **P7** | loop tax on small well-tested diffs | wontfix + document | S | low | 3 |
| **P8** | **worktree blindness — whole impl un-gated (Priority-1)** | design (Layer-1 now) | M | low | 4 |

Tiers = rollout sequence, not importance. P8 is the single biggest *coverage* gap;
its safe Layer-1 ships in Tier 4 only because the robust Layer-2 needs live
Claude-Code behavior verification first.

---

## Tier 0 — foundational (optional, verdict-path; enables the safe P1/P11 gating ask)

### G0 — a demoted-from-CRITICAL WARN must stay decision-required
**Root cause (surfaced by the Plan-Gate).** "Demote a CRITICAL one step → WARN" is a
pattern used by MULTIPLE shipped passes — `hypotheticalSeverityGuard`
(hypothetical-demote.ts) and the reputation pass (aggregator.ts) — and proposed by
P1/P11. Under the default `softPassPolicy:"allow"`, a demoted LONE WARN → singleton →
SOFT-PASS → allow-stop with **NO required decision** → the (possibly real) finding is
auto-hidden. This is a SYSTEMIC fail-open independent of any single feature, and it is
the reason P1, P11, and P2 all had to retreat to render-only/opt-in.

**Fix.** Make a demote that ORIGINATED at CRITICAL keep BLOCKING (decision-required)
even when the verdict is a SOFT-PASS:
- finding.ts: a generic `demoted_from_critical: true` flag (set by every CRITICAL→WARN
  demote — hypothetical, reputation, and any future precision/docs pass; the
  `hypothetical_demoted` flag already exists and is one such source).
- **Merged-member propagation (codex Plan-Gate):** the flag must survive dedup/merge.
  `Finding.members`/`memberOf()` do NOT today retain member severity, so a
  demoted-from-CRITICAL finding that merges UNDER an unflagged WARN representative would
  lose the flag. Fix: stamp an `original_severity` on every finding BEFORE any
  demote/merge, and make the aggregator's merge step set the representative's
  `original_severity = max(members' original_severity)` and OR the `demoted_from_critical`
  flags across members. G0 (and P2's "never originally CRITICAL" guard) then key on the
  propagated `original_severity`, not the live representative severity.
- loop-driver.ts required-decisions: a `demoted_from_critical` WARN is decision-required
  even under SOFT-PASS/allow-policy — the gate keeps blocking until the agent writes a
  decision for it. (Never silently allow-stops on a finding that was a CRITICAL.)
- decision gate: permit `acknowledged-low-value` for a `demoted_from_critical`
  NON-security/correctness WARN so the agent has a cheap honest off-ramp (1 line) — but
  NOT for security/correctness (those are never demoted to begin with).

**Effect.** (1) Closes the pre-existing hypothetical/reputation soft-pass fail-opens.
(2) Makes the field's literal P1 ask SHIPPABLE & safe: a low-precision lone CRITICAL can
then be demoted to a cheaper-to-dispose WARN that STILL requires a decision (lighter
label + `acknowledged-low-value` available, never auto-hidden). (3) Same for P11 docs.

**Fail-safe.** STRICTLY increases gating — a previously soft-passing demoted-from-CRITICAL
WARN now blocks until decided. Can only ask for MORE decisions, never fewer; no finding
can be auto-hidden. The only cost is friction (1 decision line vs 0) on
hypothetical/reputation demotes that today end the turn silently — an intentional
safety/friction trade.

**Cost/risk.** This touches the **verdict / required-decisions path** = the most
safety-critical code. Highest-rigor TDD + its own DoD review. It is OPTIONAL for this
remediation (the render-only batch ships without it); but it is the principled fix and
the only thing that lets P1/P11 satisfy the field's literal ask safely.

**Files.** finding.ts, hypothetical-demote.ts, aggregator.ts (reputation pass stamps
the flag), loop-driver.ts (required-decisions + decision-gate `acknowledged-low-value`
allowance). **Tests.** a lone hypothetical-/reputation-demoted CRITICAL→WARN keeps
blocking under allow-policy; `acknowledged-low-value` disposes it; security/correctness
never reaches this path (still hard-FAIL); existing soft-pass fixtures updated.

### G0b — `cycleRejected` needs a CRITICAL + security/correctness ceiling (related, smaller)
**Root cause (Plan-Gate).** The per-cycle `cycleRejected` suppressor (aggregator.ts:
~571–585) demotes any matching representative/member signature to INFO with NO
severity/category ceiling. It IS agent-gated (it only fires after the agent writes a
`reviewer_was_wrong` rejection) — but one false rejection then hides a LATER same-
signature CRITICAL (incl. security/correctness) for the rest of that cycle — including a
real hard-FAIL on `reviewersTotal<=1`. **Fix (codex):** a security/correctness-only guard
is NOT enough — cycleRejected must never demote to INFO a finding that IS or WAS
originally a CRITICAL, nor any security/correctness signature (guard on
`original_severity===CRITICAL || f.severity===CRITICAL || touchesSecurityOrCorrectness`);
those re-surface for an explicit per-iteration decision instead. Small, fail-safe (only
ever asks for MORE decisions). Depends on G0's `original_severity` plumbing; bundle with G0.

---

## Tier 1 — clear wins (disjoint files, parallelizable)

### P9 — `.gitignore` covers nested `.reviewgate/`
**Root cause.** `GITIGNORE_LINES` (init.ts:68–86) entries all lead with a literal
`.reviewgate/…` segment → anchored to the repo root only. A nested
`backend/.reviewgate/state.json` is never matched and auto-stages on `git add -A`.
Reproduced in a scratch repo. (Confirmed live: even this repo has untracked
`.reviewgate/brain/`, `learnings/`, `reputation.json`, `quota-cooldowns.json` that
the list never caught.)

**Fix (verified with `git check-ignore` at 3 depths).**
- Un-anchor every entry with a leading `**/`.
- Cassettes MUST use the **contents-form** `**/.reviewgate/cassettes/*` (NOT the
  dir-form `…/cassettes/`): a trailing-slash dir-exclude excludes the directory
  *node*, after which `!…/golden/` cannot re-include (git can't re-include a child
  of an excluded dir). Contents-form + `!**/.reviewgate/cassettes/golden/` keeps
  golden cassettes trackable at root AND nested (verified git-add-able without `-f`).
- Add the currently-missing artifacts: `**/.reviewgate/plan-review.*`,
  `**/.reviewgate/reputation.json`, `**/.reviewgate/quota-cooldowns.json`,
  `**/.reviewgate/learnings/`, `**/.reviewgate/brain/` (whole brain dir — its
  curated state is never committed; supersedes the two `brain/proposals|snapshots`
  lines).
- **Upgrade-path migration** (codex: this is a REWRITE, not append-only). A repo
  init'd before this change keeps the OLD root-anchored lines, and the stale
  `.reviewgate/cassettes/` dir-exclude would re-break ROOT golden tracking. The writer
  (init.ts:258–266) must: read `.gitignore`, FILTER OUT every line whose trimmed value
  is in an `OLD_GITIGNORE_LINES` set (enumerate the EXACT prior Reviewgate strings —
  the live `GITIGNORE_LINES` has **15** Reviewgate lines before the Antigravity block,
  including the stale `.reviewgate/cassettes/` dir-exclude) or the new set (dedup),
  **preserving ALL unrelated user lines and their order**, then append the new block,
  and write back via `writeFileAtomic` (tmp+rename — the current `.gitignore` write
  uses plain `writeFileSync`; switch it to atomic so an interrupted write can't
  truncate the user's file). Idempotent across repeated init.
  **Tests must assert:** unrelated user lines survive verbatim + in order; the stale
  `.reviewgate/cassettes/` line is removed; no duplication on a second init; a fresh
  repo with no prior `.gitignore` is unaffected.

**Fail-safe.** Not a review suppressor — only changes which files git ignores.
Every pattern is anchored to a `/.reviewgate/` path segment → can never match app
code. Verified `personas/*.md` and golden cassettes stay trackable.

**Files.** `src/cli/commands/init.ts` (GITIGNORE_LINES + writer migration).
**Tests.** Update `tests/unit/init.test.ts:125`; add a `git check-ignore` test
asserting `backend/.reviewgate/state.json` ignored while `…/cassettes/golden` (root
+ nested) trackable.

### P10 — advisory monorepo/app-topology block
**Root cause.** The only repo-structure signal is `loadConventions`
(conventions.ts:13–29) = root `CLAUDE.md`/`README.md` first 600 chars + root
`package.json` script *names*. Nothing enumerates nested `package.json` or maps
path→app→framework, so a reviewer conflates `/app` (Vite SPA) with `/dealbarg`
(Next.js) and raises a confident-FP CRITICAL.

**Fix.** New `src/research/app-topology.ts` → `loadAppTopology(repoRoot)`:
- `new Bun.Glob('**/package.json')` with the symbol-graph exclusion regex
  (node_modules/.git/.reviewgate/dist), cap ≤12 apps (deterministic sort by depth
  then name), read each via `safeReadContained(repoRoot, rel, 64*1024)`
  (symlink/realpath/size-safe), `JSON.parse` in try/catch.
- Framework from merged deps+devDeps via an ordered allowlist table
  (next→Next.js, @remix-run→Remix, astro→Astro, nuxt→Nuxt, @sveltejs/kit→SvelteKit,
  vite→Vite, @angular/core→Angular, express|fastify|@nestjs/core→server,
  react/vue/svelte→library if no app framework).
- Map each package DIR → `${dir}/** = <name> (<framework>)`.
- Render in `writeResearch` as `## App topology (TRUSTED — repo structure)` **only
  when ≥2 apps OR ≥2 distinct frameworks** (single-app repos add noise). Every
  attacker-controllable string (pkg name, path) through `neutralizeInjectionMarkers`
  + newline-strip (matches research-writer.ts:129); framework labels are code-side
  allowlist, inert.
- Fold its sha256 into the cache key alongside `conventionsSegment`
  (orchestrator.ts:901–903) so a package.json/framework change re-runs the panel.
- Gate behind `phases.research.appTopology` (define-config.ts:295), default-on,
  `maxApps` cap.

**Fail-safe.** Pure advisory trusted context — never touches aggregator/critic/
ledger/reputation/verdict. Worst case = absent (status quo) or a wrong label the
reviewer weighs against the actual diff. Cannot force a PASS or hide a finding.

**Files.** new `src/research/app-topology.ts`; `src/research/research-writer.ts`
(+section, +ResearchInput field); `src/core/orchestrator.ts` (~861 load, ~991 pass,
901–903 cache fold); `src/config/define-config.ts` + `defaults.ts`.
**Tests.** new app-topology unit test (the /tmp prototype: /app→Vite,
/dealbarg→Next.js); research-writer render test (≥2-app gate); injection-neutralize
test.

### P6 — `verified-not-applicable` decision verdict
**Root cause.** The decision union models only "reviewer right + I changed code"
(accepted) and "reviewer wrong" (rejected). The legitimate third outcome — "reviewer
raised a real concern, I verified with external evidence it does not apply here, no
fix" (the prod-DB-override case) — is inexpressible, forcing a false
`reviewer_was_wrong` (which pins an FP + debits reputation against a CORRECT
reviewer) or a no-op `fixed` (mis-attributes a TP).

**Fix.** Mirror the `acknowledged-low-value` precedent (its plumbing already
spans evaluateDecisions/decision-outcome/reputation end-to-end):
- decision.ts: add `"verified-not-applicable"` to the accepted-action enum; add an
  **optional** `reason` to the Accepted object. Build `DecisionEntrySchema` as today,
  then apply a **`.superRefine` to the UNION** (NOT to the Accepted branch — a
  `superRefine` returns a `ZodEffects`, and `z.discriminatedUnion` requires raw
  `ZodObject` options and throws while reading the branch shape, codex-confirmed)
  that, when `verdict==="accepted" && action==="verified-not-applicable"`, requires
  `typeof reason==="string" && reason.length>=20`. Keep the branch objects non-strict
  so the ~30 partial-config fixtures still parse.
- decision-outcome.ts: leave the else-branch → `declined` (the precision-correct
  bucket: not an FP — reviewer wasn't wrong; not a TP — no defect confirmed;
  excluded from the precision denominator). Add an explicit test.
- reputation/learn.ts:57: extend the neutral exclusion to
  `action !== "acknowledged-low-value" && action !== "verified-not-applicable"`.
  Reviewer was neither validated-correct nor wrong → reputation-NEUTRAL is the only
  non-distorting attribution.
- loop-driver evaluateDecisions: new guard — if action is verified-not-applicable
  and reason missing/<20 → **invalid → stays blocking** (fail-closed). Unlike
  acknowledged-low-value, it IS allowed on CRITICAL/security/correctness (the whole
  point), because the gate is the evidence-≥20 requirement, not a category bar.
- fp-ledger/learn.ts: no change (pin requires `rejected && reviewer_was_wrong`).
- report-writer.ts:288–309 + docs/AGENTS.md:117–129: document the new action.

**Fail-safe.** Fails CLOSED on every axis. Not a suppressor (no cross-iteration
memory; per-finding only; can't auto-apply to a future finding). Empty/short
evidence → finding stays blocking. *Reduces* a current hazard: removes the false
`reviewer_was_wrong` that pins a correct reviewer as an FP source. Abuse power =
identical to writing a false rejection reason today, but more honest + auditable.

**Files.** decision.ts, decision-outcome.ts, reputation/learn.ts, loop-driver.ts,
report-writer.ts, docs/AGENTS.md.
**Tests.** decision.test (parses w/ reason; rejects w/o), decision-outcome
(→declined), reputation-learn (neutral), decisions-gate (unblocks WITH evidence on
a CRITICAL; stays blocking WITHOUT ≥20 reason).

### P11 — docs-only severity calibration
**Root cause.** Part (a) is already done — a `riskClass:"docs"` review swaps to
`DOC_REVIEW_PROMPT_PREAMBLE` (no typecheck/lint/code framing, orchestrator.ts:1216,
540). Missing: (b) the aggregator is never told the riskClass, so a prose-only
CRITICAL hard-FAILs identically to a code CRITICAL — on the single-reviewer config
`reviewersTotal<=1` (aggregator.ts:752) makes any lone CRITICAL blocking; (c) no
"spec/docs review" badge.

**Fix — label/framing only (the severity cap was REJECTED as fail-open by the
Plan-Gate).** Codex flagged the same fail-open as P1: a docs CRITICAL→WARN becomes a
singleton WARN → SOFT-PASS → the default allow-policy allow-stops with NO required
decision → a genuinely-important doc CRITICAL (e.g. a spec mandating an insecure
design — a non-sensitive PATH but a real security/correctness concern) is auto-hidden.
So do NOT demote severity. Ship the two safe parts:
- (a) the prose/spec PROMPT framing is **already done** (`DOC_REVIEW_PROMPT_PREAMBLE`
  via `docPersona` for `riskClass:"docs"`, orchestrator.ts:1216/540 — no typecheck/
  lint/code framing). No change needed.
- (c) add a clear **"📄 spec/docs review — prose, not code; verify framework/library
  attribution before treating as blocking"** badge + a one-line header banner when
  `riskClass==="docs"` (thread a `docsReview:true` flag from orchestrator into
  PendingReport, mirroring `largeDiff`/`workspaceUnsettled`). Frames a doc CRITICAL so
  the agent disposes of a misread cheaply (reject-with-reason), while the finding still
  BLOCKS (fail-safe — a real spec-level security concern can't auto-hide).
- **The real fix for the framework-misread root cause is P10** (app-topology context):
  the monorepo path→framework map stops the reviewer misreading Vite-vs-Next in the
  first place. P11's label is the supporting calibration; P10 is the cure.

**Deferred (same as P1):** demote-but-keep-blocking + relax `acknowledged-low-value`
for a capped docs WARN — needs verdict-logic work proven not to fail open.

**Fail-safe.** Render-only (badge + header flag); never touches verdict or severity.
`riskClass:"docs"` requires `facts.docOnly` (diff-facts.ts:178) so a mixed docs+code
commit never gets the label; sensitive-path docs are `riskClass:"sensitive"`, never
`"docs"`.

**Files.** orchestrator.ts (`docsReview` flag), schemas/pending-report.ts,
report-writer.ts (badge + banner). **Tests.** badge renders for riskClass:"docs", NOT
for mixed/default; verdict/severity unchanged.

**Open Q (confirm w/ Markus).** Did the field doc match the default `docReview.globs`
(actual defaults: `docs/superpowers/specs/**`, `docs/**/plan*.md`, `docs/**/*spec*.md`
— a root-level `specs/foo.md` would NOT match)? If not it was a MIXED docs+code commit
(riskClass:default) — the cap must still NOT apply to mixed; the lever would instead
be widening globs. Safety unchanged either way.

---

## Tier 2 — calibration

### P4 — make PRELIMINARY deterministic + non-contradictory (render-only)
**Root cause.** (A) Missing data at the render site: `ProviderStat`
(audit-event.ts:75–84) carries only aggregate runs/errors — no per-provider status
or reset time; the rich status_detail ("capped until <iso>") exists upstream
(orchestrator.ts:1331) and is in pending.md but DROPPED by `buildRunSummary`. (B)
Wrong baseline + conflated semantics: `preliminaryReason` compares against
`configured.length` without distinguishing a STRUCTURAL shortfall the user chose
(disabled/quarantined) from a TRANSIENT one (quota/timeout this turn); and the
"not deploy-ready, avoid pushing" copy is hardcoded INTO the "GATE OPEN … Clear to
finish" message → the contradiction. Also a failover-collapse undercount: two slots
merging onto one provider drop the distinct-provider count below slot count.

**Fix (render-only, no verdict change).**
1. Name the WHY: extend `preliminaryReason` to consult `QuotaCooldownStore.activeUntil`
   (reset ISO → "codex: quota until 01:30") + `config.enabled` ("openrouter:
   disabled") + a fallback "did not complete (see pending.md)". Reuses exactly the
   data `quotaDegradationNote()` already reads.
2. Distinguish structural vs transient: effective panel = configured − permanently
   unavailable (enabled:false / persistently quarantined). Structural-only shortfall
   → "full coverage for your configured panel (X disabled)", NOT preliminary. Needs
   an additive **optional** `status`/`reset_at` on `ProviderStatSchema` populated in
   `buildRunSummary`; count OK SLOTS not distinct providers (fixes the collapse
   undercount).
3. Reconcile wording: drop the hardcoded "not deploy-ready/avoid pushing" sentence;
   defer deploy-readiness to the real authority (`pre-push-check.ts`): "GATE OPEN
   (this turn's review passed). Coverage was partial (codex quota until 01:30); the
   pre-push check is the deploy gate."

**Fail-safe.** Render-only; never touches the verdict. New schema fields optional/
additive (absent → today's wording). Deploy authority is the independent
pre-push-check, unaffected.

**Files.** loop-driver.ts (preliminaryReason/suffix), audit-event.ts (optional
fields), run-summary.ts (thread status + slot count). **Tests.** update
`loop-driver-preliminary-pass.test.ts` (new wording, structural-exemption case,
failover-collapse "N of N" case).

### P1 — track-record-weighted gating (the crux)
**Root cause (verified numerically).** The only track-record demoter on the gating
path keys on Beta(1,1)-smoothed TRUST (score.ts:27), floored at 0.35 — a 40%-raw
(8TP/12FP) reviewer scores 0.409 > 0.35 → never flagged unreliable. The entire
0.30–0.50 raw-precision band is invisible. The system already computes the RIGHT
metric (raw precision in provider-precision.ts) but wires it ONLY into protect-only
(high-precision exempts demotes) and render-only (LOW_TRACK_RECORD_PRECISION folds
INFO) paths. There is no low-precision demote on the gating path.

**Fix — render-only advisory (the gating demote was REJECTED as fail-open by the
Plan-Gate).** Codex confirmed a CRITICAL→WARN demote fails open: a demoted lone
non-security/correctness CRITICAL becomes a singleton WARN → SOFT-PASS, and under the
**default `softPassPolicy:"allow"`** a SOFT-PASS allow-stops the turn with NO required
decision → a real (low-precision-but-true) CRITICAL is auto-hidden. So P1 adds NO new
gating demote; raw precision only informs **display/triage**. (Same conclusion
field-report #8 reached: precision-into-block-weighting is less safe than just
annotating.) **Caveat (codex Plan-Gate):** "the reputation demoter is the safe gating
calibration" is an OVERSTATEMENT — the existing reputation pass AND the shipped
`hypotheticalSeverityGuard` already one-step a lone non-security/correctness CRITICAL
→ WARN, which can soft-pass under the default allow-policy. That pre-existing systemic
fail-open is NOT introduced by P1 and is addressed separately by **G0** below; P1
itself stays strictly render-only. Ship a loud, fail-safe advisory:
- `provider-precision.ts`: add `lowPrecisionProviders(precision,{floor:0.5,minDecisions:8})`
  (reuse the calibration floor so cold-start is never flagged; 0.5 captures the 40%
  case the smoothed trust-floor 0.35 misses). Used ONLY by the renderer.
- `orchestrator.ts:1777`: derive `lowPrecisionReviewers` from the already-loaded
  precision map next to `protectedReviewers` (no aggregator/verdict wiring).
- `report-writer.ts`: for any **gating** (CRITICAL/WARN) finding whose
  sole/contributing providers are all low-precision, prepend a prominent inline
  advisory — e.g. `⚠ raised by a reviewer at 40% precision (8 TP / 12 FP) — verify the
  cited code before the full caller sweep; consider requiring a 2nd reviewer`. Today
  the low-precision render path only folds solo **INFO** (LOW_TRACK_RECORD_PRECISION);
  extend it to ANNOTATE (not fold, not demote) blocking CRITICAL/WARN too.
- NO aggregator change, NO new verdict toggle, NO severity change.

**Honest pushback for the field.** The field asked to demote a sub-50% reviewer's
lone CRITICAL so it doesn't gate alone. That is unsafe: it auto-hides under the
default policy, and for security/correctness it would auto-hide a real auth bypass —
the exact category the report's own FP was IN. The fail-safe truth: a lone
low-precision CRITICAL must still be verified (we cannot prove it's the FP and not the
one real bug), but the loud precision advisory makes that verification cheap and
up-front. (Accuracy note, codex: the existing reputation demoter one-steps a
*chronically*-wrong reviewer's lone non-security/correctness finding by a single rank —
quality CRITICAL→WARN, WARN→INFO — and never touches a correctness CRITICAL; it does
NOT take CRITICALs straight to INFO. That residual CRITICAL→WARN→SOFT-PASS surface is a
pre-existing fail-open addressed by G0, not by P1.)

**Optional follow-up (deferred — needs verdict-logic care).** Demote
non-security/correctness CRITICAL→WARN AND keep the demoted finding in the
required-decisions set so it never silently soft-passes (additionally relaxing the
`acknowledged-low-value` bar for that demoted WARN) — gives the agent an honest cheap
off-ramp while staying blocking. Deferred because it special-cases the
verdict/soft-pass path and must be proven not to fail open under either softPassPolicy.

**Fail-safe.** Render-only — never touches the verdict, never demotes/suppresses;
fails CLOSED on empty precision data (no annotation → status quo). Cannot hide any
finding.

**Files.** provider-precision.ts (`lowPrecisionProviders`), orchestrator.ts (derive
the set), report-writer.ts (loud advisory on gating low-precision findings).
**Tests.** lowPrecisionProviders threshold (40% flagged, ≥0.5 not, <8 decisions not);
report-writer annotates a 40%-case CRITICAL WITHOUT changing its severity or the
verdict.

### P2 — recurring FP classes: frictionless render-only (auto-suppressor REJECTED as fail-open)
**Root cause (verified empirically).** Auto-suppression (demote-to-INFO) is gated
behind FP-ledger stage promotion, and EVERY promotion path requires
`distinct_providers >= 2` (store.ts:66, clusters.ts:125). That ≥2-provider floor is the
deliberate fail-safe against the single-hallucination attack. On a single-reviewer panel
it is structurally unreachable, so proxy.ts (8 rejects) stays `stage=candidate` forever
(reproduced: `computeFpClusters` → distinct=1). Fragmented rule_ids additionally defeat
cluster grouping. The only current remedy is a render-only fragmentation banner
recommending a manual `houseRules` entry each run.

**The auto-suppressor is REJECTED (codex Plan-Gate, after 4 rounds of hardening).** A
single-provider repeat-reject demote-to-INFO **cannot be made fail-safe**: under
`softPassPolicy:"block"` a singleton WARN SOFT-PASS requires a decision while INFO is
ignored by the gate — so WARN→INFO hides a would-be-decision WARN there; under
`allow`-policy it still hides a non-blocking nit; merged-member location capture poisons
the representative bucket; and dropping the ≥2-provider floor is the exact
single-hallucination fail-open the prior design refused. `default-OFF` reduces rollout
risk but does NOT make a suppressor fail-safe. **This is the case the prior
FP-fragmentation pivot already anticipated: a suppressor must fail safe; the durable safe
fix is the agent-/human-decided `houseRules` entry, not an auto-suppressor.**

**Fix — make the existing safe path FRICTIONLESS (render-only).**
- Lower/extend the existing `fragmentingFpClasses` detector so it ALSO fires for the
  single-reviewer + fragmented-rule_id case that can never promote (it already uses a
  laxer ≥3-distinct-sig threshold with no provider floor — confirm it triggers on the
  proxy.ts/cookie-consent/install-prompt shapes; widen if needed).
- Make the banner emit a **paste-ready `houseRules` config snippet** (the exact lines to
  drop into `reviewgate.config.ts`) instead of just prose advice, so the durable fix is
  one copy-paste — killing the per-run friction WITHOUT auto-hiding anything.
- Optionally add `reviewgate fp suppress <file>` CLI sugar that writes the houseRule for
  the agent. Still an explicit, auditable opt-in (fail-safe).

**Honest pushback for the field.** The field asked to auto-suppress N-times-rejected FP
classes. That cannot be done safely (codex-confirmed over 4 hardening rounds) — any
auto-suppressor hides a real finding under at least one policy. The frictionless
houseRule (paste-ready snippet) is the safe equivalent: it removes the per-run toil
while keeping suppression an explicit, auditable decision. A reviewer that is
*chronically* an FP source is separately down-weighted by the reputation demoter.

**Fail-safe.** Pure render-only — emits advice + a config snippet; never auto-demotes,
never touches the verdict. Cannot hide a finding.

**Files.** fp-ledger/fragmentation.ts (widen trigger if needed), report-writer.ts
(paste-ready snippet), optional cli/commands/fp.ts (`suppress` sugar). **Tests.** banner
fires for a single-provider 6×-rejected class; snippet is valid `houseRules` syntax;
no verdict/severity change.

---

## Tier 3 — already-solved + tiny hardening / docs

### P5 — out-of-diff demote already exists & is fail-safe
`scopeFindings` (aggregator.ts:221) already demotes out-of-diff findings to advisory
(default-on, fail-safe). The `.env.example:113` case is **in-diff** (a large rewrite
yields one hunk `@@ -1,2 +1,120 @@` covering line 113 — verified in /tmp). The
"unchanged across the loop" class = in-diff-but-unedited, correctly handled by the
advisory `location_recurred`/`stable_code` badges (shipped 2026-06-18). Auto-demoting
it would fail OPEN.
- **Tiny fix:** path-normalization parity for `stable_code` — run
  `priorIterationTouchedFiles` (loop-driver.ts:233) through `normalizeRepoPath` like
  `f.file` is, so the (advisory-only) badge isn't spuriously set on `./x` vs `x`.
- **Docs:** CLAUDE.md gotcha distinguishing out-of-diff (auto-demoted) vs
  in-diff-unedited (still gated by design).

### P3 — finding-ID recycling already remediated
The literal bug is CLOSED: `clearDecisions()` rmSync's `decisions/` at all 3
iteration-reset points (loop-driver.ts:772/809/1452) + SessionStart reset, pinned by
3 regression tests (loop-driver.test.ts:1102/1143/1237). A commit mid-FAIL does NOT
reset/bypass. Residual = the invariant "iteration→0 ⟺ decisions wiped" is enforced by
convention across 4 sites.
- **Harden (optional):** add a guard test asserting `!existsSync(decisionsDir)` after
  any re-arm to iteration 0. (De-dup into a `reArmCycle` helper is deferred — the
  project prefers explicit inline state with local comments.)
- **Advisory (optional):** persist the cycle's review-base SHA in pending.json and
  render it in the F-NNN header so a human reading a stale file can tell which cycle
  an F-001 belonged to. Pure presentation.

### P7 — small-diff fast-path: wontfix + document
Every fast-path option fails open: a naive size-skip (the 2 real bugs were on THIS
30-line diff), trusting "external Codex passed" (no tamper-proof channel; agent
authors its own decisions), and subset-detection (a fix's new diff is not provably a
subset of cleared code). The size-tiered iteration cap already exists
(SMALL_DIFF_MAX_ITERATIONS=2 for ≤30-line low-risk diffs) + a 240s reviewer-timeout
cap.
- **Optional knob:** expose `loop.smallDiffMaxIterations` (currently hard-coded in
  matrix.ts:25). Pure cap-tuning, fail-safe.
- **Document:** the loop tax is the full-panel-re-review regression guarantee; the
  real lever is panel COMPOSITION (one fast reviewer for low-stakes repos), not
  skipping. Product question: allow a narrower panel for a low-risk tier
  (`reviewerHint`)? — every round still runs ≥1 real review, so it stays fail-safe.

---

## Tier 4 — P8 worktree blindness (Priority-1 coverage; design)

**Mechanism (confirmed by real `git worktree` experiments).** Reviewgate arms via two
per-checkout artifacts that do NOT propagate into a worktree: the `.reviewgate/bin/`
shims and the hooks in `.claude/settings.json`, both under the main clone's repoRoot.
A worktree shares only `.git` (a gitdir-file pointer) — it has NO `.reviewgate/` and
NO `.claude/`. Claude Code loads hooks from the worktree's own dir (CC changelog:
worktree hook discovery covers `.claude/agents`+`skills`, NOT settings.json/hooks) →
the Stop hook is simply ABSENT in the worktree → the gate never fires → the turn ends
un-reviewed (fail-open). Even if the main clone's hook ran, its `collectDiff` sees an
empty `git diff HEAD` (worktree commits are on another branch; the default
`.worktrees/` is gitignored). `doctor` is silent (all hook checks return null when
`.claude/settings.json` is absent). Base resolution from inside a worktree DOES work
(verified via the shared object DB) — so once a worktree-local `.reviewgate/` exists,
the gate would review correctly.

**Layered fix.**
- **Layer 1 (ship now — the immediate fail-loud guard, low risk):**
  - `src/utils/git.ts`: `worktreeInfo(repoRoot)` via `git rev-parse --git-dir` vs
    `--git-common-dir` (differ ⇒ linked worktree); guard submodules via
    `--show-superproject-working-tree`.
  - `src/cli/commands/doctor.ts`: when inside a linked worktree AND the cwd's
    `.claude/settings.json` lacks the reviewgate Stop hook (reuse `hooksInstalled`),
    emit a **FAIL** (not warn): "You are inside a git worktree with NO Reviewgate
    hooks — the gate is OFF here; run `reviewgate init` in this worktree (or merge to
    the gated main checkout)." Converts the silent-healthy doctor into a loud failure.
  - Docs: a "Worktrees" section in docs/AGENTS.md + CLAUDE.md.
- **Layer 2 (robust fix — needs live CC verification first):** make `reviewgate init`
  worktree-aware (`init` detects a linked worktree → installs `.reviewgate/bin` +
  merges hooks into `<worktree>/.claude/settings.json`, state under
  `<worktree>/.reviewgate/`), and/or a `WorktreeCreate` hook template to auto-init
  each new worktree. **Open:** does CC's native EnterWorktree inherit the main
  `.claude/settings.json` at all? Does the superpowers `git worktree add` fallback
  fire `WorktreeCreate`? Verify against the installed CC version before building.
  **Open:** should a per-worktree `.reviewgate/` share learnings (FP-ledger/brain/
  reputation) with the main clone via a symlink to `<git-common-dir>/../.reviewgate`?

**Fail-safe.** Adds coverage → fails toward MORE review. The doctor check can only
over-warn; per-worktree init creates an independent state dir (can't corrupt the main
gate); detection failure → "treat as normal repo" (status quo). Do NOT auto-skip the
main-clone gate when a worktree exists.

---

## Rollout sequence

0. **Tier 0** (G0 + G0b) — OPTIONAL but foundational; verdict-path, highest-rigor TDD +
   own DoD. If taken, P1/P11 can additionally graft the safe "demote-but-keep-blocking"
   off-ramp; if skipped, P1/P11 stay render-only and Tier 0 is a tracked follow-up.
1. **Tier 1** (P9, P10, P6, P11) — mostly disjoint files → a parallel
   implementation workflow with worktree isolation, each slice TDD + own commit.
2. **Tier 2** (P4, P1, P2) — all render-only/low-risk now (P2's auto-suppressor was
   rejected as fail-open; it ships as the frictionless paste-ready houseRule banner).
3. **Tier 3** (P5 path-norm + P3 guard test + docs; P7 docs/knob) — small follow-ups.
4. **Tier 4** P8 Layer-1 now; Layer-2 after live CC verification.

Each slice: `bunx tsc --noEmit` + `bun run lint` + `bun test` green, then the DoD
review pipeline (codex ×2 + claude ×2, all PASS) before merge. Plan-Gate
(external codex/agy) reviews THIS document before the first code change.

## Open decisions for Markus
- **P1 (resolved by the Plan-Gate, confirm):** the literal "demote a low-precision
  lone CRITICAL so it doesn't gate" is REJECTED as fail-open (auto-hides under the
  default allow-policy; auto-hides a real auth bypass for security/correctness).
  Shipping a loud render-only precision advisory instead — a lone low-precision
  CRITICAL still blocks (must be verified) but now shows the precision ratio up front.
  OK?
- **Scope this session:** ship all of Tier 1+2 now, or Tier 1 first?
- **New-toggle defaults:** the only new always-safe context toggle is `appTopology`
  (P10, render-only) — default-ON or opt-in? (There is NO `docsSeverityCap` /
  `demoteLowPrecisionCriticals` / `fpAdvisoryDemote` toggle — every verdict-path demoter
  / auto-suppressor was REJECTED as fail-open; P1 & P2 are render-only and P11 is
  label-only. G0 is the one opt-in foundational toggle.)
