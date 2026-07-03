# Field-Report Calibration Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the gate CONVERGE: a clean change must reach green in ≤2–3 rounds instead of churning for 8, without losing the round-1/2 real-bug catches.

**Architecture:** All changes are upstream demote passes (aggregator), loop-driver ladder branches, or persisted-state substrate — the verdict loop itself (`aggregator.ts:902-952`) is never touched. Every suppressor is demote-not-drop, positive-signal-gated, and inert on missing/corrupt input.

**Tech Stack:** Bun + TypeScript, zod schemas in `src/schemas/` as source of truth, plain-JSON state under `.reviewgate/`, `bun test`.

## Source

Production field report (FlashBuddy session, ~8 rounds on an externally clean change; ~50+ findings, ~5–6 real bugs all in rounds 1–2, ~15–20 hallucinations). Investigated by 7 parallel gap-analysis agents + completeness critic (2026-07-03). Key claim-checks against the code:

- **CONFIRMED:** review base (`base_sha` in dirty.flag) is deliberately preserved across FAIL iterations (`src/hooks/handlers.ts:95-124`), so every round re-reviews the FULL batch diff; the verdict cache is byte-keyed on the full raw diff and PASS-only (`src/cache/cache.ts:14-26`, `orchestrator.ts:1035`) — a mid-cycle fix or a FAIL round can never hit it.
- **CONFIRMED:** rejection suppression is signature-keyed (`src/diff/signature.ts:77-94`); a renamed rule on the same region is a fresh signature. Location guards (`location-recurrence.ts`) are ESCALATE-only; the fragmentation banner is render-only.
- **CONFIRMED:** the reputation demote pass fully exempts CRITICAL-correctness (`aggregator.ts:~797-804`) — that carve-out predates G0 (demoted_from_critical findings stay decision-required, `loop-driver.ts:1592-1604`) and is now stale: it lets a chronically-wrong reviewer manufacture unconditional hard FAILs.
- **CONFIRMED:** `trustFloor` default 0.35 (`defaults.ts:184`) — Beta(1,1)-smoothed trust of a ~38 %-raw-precision reviewer sits ABOVE 0.35, so the field's low-precision reviewer was never demoted at all.
- **ASK 8 ALREADY HALF-SHIPPED:** the `reject-rate-high` breaker (≥ 80 % / ≥ 4 decisions, `loop-driver.ts:1408-1418`) exists but counts only `reviewer_was_wrong:true` rejections — plain rejections starve it.
- **~8-round arithmetic explained:** maxIterations 3 + convergence churn-credit extension (hard cap `maxIter*2` = 6) + up to 3 quota-defer turns (`quotaDeferMaxConsecutive`).

## Global Constraints (repo principles — every task implicitly includes these)

- A suppressor must FAIL SAFE: missing/corrupt/ambiguous input → do NOT suppress. Demotes are gated by POSITIVE signals only.
- Demote, never drop. Security findings are never auto-suppressed; sec/corr blocking never silently disappears.
- Cold-start neutrality: reputation/precision-based mechanisms require ≥ 8 decayed samples; unknown = neutral, never penalized.
- Gate stays fail-closed on 0 successful reviewers; singleton rule (reviewersTotal ≤ 1 → lone CRITICAL FAILs) untouched.
- New config flags: `z.boolean().optional()` in the zod schema + value in `src/config/defaults.ts` (never `.default(true)` inline) — the config hash invalidates the review cache.
- New persisted fields: additive, `.optional()`/`.default()` — old `state.json` must keep parsing. Every re-arm/reset site in loop-driver must enumerate ALL new fields.
- The verdict loop (`aggregator.ts:902-952`) is not modified by any slice.
- All new aggregator passes: skip already-INFO findings, stamp at most one badge (no badge stacking), badge text reflects CURRENT severity.
- `bunx tsc --noEmit` + `bun run lint` + full `bun test` green before done. Never `git add -A` in this repo.

## Resolved design decisions (were flagged for maintainer sign-off; resolved per critic recommendation)

1. **R4 vs G0 precedence: G0 wins.** A `demoted_from_critical` WARN stays decision-required even after ≥ 2 region rejections (badge + pre-filled rejection hint only). Demoting it to non-decision INFO would re-open the fail-open hole G0 closed. Relief for that class comes from R6/R7 escalating earlier.
2. **R5 premise accepted:** the CRITICAL-correctness fail-open rationale in `provider-precision.ts:85-90` is obsolete now that G0 ships (verified live at `loop-driver.ts:1592-1604`).
3. **R13's non-consensus-exemption** (P2, not this session) needs explicit sign-off at implementation time — documented, deferred.

## Aggregator pass order (canonical, after this plan)

deterministic demoters (fact-check, self-refutation, hypothetical) → merge/consensus → critic → confidence floor → scope-to-diff + **delta-scope (R2, same group)** → cycleRejected → fp-ledger/cluster → **reputation clamp (R5 modifies existing pass)** → **region-rejected (R4, evaluates post-clamp severity)** → test-severity → docsScoped → verdict loop (untouched).

---

# THIS SESSION: Quick wins + R1, R5, R4, R2, R3, R6, R7

Implementation order: **T0 → T1(R1 substrate incl. R4 state fields) → T2(R5) → T3(R4) → T4(R2) → T5(R3) → T6(R6) → T7(R7)**. R5 must land before R4 (pass-order dependency). One coordinated `state.ts` schema change (T1) serves R1+R4 to avoid consecutive migrations.

### Task 0: Quick wins (pure defaults, no new code)

**Files:** Modify: `src/config/defaults.ts`

- [x] `phases.reputation.trustFloor` 0.35 → **0.45** (`defaults.ts:184`). minSamples=8 preserves cold-start neutrality.
- [x] `loop.quotaDeferMaxConsecutive` 3 → **1** (`defaults.ts:242`). A cooldown rarely clears within 3 agent turns; 3 non-advancing defer turns were part of the field's 8-round latency.
- [x] `loop.rejectRateEscalation` 0.8 → **0.7** (`defaults.ts:204`). Becomes a real lever once T6 lands.
- [x] Check existing tests asserting these defaults; update assertions deliberately (they encode the old calibration, not a behavior contract).
- [x] Run `bun test tests/unit` — green.

### Task 1: R1 — Reviewed-snapshot substrate (+ coordinated state fields for R4)

**Files:** Modify: `src/schemas/state.ts`, `src/core/orchestrator.ts`, `src/core/loop-driver.ts`. Test: `tests/unit/reviewed-snapshot.test.ts`

**Produces (later tasks rely on):**
- `state.reviewed_snapshot: { iter, verdict, base_sha, files: Record<path, FileEntry> } | null` with `FileEntry = { status: "present"|"deleted"|"unreadable", hash: sha256-hex|null }`. **The keyset is a complete manifest: EVERY file in the reviewed diff gets an entry** — unreadable/symlink-escaping → `status:"unreadable", hash:null`; deleted → `status:"deleted", hash:null`. Omission is therefore impossible to confuse with not-in-diff (codex W1). Consumers treat `hash:null` fail-safe: R2 keeps such files in scope; R3 never short-circuits on them. Written at the end of EVERY completed iteration (FAIL and PASS), hashed via `safeReadContained` (`src/utils/safe-read.ts`).
- `state.cycle_rejected_regions: Region[]`, `state.cycle_addressed_regions: Region[]` where `Region = { file, start_line, end_line, severity, categories, reason (≤200ch), distinct_count }` — empty arrays now, populated in T3.
- `state.region_suppressed_hits: number` (per-cycle counter, populated in T3, consumed by T6's contested breaker).
- `state.pass_ledger: { head_sha, config_hash, files: Record<path, FileEntry> } | null` — **T1 lands the schema field and its reset-site enumeration only; the ledger is never WRITTEN in T1 (always null in practice until T5 wires write-on-PASS and read/compare)**. Write-on-PASS tests live in T5, not T1 (single coordinated migration, codex W8 + round-2 W1). Reset semantics for ALL new fields, enumerated per site: PASS re-arm (~`loop-driver.ts:904/951`) clears snapshot + regions + hits (T5 adds the ledger write here); post-escalation re-arm (~`934-960`) and commit re-arm (~`879-923`) clear snapshot + regions + hits, LEAVE pass_ledger (it only ever encodes "this exact content passed a full panel" — still true); session reset (`--hook reset`) clears everything including pass_ledger.

Steps:
- [x] Write failing tests: snapshot written on FAIL and PASS with correct sha256 of file bytes; unreadable/symlink-escaping file present with `hash:null` (never omitted); deleted file → `status:"deleted"`; every reviewed-diff file has an entry (manifest completeness); re-arm/reset semantics exactly as enumerated above per site; zod round-trip; back-compat (state.json without the new fields parses).
- [x] Add zod fields (all `.optional()`/`.default()`), write snapshot in the orchestrator/loop-driver at iteration completion, wire every reset site.
- [x] `bun test` green. (Pure substrate — zero behavior change alone.)

### Task 2: R5 — Reputation corroboration clamp for CRITICAL-correctness

**Files:** Modify: `src/core/aggregator.ts` (existing reputation pass), `src/schemas/finding.ts`, `src/config/define-config.ts`, `src/config/defaults.ts`, `src/core/report-writer.ts`, `src/core/provider-precision.ts` (stale comment). Test: `tests/unit/reputation-corroboration.test.ts`

**Design:** Replace the full CRITICAL-correctness exemption in the reputation demote pass with the pass's existing G0-style WARN clamp: demote CRITICAL → WARN + `demoted_from_critical` + new flag `reputation_corroboration_required` when ALL of: every contributing reputation key is POSITIVELY unreliable (≥ 8 decayed samples below trustFloor — cold-start can never qualify; **ANY contributor whose key is unknown, uncalibrated (< 8 samples), missing, or unparseable → NO clamp**, codex W3), the finding is uncorroborated (single provider), NOT security (security stays unconditional FAIL), NOT pinned (§4.3), AND `reviewersTotal ≥ 2` (singleton failsafe untouched). G0 keeps the result decision-required — one chronically-wrong reviewer just can't manufacture an unconditional hard FAIL anymore.

**Rendering:** the corroboration badge REPLACES `lowPrecisionAdvisory` when the clamp fired (fixes the field's contradictory "consider requiring a 2nd reviewer" on a finding that still hard-blocked). Add a `corroboration_clamped` counter to the run summary (feeds the later R16 default-flip decision).

**Config:** `phases.reputation.corroborateCritical` (optional boolean, `true` in defaults.ts).

Steps:
- [x] Failing tests: lone unreliable CRITICAL-correctness @ reviewersTotal=2 → WARN + both flags, decision-required; reviewersTotal=1 → unchanged hard FAIL; security → unchanged; corroborated → unchanged; empty/corrupt reputation store → no-op; pinned → unchanged; flag off → unchanged; badge replaces (not stacks with) low-precision advisory; counter increments only on clamp.
- [x] Implement; update the stale fail-open rationale comment in `provider-precision.ts:85-90`.
- [x] `bun test` green.

### Task 3: R4 — Cycle-scoped region memory + region-rejection demote pass

**Files:** Modify: `src/core/loop-driver.ts` (harvest), `src/core/aggregator.ts` (new pass AFTER reputation clamp), `src/core/orchestrator.ts`, `src/schemas/finding.ts`, `src/config/define-config.ts`, `src/config/defaults.ts`, `src/core/report-writer.ts`. Test: `tests/unit/region-rejected.test.ts`

**Design — harvest:** where loop-driver already folds prior rejected signatures (the priorAdjudications join of decisions × pending.json locations), also accumulate `cycle_rejected_regions` (verdict rejected) and `cycle_addressed_regions` (action fixed) into the T1 state fields, merging overlapping same-file regions and incrementing `distinct_count`.

**Design — demote pass** (placed AFTER the reputation clamp so it sees post-clamp severity): a NEW blocking finding whose `(file, line-range)` overlaps a rejected region with **sliding ±5-line tolerance** (reuse the aggregator's existing F-009 sliding-window helper/constant, `aggregator.ts:150-158`) is handled under this ladder:
- **Demote to INFO + `region_rejected_match` badge requires ≥ 2 DISTINCT prior rejected findings on the region for ALL categories** (codex C1: a single mistaken agent rejection must never self-ratchet into suppression), AND **category compatibility**: EVERY member category of the new (post-merge) finding is present in the region's accumulated rejected-categories set — ANY novel member category means new information and the finding stays blocking with badge only (round-2 W2: one overlapping category among several is NOT sufficient).
- 1 prior rejection, or ≥ 2 without category match: **badge only** (advisory `region_rejected_match` citing the prior rejection reason + a pre-filled rejection hint rendered INSIDE the badge text — hints are not a second badge, codex I4). Finding stays blocking.
- CRITICAL and security: NEVER demoted — badge only (mirrors the G0b tag-only ceiling).
- `demoted_from_critical` WARN: stays decision-required WARN (G0 outranks — resolved decision 1); badge only.
- rejected-WARN region never suppresses a new CRITICAL (severity dominance).

**Escalation-pressure preservation (codex W4/W7):** every demote this pass performs increments `state.region_suppressed_hits` for the cycle; T6's contested breaker adds these hits to BOTH numerator and denominator — a suppressed-because-previously-rejected finding IS contested evidence, so suppression can only make the breaker fire EARLIER, never starve it. Concrete invariant test: a persistently-noisy panel trips reject-rate/fp-streak escalation no later WITH suppression active than without.

**Fail-safe:** unparseable region entry or finding without line data → no suppression. The signal source is the AGENT's explicit ≥ 20-char-reason rejections, so this layer stays live at panel size 1 (exactly where consensus/fp-ledger/reputation go dead). Note the existing signature-keyed cycle-rejected suppression (2b) still handles IDENTICAL-signature recurrence at 1 rejection — R4 only covers the renamed-signature case, hence the stronger ≥ 2 evidence bar.

**Config:** `phases.review.regionRejectedSuppression` (optional boolean, `true` in defaults.ts).

Steps:
- [x] Failing tests: overlap incl. boundary + sliding tolerance; severity dominance; ≥ 2 distinct required for every category; category-compat required (category jump stays blocking); 1 rejection → badge only, still blocking; security never demoted; `demoted_from_critical` stays decision-required; harvest accumulates across iterations and resets on re-arm; `region_suppressed_hits` incremented per demote; state back-compat; flag off → byte-identical passthrough; escalation-pressure invariant (noisy panel escalates no later with suppression active).
- [x] Implement harvest + pass. Integration test: 3-iteration fake-panel run where a renamed same-category finding on the same region goes blocking → INFO by round 3 (after 2 distinct rejections).
- [x] `bun test` green.

### Task 4: R2 — Delta-scope demote (iteration ≥ 2)

**Files:** Modify: `src/core/aggregator.ts` (pass in the scope-to-diff group), `src/core/orchestrator.ts`, `src/config/define-config.ts`, `src/config/defaults.ts`, `src/schemas/finding.ts`. Test: `tests/unit/delta-scope.test.ts`

**Design:** On iteration ≥ 2, compute the delta scope from the T1 snapshot: files whose current working-tree hash differs from the prior reviewed snapshot entry (including `hash:null` entries — unreadable stays in scope, fail-safe) + new files + files of ALL prior blocking findings **as rendered in the prior iteration's pending.json (post-aggregation — what the agent saw and had to address; deterministic and stable across pass reordering, codex W5)** + claimed-fixed regions (§4.3 pins stay in scope by construction — no special-case pin code). A NEW blocking finding outside that scope demotes to INFO + `delta_scope_demoted` badge. Exemptions: security and correctness findings (any member), deterministic-check findings. Inert (full scope) when: snapshot missing/corrupt/incomplete-manifest, iteration 1, `mode:"one-shot"`, diff incomplete.

**Honest rationale (codex C2):** this is a POLICY demote for iteration ≥ 2 review noise, not a soundness claim. The reviewer prompt keeps the FULL diff — only the GATING scope narrows. A real fix-introduced regression on an unchanged file usually anchors at the changed file (in scope) or is categorized correctness/security (exempt); the residual class — a genuinely-new quality/testing/perf/docs finding correctly anchored on an unchanged out-of-scope file in iteration ≥ 2 — renders as INFO with a badge instead of blocking. That trade is exactly what the field evidence demands (demote-not-drop: the finding stays visible and actionable), and the flag (`deltaReview`) turns it off per-repo. Documented as an accepted residual, not hidden behind a soundness argument.

**Cache:** fold the computed delta scope into the behavior hash (priorAdjudications precedent, `orchestrator.ts:945-948`) so a PASS under a narrow scope is never served to a full-scope run.

**Config:** `phases.review.deltaReview` (optional boolean, `true` in defaults.ts).

Steps:
- [x] Failing tests: unchanged-file WARN (quality) demotes with badge; security/correctness CRITICAL out-of-delta stays blocking; claimed-fixed recurrence stays pinned; missing snapshot → no demotes; iter 1 → no demotes; one-shot → inert; scope folded into behavior hash (changed scope ⇒ changed key).
- [x] Implement. Integration test: 2-iteration stub-panel run where iter 2 re-raises a style nit on an untouched file → SOFT-PASS/PASS instead of FAIL.
- [x] `bun test` green.

### Task 5: R3 — Content-identity PASS short-circuit (post-commit / amend / rebase re-fires)

**Files:** Modify: `src/cli/commands/gate.ts`, `src/core/orchestrator.ts`, `src/core/loop-driver.ts` (schema for `state.pass_ledger` already landed in T1). Test: `tests/unit/content-identity-pass.test.ts`

**Design:** On a clean FULL-coverage panel PASS (never `summary.source` cache/skipped/checks, never a reduced-coverage PRELIMINARY pass, never during a quota defer), persist the T1 snapshot as the PASS ledger. On later gate fires (HEAD-advanced synthesis path `gate.ts:519-563`, amend-widened base path `gate.ts:413-442`): after `collectDiff`, compare **(path, status, hash) tuples, not bytes alone (codex W2):** short-circuit allow-stop ONLY when every file in the new diff has a ledger entry with the SAME status (present/deleted) and a matching non-null sha256, the new diff introduces no path or status absent from the ledger (covers deletions, renames — a rename is an add+delete pair and both must match — and new files), no `hash:null` (unreadable/binary) entry is involved on either side, the diff is not marked incomplete, and `config_hash` matches. Emit a new `'content-cache'` summary source (mirrors the existing byte-cache hit path). This survives the re-serializations that defeat the byte-keyed cache: `--no-index` untracked synthesis vs committed new-file hunks, `BASE_TS_NO_SCOPING_SENTINEL` widening, message-only amends.

**Fail-safe:** any mismatch, absence, null-hash involvement, status difference, or config change → full review. Ledger lifecycle per T1 (replaced on each full-panel PASS, survives re-arms, cleared on session reset).

Steps:
- [x] Failing tests: byte-identical post-commit diff → content-cache PASS, no panel spawn; one changed byte → full review; diff file absent from ledger → full review; delete-only diff of a file the ledger has as present → full review; `hash:null` entry → full review; preliminary PASS writes no ledger; config change invalidates; message-only amend → allow.
- [x] Implement. Integration test: PASS → commit → gate allows without panel.
- [x] `bun test` green.

### Task 6: R6 — Widen the FP-domination breaker (contested-rate)

**Files:** Modify: `src/core/fp-ledger/reject-rate.ts`, `src/core/loop-driver.ts`, `src/config/define-config.ts`, `src/config/defaults.ts`. Test: extend `tests/unit/` reject-rate tests.

**Design:** `computeRejectRate` additionally returns `contested` = last-wins rejections on finding ids that were CRITICAL/WARN **in the iteration they were decided** (severity at decision time — decisions are only required for then-blocking findings, so this is inherent; later demotion of a recurrence never retro-removes evidence, codex W4) REGARDLESS of the `reviewer_was_wrong` flag (anti-padding rules intact: real-id restriction, last-wins, ≥ 20-char reasons). Additionally, T3's `region_suppressed_hits` are added to BOTH the contested numerator and the denominator — suppressed re-raises of already-rejected regions are contested evidence (codex W7). The existing `reject-rate-high` escalation fires when EITHER rate ≥ `loop.rejectRateEscalation` with ≥ 4 combined decisions+hits. Suppressors/learners (fp-ledger, reputation, fp-streak) stay keyed to `reviewer_was_wrong` only — this widens ESCALATION only (fail-safe direction: over-triggering hands off to the human sooner).

**Config:** `loop.rejectRateCountsAllRejects` (optional boolean, `true` in defaults.ts).

Steps:
- [x] Failing tests (thresholds consistent with T0's rejectRateEscalation=0.7): 4 plain rejects (no flag), rate 1.0 → fires; 3 rejects + 1 accepted, rate 0.75 ≥ 0.7 → fires; 2 rejects + 2 accepted, rate 0.5 → silent; flag off → old reviewer_was_wrong-only behavior; padding with non-required ids ignored; rejected→accepted last-wins not counted.
- [x] Implement. `bun test` green.

### Task 7: R7 — Deny convergence churn-credit to FP-dominated rounds + lower hard cap

**Files:** Modify: `src/core/loop-driver.ts`, `src/config/define-config.ts`, `src/config/defaults.ts`. Test: extend loop-driver convergence tests.

**Design:** (1) `churnProgressing` additionally requires the just-completed round NOT be FP-dominated: deny churn-credit when `latestWrong ≥ ceil(blocking/2)` for that round, where `blocking` = the blocking-finding count as rendered in that round's pending.json (post-aggregation) and the check is NOT APPLICABLE when `blocking === 0` (a zero-blocking round passes; no churn credit is in question — codex I3); the lastReal-decreasing and severityImproving branches stay untouched. (2) Replace the hardcoded `maxIter*2` extension ceiling (`loop-driver.ts:1086`) with `maxIter+2` (default cap 6 → 5). Both changes only make the gate escalate EARLIER.

**Config:** `loop.fpChurnGuard` (optional boolean, `true` in defaults.ts) for (1); (2) is a constant change.

Steps:
- [x] Failing tests: churn round with latestWrong ≥ 50 % of blocking → no credit → escalates at maxIter; same round with 0 FP rejects → still extends; hard cap at maxIter+2; flag off restores old credit.
- [x] Implement. `bun test` green.

### Implementation notes (deviations from the gated plan, deliberate)

- **`verified-not-applicable` counts as a rejected-region signal (T3) and as contested (T6).** The gated plan said `verdict:rejected` only; VNA carries the same ≥ 20-char evidence bar and is exactly the field report's dominant "valide aber nicht anwendbar" class (the CREDIT_COSTS treadmill) — excluding it would have missed that cluster entirely. Escalation-side counting is fail-safe by direction; suppression-side still requires ≥ 2 distinct + category compatibility.
- **The content-identity short-circuit lives in the orchestrator (runIteration), not gate.ts.** Same effect, single choke point: every gate path (HEAD-advanced, amend-widened) flows through runIteration, and the per-file manifest is computed there anyway. Deleted files short-circuit on (path, status:"deleted") equality — a deletion has no content to hash; "unreadable" never short-circuits.
- **The snapshot/manifest is computed BEFORE the cache key** (not after the cache check as first drafted): the T4 delta scope derived from it must be part of the key. Cost: hashing the diff's files once per panel run.
- **Region suppression hits feed the contested breaker via `state.region_suppressed_hits`** (aggregator returns the per-run count; loop-driver accumulates) — the concrete invariant from plan-gate W4/W7.

### Adversarial multi-agent review round (2026-07-03, post-implementation)

A 5-lens / 2-refuters-per-finding ultracode workflow produced 33 candidate findings; 12 were adversarially CONFIRMED (0 refuted; the remaining verifiers hit the Claude session quota and their findings were triaged manually against the code — all real or accepted). ALL were fixed in-session:

- **CRITICAL — content-cache subset fail-open:** the serve check was one-directional; reverting one file of a passed batch produced a zero-review PASS on a tree no panel saw. Fixed: KEYSET equality both directions + regression test.
- **Ledger environment staleness:** config_hash-only guard → now `env_hash` = the byte-cache key inputs minus the diff (RG_VERSION, schema version, prompt preamble, behavior hash, host tier, conventions, foreign/delta/region segments).
- **Narrow-scope laundering:** a PASS earned under delta/region/cycle-rejected narrowing can no longer seed the ledger (eligibility requires full gating scope).
- **Manifest blind spots:** pure renames / binary / mode-only diff entries (dropped by diff-facts) now block the serve via a `diff --git` header-count guard; hashing switched to RAW BYTES (utf8-decode collided distinct invalid-UTF-8 contents); lstat errors other than ENOENT/ENOTDIR are "unreadable", not "deleted"; `__proto__` filenames get real manifest entries (null-prototype record + hasOwn lookups).
- **Region-memory contamination:** state now persists RAW dispositions; regions are DERIVED at read time, so a superseded disposition leaves nothing behind. INFO findings are excluded from the harvest (anti-padding). The harvest is skipped when pending.json was clobbered by an ERROR/timeout round (memory preserved).
- **Delta-scope alignment:** honors the `outOfDiffBlocking` escape hatch; never pushes a `demoted_from_critical` WARN to INFO (G0); the prior-blocking-files input now rides INSIDE the reviewed snapshot (`blocking_files`) instead of the ERROR-clobberable pending.json.
- **Cache-key completeness:** `rejectedRegions` folded into the byte-cache key (regionsSegment), like deltaScope.
- **Breaker math:** `region_suppressed_hits` is per-iteration (not cycle-cumulative — a cumulative count re-weighed against shrinking samples fires on healthier rounds); the FP-churn guard survives pending.json clobbering (max of fresh recompute and folded history); hard cap is `min(maxIter*2, maxIter+2)` so maxIterations=1 repos are not extended.
- **Accepted residual:** an OLD reviewgate binary parsing the new state.json strips the five new fields on its next write (zod unknown-key stripping) — forward compat is out of scope; deployments here use a single symlinked binary.

### Final verification (Definition of Done)

- [ ] `bunx tsc --noEmit` clean, `bun run lint` clean, full `bun test` green.
- [ ] Adversarial multi-agent review workflow (ultracode) over the full diff: independent refuters per slice boundary (fail-open hunting: can any new pass suppress security? does any reset site miss a new state field? badge honesty?).
- [ ] DoD review pipeline per user CLAUDE.md: Codex review (inline diff, no shell), Claude reviewer ×1 — findings to `.review/`, all PASS; consume all findings, THEN `rm -rf .review/` (cleanup is scoped to after the required outputs are read — codex I5).
- [ ] **Commit strategy (codex W8): NO intermediate per-task commits.** The tightly-coupled state-schema migration lands atomically — ONE final local commit after the full DoD passes, detailed body listing T0–T7. No push without explicit permission.
- [ ] Reviewgate dogfood gate (Stop hook) passes on the session's own diff.
- [ ] Commit locally. NO push without explicit permission.

---

# FOLLOW-UPS (documented, not this session)

**P2:** R8 contradiction-candidate badge + flip-flop escalation (deps R4); R9 sliding-window location keys for location-recurrence; R10 whole-cycle adjudication memory in the reviewer prompt (deps R4); R11 degraded-panel FAIL-path banner; R12 bounded pre-panel defer when a calibrated high-precision member is quota-capped (deps R11-adjacent constants); R13 advisoryCategories policy demote (needs sign-off decision 3); R14 imported in-repo definitions as bounded reviewer context (fixes tsconfig-alias blindness, extends imports.ts/collaborators.ts); R15 context-blind demote (self-admitted "not shown" + provably-injected definition; deps R14).

**P3:** R16 audit-precision as second clamp evidence source (default OFF, flip via R5's counter); R17 per-finding "uncorroborable — high-precision member absent" advisory (deps R11); R18 taste-calibration preamble line + bench ablate toggle; R19 panel-noise memory carried across post-escalation re-arm (deps R4, R8).

**Known residual gaps (accepted for now, from the critic):** cannot-verify findings whose deciding definition genuinely can't be injected still gate (preamble/confidence-floor idea unsliced); single flip-flop yields a badge, escalation at the 2nd hit; panel token cost per FAIL round unchanged (R2 narrows gating scope, not reviewer input); region memory is cycle-scoped (cross-cycle FP return only covered by houseRules); `MIN_DECISIONS_FOR_REJECT_RATE=4` hardcoded (a 3-finding round rejected 100 % can't fire); ERROR rows break recurrence streaks (skip-vs-append semantics unaddressed); stale ESCALATION.md after re-arm.

**Per-repo config guidance for the field repo (no code):** enable `phases.critic` (bench-proven: −8 FPs, zero recall cost) and `phases.collaboratorContext`; add a houseRules entry for the fragmenting FP class the banner identified.

**Open field-data questions (answer from the FlashBuddy repo's `.reviewgate/` before tuning further):** did the agent's rejections carry `reviewer_was_wrong:true` (decides how much R6 vs R19 mattered)? What were the severities/categories of the 13 fragmented findings (decides whether R4's correctness tier or the G0b ceiling binds)?
