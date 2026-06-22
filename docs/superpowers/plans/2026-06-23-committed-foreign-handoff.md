# Committed-Foreign Honest Handoff Implementation Plan (v2 — post Plan-Gate)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Make a parallel agent's already-committed work in a shared checkout survivable — give the reporting session an honest, turn-releasing handoff that **escalates to a human and never fakes a PASS**, and stop the reviewer raising moot CRITICALs by feeding it the resolving artifacts.

**Architecture:** Three additive slices built strictly ON the shipped P1 baseline-delta ownership (`src/core/session-manifest.ts`). **S2** adds an `out-of-session` disown decision + `session-disowned` ALLOW_STOP escalation, gated ONLY on **sound *uncommitted* attribution signals** and **always escalating to a human**. **S3** injects resolving artifacts (referenced markdown/plan + cited code), untrusted-fenced. **S4** adds a render-only evidence-attestation badge. Every slice is render-only, additive-context, or escalate-to-human; **none demotes or releases based on committed-work attribution, which is unsound in a shared checkout.**

**Tech Stack:** Bun, TypeScript, zod schemas as source-of-truth, `bun test`, biome. Git via `src/utils/git.ts` helpers (fail-closed). Persistence = JSON files under `.reviewgate/`.

## Why v2 (what the Plan-Gate killed)

The v1 plan tried to *attribute committed work to a session* (S1 committed-foreign demote + a whole-diff guard that depended on it). The adversarial Plan-Gate verified, against real code, that this is **fundamentally fail-open**: a file authored purely via **Bash and then committed** is invisible to every attribution signal (`editedPathsOf` records only Edit/Write tool paths — `handlers.ts:40-56`; `workingTreeDirtyFiles` excludes committed files — `git.ts:384-395`; clean-start baseline is empty — `session-manifest.ts:121-143`). So:
- A Bash+commit session yields `attributable=∅` → could **disown its own committed CRITICAL** (S2 whole-diff guard circumvented).
- `owned_commits` (best-effort PostToolUse trigger) was the *sole* my-vs-theirs discriminator → a missed trigger **demotes the agent's own committed CRITICAL to INFO** (S1).
- "sec/corr stays blocking" did **not** contain the blast radius — a real CRITICAL filed under quality/perf/maintainability would still vanish.

**v2 resolution:** never auto-attribute or auto-demote *committed* work. Gate the honest handoff ONLY on **uncommitted** signals (which `dirty-now` captures soundly, Bash included) and make the release **a loud human escalation** (the existing ALLOW_STOP safe floor), never a silent pass. The residual — a Bash-only session disowning its own *committed* CRITICAL — surfaces to a human via ESCALATION.md (not hidden), the same risk class as the shipped `findings-out-of-scope` escalation.

## Global Constraints

- **No committed-work attribution.** Unsound in a shared checkout (shared committer identity, best-effort triggers). No `head_at_start`, no `owned_commits`, no per-file `git log` ownership probes, no committed-foreign demote.
- **Fail-safe direction only.** Every path either over-reviews (keeps blocking) or surfaces to a human (ESCALATION.md). No path may demote/auto-pass on a forgeable signal.
- **Sound attribution = uncommitted only.** `attributable = owned ∪ {baseline keys whose current hash ≠ baseline hash} ∪ {dirty-now files ∉ baseline}`. `dirty-now` = `workingTreeDirtyFiles` (= `git diff HEAD` + untracked) captures Bash *uncommitted* edits. This set provably contains the session's own LIVE work, so the agent can never disown a file it currently has uncommitted skin in.
- **Compute attribution ONCE, in the orchestrator, against `facts.files`** (the exact set the aggregator stamps and `whole_diff_attributable` derives from). `gate.ts` threads `sessionId` + the `dirtyNow` snapshot into the orchestrator input. Never split the computation across gate.ts/aggregator (drift = exploit).
- **Server-side, persisted, fail-closed readers.** The aggregator stamps `session_attributable` per finding + `whole_diff_attributable` top-level into `pending.json`. The decisions-gate reads persisted flags. **Polarity trap:** unlike `foreignFlagsById` (absent flag → `false`), the new `wholeDiffAttributable(repoRoot)` reader must default **absent/missing/malformed → `true`** (disown UNAVAILABLE). A naive copy = fail-open in single-agent + every cache-hit/ERROR write.
- **Always escalate, never silent-pass.** `session-disowned` is ALLOW_STOP: writes ESCALATION.md, does NOT set `passed=true`, does NOT re-arm budget, does NOT clear pending. Findings stay surfaced.
- **Zero behavior change for single-agent clean-start.** Empty manifest / no `session_id` / scoping off → `whole_diff_attributable` absent → reader returns `true` → disown unavailable → identical to today.
- **Reputation-neutral disowns.** Exclude `out-of-session` in `src/core/reputation/learn.ts` exactly like `out-of-scope`/`verified-not-applicable`.
- **Codex strict-mode (S4):** every object node needs `additionalProperties:false` + every key in `required`; optional = nullable type. Keep `evidence_line` a FLAT nullable string. Update `tests/unit/review-output-schema.test.ts`; verify a real codex call when quota returns (Jun 24) or document the deferral.
- `bunx tsc --noEmit` AND `bun run lint` clean after every slice; full `bun test` green before "done".

## Do-NOT-touch invariants (regression guards)

- P1 `computeForeignFiles` byte-identity model (`session-manifest.ts:187-199`, byte check at :196) — additive only.
- Aggregator foreign demote (`aggregator.ts:619-638`) — demote-only, G0-exempt, honors `outOfDiffBlocking`; reuse, don't weaken. **Do NOT route any committed-work into `input.foreignFiles`** (it tags `foreign_to_session` → grants out-of-scope).
- Lone-CRITICAL hard-FAIL (`aggregator.ts:~910-924`) — no new suppressor here.
- Out-of-scope gate (`loop-driver.ts:563-571`) — persisted `foreign_to_session` only; new `out-of-session` uses its OWN persisted-flag gate.
- `findings-out-of-scope` ALLOW_STOP (`loop-driver.ts:54-65,1203-1214`) + render (`report-writer.ts:575-580`) — build alongside; it terminates via the existing `escalation_announced` + dirty-flag-unlink + re-arm machinery (`loop-driver.ts:833-859`) with NO cap — mirror that, add NO new cap.
- N2 `acknowledged-low-value` / P6 `verified-not-applicable` gates — intact.

---

## Plan-Gate v2 refinements (PASS-conditioned — MUST land during S2/S3/S4)

The v2 re-gate PASSed (all 6 v1 CRITICALs closed by construction, no silent-hide fail-open). These 7 should-fixes are baked in:

- **R1 (S2.4, load-bearing — own-work-disown vector):** path-space drift. `dirtyNow = workingTreeDirtyFiles` returns RAW git paths (no `safeRel`); `owned`/baseline keys are `normalizeRepoPath`-canonicalized. Apply ONE canonicalization (`normalizeRepoPath` against repoRoot) to BOTH every attributable-set member (normalize `dirtyNow` too) AND `finding.file` in the membership test — identical to `aggregator.ts:623`. Test: raw-vs-canonical / symlinked-root paths → an OWNED file is NEVER stamped `session_attributable=false`.
- **R2 (S2.6, load-bearing):** deterministic non-disownability. `loop-driver.ts:550` fires ONLY for `verdict==="rejected" && deterministic`. An `out-of-session` is `verdict==="accepted"`, so :550 does NOT cover it. Add an explicit `metaOf(id)?.deterministic → invalid (continue)` guard INSIDE the new `out-of-session` accept branch (mirror the out-of-scope `!meta.foreign` gate). Test: deterministic finding → `out-of-session` REJECTED.
- **R3 (S2.6):** add the `gate.invalid.length===0` precondition to the `session-disowned` routing branch (mirror `allUnaddressedForeign` at `loop-driver.ts:1194`). Test: all-non-attributable + one malformed decision line → `decisions-unaddressed` firm (not ALLOW_STOP).
- **R4 (S2.6):** source `session_attributable` from the SAME single pending.json read — extend the existing lazy `findingMeta` map (`loop-driver.ts:499-533`, already loads severity/highStakes/deterministic/foreign) with `session_attributable`; memoize `wholeDiffAttributable(repoRoot)` ONCE per `evaluateDecisions` call. Avoids N+1 parses + guarantees one consistent snapshot.
- **R5 (S2.7):** `escalateAndDecide` has no message arm for `session-disowned` → it falls through to the generic "reviewer panel UNRELIABLE … disable/replace that reviewer" copy (`loop-driver.ts:1974-1979`), which is wrong (nothing is wrong with the panel). Add a `reasonCode==="session-disowned"` arm beside the `findings-out-of-scope` arm (~1968-1972) with a non-accusatory committed-foreign message. (Also: confirm `"session-disowned"` is in `ALLOW_STOP_ESCALATIONS` or it block-loops.)
- **R6 (S4.3/S4.4):** the null-evidence `self-attested` badge risks badge-spam (claude/gemini routinely null optional fields on REAL CRITICALs → "verify" noise). Gate it behind a config flag **default OFF**, OR render only when the finding ALSO lacks any structured `code_ref`/snippet. Measure the real badge rate in S4.4 before any default-on. (`evidence_mismatch` on a CLEAR mismatch stays default-on — it's precise.)
- **R7 (S3.1):** DOC_EXT widens the extraction surface (more in-repo `.md`/`.txt` tokens match). The `plan-refs.ts` read path is extension-independent so the gitignore gate / O_NOFOLLOW / `..`-reject / neutralize+defang all carry — but the S3.1 test MUST assert the SAME caps apply to doc refs (oversize drop, count cap, `.reviewgate/` exclude, gitignore drop).

---

## Slice S2 — Honest `out-of-session` handoff (escalate-only, sound)

### Design

**Attribution set (sound, uncommitted only), computed once in the orchestrator over `facts.files`:**
```
attributable = owned                                   // Edit/Write tool paths
             ∪ { k ∈ baseline : currentHash(k) ≠ baseline[k] }   // net-changed since SessionStart
             ∪ { f ∈ dirtyNow : f ∉ baseline }         // created/first-touched this session (incl. Bash uncommitted)
```
- Per finding: `session_attributable = (finding.file ∈ attributable)`.
- Top-level: `whole_diff_attributable = (attributable ∩ facts.files) ≠ ∅`.
- **Fail-closed:** any error / no manifest → `computeSessionAttributableFiles` returns `new Set(facts.files)` (everything attributable → disown unavailable). `facts.files` is ALWAYS the real changed-file list (never empty-on-error), so the fail-closed set is never wrongly empty.

**`out-of-session` acceptance (in `evaluateDecisions`):** accept ONLY when
`finding.session_attributable === false` **AND** `wholeDiffAttributable(repoRoot) === false` (dedicated reader, absent→true). Deterministic-check findings remain non-disownable (existing guard at `loop-driver.ts:550`).

**Routing (stop_hook_active branch ~`loop-driver.ts:1203`), explicit precedence:**
1. `allUnaddressedForeign` (every missing blocking finding `foreign_to_session===true`) → **`findings-out-of-scope`** (already-shipped, narrower, precise message). Checked FIRST.
2. else `whole_diff_attributable===false` AND every missing blocking finding `session_attributable===false` → **`session-disowned`** (ALLOW_STOP, new).
3. else → `decisions-unaddressed` (firm).
Both 1 and 2 are ALLOW_STOP (same outcome: release-to-human); only the message differs. No cap — termination via the existing `escalation_announced` re-arm, exactly like `findings-out-of-scope`.

**Why sound (fail-safety):**
- It's a human ESCALATION, never a PASS — findings stay in `pending.json` + ESCALATION.md; nothing is hidden.
- The accept gate uses only the SOUND uncommitted set, so the agent can never disown a file it currently has uncommitted skin in (own LIVE edits are in `owned`/`dirty-now`/net-changed → attributable → REJECTED).
- Residual: a session that did ALL its work via Bash AND committed it (nothing left uncommitted) could disown its own committed finding → but that's a **loud human escalation**, the same safe floor `findings-out-of-scope` already accepts. Never a silent hide/demote.
- Single-agent: `whole_diff_attributable` absent → reader returns `true` → disown unavailable → unchanged.

### Files
- Modify: `src/schemas/decision.ts` (`out-of-session` action + reason≥20 superRefine)
- Modify: `src/schemas/state.ts` (`session-disowned` EscalationReason)
- Modify: `src/schemas/finding.ts` (`session_attributable: z.boolean().optional()`)
- Modify: `src/schemas/pending-report.ts` (top-level `whole_diff_attributable: z.boolean().optional()`)
- Modify: `src/core/session-manifest.ts` (`computeSessionAttributableFiles(repoRoot, sessionId, diffFiles, dirtyNow)`)
- Modify: `src/cli/commands/gate.ts` (capture `dirtyNow` snapshot + `sessionId`; thread into orchestrator input — NOT compute here)
- Modify: `src/core/orchestrator.ts` (compute attribution over `facts.files`; stamp findings; pass `whole_diff_attributable` to report-writer; thread input fields)
- Modify: `src/core/aggregator.ts` (stamp `session_attributable` from the provided set; never touch `foreignFiles`)
- Modify: `src/core/loop-driver.ts` (`wholeDiffAttributable` reader [absent→true]; `out-of-session` accept; routing; ALLOW_STOP set)
- Modify: `src/core/report-writer.ts` (session-disowned human-actions block + `out-of-session` hint; persist `whole_diff_attributable`)
- Modify: `src/core/reputation/learn.ts` (exclude `out-of-session`)
- Tests: `tests/unit/session-attribution.test.ts`, `tests/unit/decision-out-of-session.test.ts`, `tests/unit/loop-driver-session-disowned.test.ts`, `tests/unit/whole-diff-attributable-reader.test.ts`, extend report-writer tests

### Tasks

**Task S2.1 — Schema: `out-of-session` action**
- [ ] Test (`decision-out-of-session.test.ts`): `out-of-session` + reason≥20 parses; reason<20 / 20-spaces / missing → fail superRefine.
- [ ] Implement (mirror `out-of-scope` enum entry + superRefine branch; message: "not my session's work — a parallel agent's committed work in a shared checkout"). Run → PASS. Commit.

**Task S2.2 — Schema: flags + escalation reason**
- [ ] Test: `FindingSchema` accepts `session_attributable`; `PendingReportSchema` accepts top-level `whole_diff_attributable`; `EscalationReason.parse("session-disowned")` ok.
- [ ] Implement (with doc comments). Commit.

**Task S2.3 — `computeSessionAttributableFiles` (fail-closed)**
- [ ] Test (`session-attribution.test.ts`, temp repo + manifest fixtures): owned→attributable; baseline changed→attributable; baseline byte-identical→NOT; dirtyNow∉baseline→attributable; diff file none-of-the-above→NOT; no/unreadable manifest→`new Set(diffFiles)` (all attributable); empty `diffFiles` arg with a real manifest still returns whatever owned/dirty say (never silently empty on the error path — assert the error path returns `new Set(diffFiles)` with a NON-empty diffFiles fixture).
- [ ] Implement next to `computeForeignFiles`; try/catch → `new Set(diffFiles)`. Commit.

**Task S2.4 — Orchestrator computes + stamps; report persists `whole_diff_attributable`**
- [ ] Test: aggregate() given `attributableFiles` + `diffFiles` stamps `session_attributable` per finding and the report carries `whole_diff_attributable = (attributable ∩ diff ≠ ∅)`; absent set (single-agent) → flags undefined, `whole_diff_attributable` omitted.
- [ ] Implement: in the orchestrator, after `computeDiffFacts`, call `computeSessionAttributableFiles(repoRoot, sessionId, facts.files.map(f=>f.path), dirtyNow)`; pass set + `facts.files` paths into aggregate input; aggregator stamps; report-writer persists the top-level flag. `gate.ts` threads `sessionId` + `dirtyNow` (from `workingTreeDirtyFiles`) into the orchestrator input. Gate behind `scopeToSession`.
- [ ] Run → PASS. Commit.

**Task S2.5 — `wholeDiffAttributable` reader (absent→true)**
- [ ] Test (`whole-diff-attributable-reader.test.ts`): pending.json with `whole_diff_attributable:false`→false; `:true`→true; KEY ABSENT→true; missing file→true; malformed JSON→true.
- [ ] Implement a loose reader (mirror `foreignFlagsById` STRUCTURE but **default true**). Commit.

**Task S2.6 — loop-driver: accept `out-of-session` + route `session-disowned`**
- [ ] Test (`loop-driver-session-disowned.test.ts`):
  - accept: `out-of-session` on `session_attributable:false` finding WITH `whole_diff_attributable:false` → satisfies gate; on attributable finding → REJECTED; with `whole_diff_attributable:true` → REJECTED (the mixed-diff guard).
  - route: stop_hook_active + all missing blocking non-attributable + whole_diff false → `session-disowned` ALLOW_STOP, `passed` unset, dirty.flag/pending intact.
  - precedence: all-missing-foreign_to_session → `findings-out-of-scope` (not session-disowned); deterministic finding → non-disownable.
- [ ] Implement: `out-of-session` accept branch in `evaluateDecisions` (reads `session_attributable` via `metaOf` + `wholeDiffAttributable(repoRoot)`); routing per the precedence above; add `"session-disowned"` to `ALLOW_STOP_ESCALATIONS`; NO cap.
- [ ] Run → PASS. Commit.

**Task S2.7 — report-writer + reputation + hint**
- [ ] Test: ESCALATION.md `session-disowned` renders the non-accusatory block; GATE-CLOSED message names the `out-of-session` verb when a non-attributable finding is among the missing AND `whole_diff_attributable:false`; `learn.ts` ignores `out-of-session`.
- [ ] Implement. Run → PASS. Commit.

---

## Slice S3 — Resolving-artifact context enrichment

Independent. Real fix for P3/P4. Non-suppressing (additive context only).

### Design
1. `plan-refs.ts`: add `DOC_EXT = "md|mdx|txt|rst"` to the extracted set (today only `CODE_EXT`), so referenced spec/plan paths in the diff/plan text are pulled in. Keep the untrusted-fence + gitignore gate + O_NOFOLLOW read.
2. Config-gated **default-OFF** sibling-commit walk (`docReview.walkSiblingPlanCommits`): inject plan/spec `.md` files changed in commits since the review base (the "resolved in a later plan commit 0dfc321d" case). Touches commit-walk logic → gated OFF; git error → inject nothing (fail-safe).
3. All enrichment UNTRUSTED — `neutralizeInjectionMarkers`/`neutralizeFences`/`defangSentinels` (already in plan-refs) + persona reaffirmation.
4. Strengthen `REVIEW_PROMPT_PREAMBLE`/`DOC_REVIEW_PROMPT_PREAMBLE` (`orchestrator.ts:240,285`): "A later plan/spec commit may already resolve this. If the deciding artifact was provided, verify before raising; if it was NOT provided, lower confidence/severity rather than asserting the premise as fact."

### Files
- Modify: `src/research/plan-refs.ts` (DOC_EXT)
- Modify: `src/core/orchestrator.ts` (preamble; optional gated sibling-commit wiring)
- Modify: `src/utils/git.ts` (plan/spec files changed since base — only for the gated walk)
- Modify: `src/config/defaults.ts` + schema (`walkSiblingPlanCommits` default false)
- Tests: extend `tests/unit/plan-refs.test.ts`; `tests/unit/orchestrator-enrichment.test.ts`

### Tasks
**Task S3.1 — markdown refs (default ON)**: test extract+inject a referenced `.md` (fenced/defanged), still drop `.reviewgate/`/gitignored/oversize, reject `..`. Implement `DOC_EXT`. Commit.
**Task S3.2 — preamble directive (default ON)**: test the rendered preamble contains the "later plan/spec commit may resolve … lower confidence if not provided" directive. Implement. Commit.
**Task S3.3 — sibling-commit walk (default OFF) — DEFERRED.** On honest analysis the value is marginal and the mechanism fuzzy: at spec-review time the *resolving* plan commit usually does not exist yet, and a sibling commit already in `base..HEAD` is in the reviewed diff already — so the walk rarely surfaces a NEW resolving artifact. It also touches base/commit-walk logic (the Plan-Gate flagged it "speculative — gate OFF until proven"). Deferred as a follow-up rather than shipping default-OFF code of unproven value. S3.1 (referenced doc/plan injection) + S3.2 (the directive) deliver the sound P3/P4 win.

---

## Slice S4 — Render-only evidence-attestation badge

Render-only — zero severity change. Makes the P4 moot/good split visible (S3 is the real fix).

### Design
1. `REVIEW_OUTPUT_SCHEMA` (`review-output.ts`): add OPTIONAL nullable FLAT `evidence_line` (`type:["string","null"]`, listed in `required`, parent keeps `additionalProperties:false`). Update structural guard test.
2. Preamble: "For any CRITICAL/WARN, quote in `evidence_line` the exact source line you rely on. If the deciding line/artifact was NOT provided, set it null and lower confidence — do not assert a blocking defect on absent context."
3. `fact-check.ts` (`attestEvidence`, a NEW render-only pass, separate from the demote-direction `validateFindingFacts`): badge `evidence_mismatch` ONLY when the (defanged, whitespace-normalized) `evidence_line` matches **NO line of the cited file** — a strong stale/absent/fabricated-context signal. A match at the cited line, a match at ANY other line (a moved/deleted pre-image the agent relocated), out-of-range, unreadable, or absent `evidence_line` → no badge. **NO severity change.** **R6: the null-evidence `self-attested` badge was DROPPED** — it would spam every real CRITICAL a non-strict reviewer left null; the directive's confidence-drop is the signal instead. `evidence_mismatch` is precise → default-on (no config flag).
4. Defang `evidence_line` via `neutralizeInjectionMarkers`/`neutralizeFences` before compare (the badge text is fixed — no reviewer content rendered).

### Files
- Modify: `src/providers/review-output.ts` (schema + parsed type)
- Modify: `src/core/orchestrator.ts` (preamble)
- Modify: `src/core/fact-check.ts` (cross-check → badge)
- Modify: `src/core/report-writer.ts` (render badge)
- Modify: `tests/unit/review-output-schema.test.ts`
- Tests: `tests/unit/evidence-attestation.test.ts`

### Tasks
**Task S4.1 — schema field (strict-mode safe)**: structural test asserts every object node has `additionalProperties:false` + all keys in `required` incl. `evidence_line`; fails if `evidence_line` omitted from `required`. Parse finding with/without. Implement (flat nullable string). Commit.
**Task S4.2 — preamble directive**: test preamble mentions `evidence_line` quoting + null-on-absent-context. Implement. Commit.
**Task S4.3 — deterministic cross-check (render-only)**: tests — matching quote→no badge, full severity kept (lone CRITICAL still hard-FAILs); clear mismatch→`evidence_mismatch`, severity UNCHANGED; null on blocking→`self-attested` badge; whitespace-only diff / absent line / **deleted-line (quote exists in diff but not at cited working-tree line)** / null on INFO → no badge. Implement; defang first. Commit.
**Task S4.4 — real codex schema verification**: when quota returns, one real `codex exec` review confirms no HTTP 400. If still quota'd, document the deferral.

---

## Sequencing & DoD

**Order:** S2 → S3 → S4 (all independent and sound; ship together). Each slice: `tsc` + `lint` + full `bun test` green, then commit. After all three: full Definition-of-Done (codex×2 if quota returned, else adversarial Opus×2 panel) + dogfood gate. **Re-run the adversarial Plan-Gate on THIS v2 before implementing** (v1 FAILED). 

**Documented residual (intended):** a MIXED diff (own uncommitted work + a parallel agent's foreign *committed* finding) is NOT releasable via `out-of-session` (the session has uncommitted skin → `whole_diff_attributable=true`). The agent must address it, stash/commit its own work then disown, or `reviewgate reset`. This is the SAFE residual — the Plan-Gate proved the auto-handling of this case (committed-foreign demote) is unsound. The reported incident (pure-foreign turn) IS fully fixed.

## Self-review notes
- Spec coverage: P1/P2/P5 → S2 honest handoff; P3 → S3; P4 → S3 (+ S4 visibility). Reported incident → S2.
- No committed-work attribution anywhere (the v1 fail-open class is gone by construction).
- No new suppressor on lone-CRITICAL hard-FAIL (S4 render-only; S3 additive context).
- Type consistency: `session_attributable` (finding) / `whole_diff_attributable` (report, absent→true) / `out-of-session` (action) / `session-disowned` (escalation) used identically across schema, orchestrator, aggregator, loop-driver, report-writer.
