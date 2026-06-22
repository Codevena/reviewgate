# Reviewgate Multi-Agent Ownership Remediation Plan (2026-06-22)

Field report: an agent used Reviewgate in a **shared multi-agent checkout**. Its own
feature ran isolated in a worktree (separate manual DoD) and merged before the gate
fired. Reviewgate only fired in the shared MAIN checkout — on the **uncommitted work of
a parallel agent** — blocked the reporting agent's turn for findings it never authored,
then escalated ("the gate gave up … is no longer reviewing your changes") and gave it no
honest "not mine" exit (only: lie via `reviewer_was_wrong`, overreach into foreign code,
or leave standing → escalate).

## Root cause (verified in code)

Reviewgate has **no session-ownership model**. The Stop review scopes to the *entire
working-tree diff since the review base* (`collectDiff`, `src/utils/git.ts:207-361`) with
zero per-agent attribution. `handleTrigger` (`src/hooks/handlers.ts:46-106`) only
`sha256`-hashes the PostToolUse stdin (line 49) — it never reads `tool_input.file_path`.
`state.json` + `dirty.flag` are per-checkout singletons. Every reported symptom is
downstream of the gate not knowing which uncommitted changes *this* session authored.

## Locked decisions (from the maintainer, 2026-06-22)

1. **Ownership posture:** foreign-file findings (files this session did not edit, per the
   manifest) → demote to advisory INFO (non-blocking) + an honest manifest-gated
   `out-of-scope` decision (allowed even on CRITICAL/security), bounded + surfaced to the
   human. **Fail-CLOSED when the manifest is unknown/incomplete → full review (today's
   behavior).**
2. **P4 lone CRITICAL:** annotate, do **not** downgrade. Verdict math unchanged (hard
   FAIL stays — zero PR#22 regression); add a render-only honest badge + reject off-ramp.
3. **Defaults:** session-scoping (P1) and docs-cap (P5) **ON by default** (fail-safe by
   construction; mirrors `scopeToDiff:true` / `demoteTestSecurity:true`).

## Plan-Gate outcome (2026-06-22, adversarial opus panel — codex quota-locked)

Verdict **FAIL** on the first draft. **Slices C/D/E CONFIRMED SOUND** (implement now, with
S5/S6/S8 test polish). **Slices A/B redesigned** to close 5 CRITICAL + 5 WARN fail-opens:

- **M1** global manifest can't attribute ownership in a shared checkout → **session-keyed**.
- **M2** Bash/sed/script edits to tracked files aren't captured by `tool_input.file_path`
  → would demote a real agent-authored CRITICAL. **Resolved by the baseline-delta design
  below** (any authored change alters the file's content hash → never demoted), which is
  strictly better than the gate's proposed "force full-review on any gap" (that is *inert*
  for the reported case).
- **M3** cache poisoning: a manifest-demoted PASS cached under a manifest-less key → fold
  the session-scope signature into `computeCacheKey` (like config is).
- **M4** deferred/HEAD-advanced synthesis paths → auto-safe (they review committed files,
  which are never working-tree-dirty → never in baseline → never demoted) + belt: disable
  manifest-demote on synthesized flags.
- **M5** re-arm clearing → baseline-delta is robust across re-arms (a re-edited file's hash
  differs from baseline → reviewed), so no stale-manifest fail-open; baseline lives for the
  SESSION (reset at SessionStart only).
- **M6** `reputation/learn.ts` must exclude the `out-of-scope` action (else reputation poison).
- **M7/M8** out-of-scope gate must read a **snapshotted** `foreign_to_session` flag on the
  finding (set at review time, persisted in pending.json), NOT re-derive live next turn.
- **M9** `consecutive_out_of_scope` reset pinned to BOTH re-arm sites.
- **M10** path normalization: `handleTrigger` stores repo-relative paths only; absolute →
  relativize or `complete:false`.
- **S1** the manifest demote is STRUCTURAL (like off-diff): → INFO, NO `demoted_from_critical`,
  G0-EXEMPT (foreign = out of scope, not a value judgment).

## Prime directive (every slice)

Nothing may let a real CRITICAL slip **silently**. Every scope/severity change is
**DEMOTE-only** (never drop a blocking finding to nothing), **fail-CLOSED on missing
data**, honors the existing `outOfDiffBlocking` security/correctness escape hatch, and
respects **G0** (a value-judgment demote of a from-CRITICAL never lands below WARN and
always carries `demoted_from_critical:true`, so it stays SOFT-PASS-blocking + decision-
required and cannot auto-hide under `softPassPolicy:"allow"`).

The "config gotcha": new `phases.review.*` BOOLEAN flags use `z.boolean().optional()` in
`define-config.ts` **+** a value in `defaults.ts` — NEVER `.default(...)` inline (that
makes the field required in the output type and breaks ~30 partial-config fixtures).
`loop.*` NUMBER flags and persisted `state.ts` fields MAY use `.default(...)`
(`ReviewgateStateSchema.parse` self-heals).

---

## Build order (TDD per slice; failing test first)

Independent quick wins first (each verifiable in isolation), keystone, then the layer
that depends on it. **Slices A+B land in ONE branch** (B is fail-CLOSED without A's
manifest). C/D/E are independent.

1. **E (P6)** — exclude `.review/` scratch dir
2. **D (P5)** — docs severity cap
3. **C (P4)** — lone-CRITICAL honest framing
4. **A (P1)** — per-session file manifest + advisory scope-demote (keystone)
5. **B (P2+P3)** — out-of-scope verdict + de-fanged escalation (depends on A)

---

### Slice E — P6: exclude `.review/` scratch dir (independent quick win)

Pure coverage subtraction, mirroring the existing `.reviewgate` / `.antigravitycli`
exclusion. The user's DoD scratch dir (`.review/`, `rm -rf`'d before commit) must not
enter the reviewed diff **or the cache key** in repos that don't gitignore it.

- `src/utils/git.ts` `EXCLUDE_PATHSPEC` (72-80): add `:(exclude).review`,
  `:(exclude).review/**`, `:(exclude)**/.review`, `:(exclude)**/.review/**`.
- `isExcludedFromReview` (82-89): add `path === ".review" || path.startsWith(".review/")
  || /(^|\/)\.review(\/|$)/.test(path)` — the untracked side (`git.ts:298`) needs this or
  a `.review/` file in a non-gitignoring repo still leaks. **Must mirror EXCLUDE_PATHSPEC
  exactly** (the `git-exclude-pathspec-shared.test.ts` lockstep invariant).
- No config (hard-coded like `.reviewgate`). `collectDiff` takes no config today;
  threading a configurable `scratchPaths` glob is deferred until a second name appears.

**TDD / tests:** `tests/unit/git-exclude-pathspec-shared.test.ts` — update the pinned
`toEqual([...])`. ADD behavioral cases: untracked `.review/plan-gate-x.md` absent from
`collectDiff`; nested `sub/.review/foo.md` excluded; **`review-notes.md` (no dot, not a
`.review` dir) STILL reviewed** (over-broad-match guard); tracked `.review/` mirror of
the `.reviewgate/state.json` exclusion test.

**Risks:** over-broad glob hides real source → scope strictly to the literal `.review`
dotdir, never `tmp/`/`scratch/`/`**/review/**`. Empty-after-exclusion diff must clean
allow-stop and must NOT trip the diff-incomplete fail-CLOSED path (pathspec exclusion
doesn't set the incomplete marker — verify).

---

### Slice D — P5: docs severity cap (demote-only, independent)

New pass in `aggregator.ts` between `testScoped` (786-801) and the verdict loop (803),
mirroring `demoteTestSecurity`.

- Fire when `classify(f.file) === "docs"` (the FILE class, `diff-facts.ts` — NOT the
  reviewer-supplied `f.category`, which could be mis-tagged to soften prod code) AND
  `severity === "CRITICAL"`.
- **EXEMPT (leave CRITICAL) when `touchesSecurityOrCorrectness(f)`** (rep AND every merged
  member) — the load-bearing nuance: a markdown file can hold a leaked secret / dangerous
  command. (The report's blunt "docs never CRITICAL" is wrong; this is the corrected form.)
- Else `demoteOneStep` → **WARN** (not INFO — a stale doc is over-severity, not an FP;
  keep it blocking + decision-required), stamp `docs_severity_capped:true` +
  `demoted_from_critical:true` (G0), truncate-safe note.
- `src/schemas/finding.ts`: add `docs_severity_capped: z.boolean().optional()`.
- Wire `capDocsSeverity` through `AggregateInput` + the `orchestrator.ts` aggregate call
  (mirror `demoteTestSecurity`). `report-writer.ts` badge.

**Config:** `phases.review.capDocsSeverity` — `z.boolean().optional()` + `true` in
`defaults.ts`.

**TDD / tests:** new `tests/unit/aggregator-docs-cap.test.ts` mirroring
`aggregator-test-severity.test.ts`: caps `README.md`+quality CRITICAL→WARN (no singleton
FAIL); does NOT cap `SECURITY.md` security CRITICAL; does NOT cap correctness on a doc;
does NOT cap CRITICAL on a code file; inverse-masking (docs cluster rep=quality but
member=security stays blocking); `*.md` under `tests/` classifies `tests` so the cap does
NOT fire; no-op when flag absent; badge renders. Config round-trip + full `bun test`
(schema change touches fixtures).

**Risks:** a credential in a README tagged `quality` gets capped → bounded by
WARN-still-blocks; optionally add the `SECRET_LEAD_WORD` (`aggregator.ts:317`) positive
backstop. Capping to INFO would auto-hide under `softPassPolicy` → **cap to WARN**. vs
PR#22: the cap fires BEFORE the verdict loop so a capped docs finding no longer hits
`reviewersTotal<=1`; the security/correctness exemption preserves PR#22 for dangerous docs.

---

### Slice C — P4: lone-CRITICAL honest framing (annotate, don't downgrade — independent)

Reconciles with PR#22 by keeping the verdict math **unchanged**.

- `src/core/aggregator.ts` verdict gate (808-844): KEEP `reviewersTotal <= 1 → fail=true`
  (818-825) exactly. When a lone **non-security/correctness** CRITICAL trips it, ALSO
  stamp `lone_critical_uncorroborated:true`, using the SAME `touchesSecurityOrCorrectness(f)`
  predicate as line 811 (a security-bearing cluster is NOT tagged — it blocks as a full
  security CRITICAL). Tag via a shared helper so the badge can't desync from the FAIL reason.
- `src/schemas/finding.ts`: add `lone_critical_uncorroborated: z.boolean().optional()`.
  Render-only; never changes the verdict.
- `src/core/report-writer.ts` `findingBadges`: badge "🚧 lone CRITICAL — single reviewer,
  uncorroborated; verify the cited code yourself, then accept (action:fixed) or reject
  (reviewer_was_wrong) with a concrete reason." Render only when `severity===CRITICAL &&
  reviewersTotal<=1 && !sec/corr` (NOT after `confidenceFloor` already clamped to WARN).

**Config:** NONE (no verdict change → nothing to toggle; a knob to weaken the hard block
would re-open PR#22).

**TDD / tests:** `tests/unit/aggregator.test.ts`: 1 reviewer + CRITICAL quality → FAIL +
flag set; CRITICAL security/correctness → FAIL + flag NOT set; rep=quality but merged
member security → FAIL, NOT tagged; multi-reviewer singleton non-sec/corr → SOFT-PASS, NOT
tagged; low-confidence non-sec/corr CRITICAL → confidenceFloor clamps to WARN, NOT double-
stamped lone. **The existing PR#22 regression test must keep passing unchanged.** Badge
test in `report-writer.test.ts`.

**Risks:** verdict math unchanged → ZERO PR#22 regression. The badge naming the reject
off-ramp could nudge reflexive `reviewer_was_wrong` — bounded by the reject-rate /
fp-streak breakers + the G0b `cycleRejected` ceiling. P4 only softens FRAMING; foreign
code is resolved by Slice A.

---

### Slice A — P1 keystone: session-keyed baseline-delta ownership + advisory scope-demote

**Ownership model (baseline-delta — closes M1/M2/M4/M5 by construction):** a diff file is
FOREIGN to this session iff it was **already working-tree-dirty when this session started
AND its content is unchanged since then AND this session did not tool-edit it**. Anything
this session authored (Edit OR Bash) changes the content hash → never demoted. Files that
became dirty during the session (this session's edits, or — racily — a parallel agent's)
→ reviewed (over-review = safe). Committed/HEAD-advanced files are never working-tree-dirty
→ never in baseline → never demoted.

- **New `src/schemas/session-manifest.ts`:** zod
  `{ schema:"reviewgate.session-manifest.v1", session_id:string, baseline: Record<string,string>
  (repo-relative path → sha256 of content at session start), owned: string[] (repo-relative
  tool-edited paths) }`.
- **`src/hooks/handlers.ts` `handleReset` (SessionStart, 117-161):** capture the baseline —
  `workingTreeDirtyFiles(repoRoot)` (already in git.ts), hash each file's current content
  (bounded; skip unreadable/oversize → omit = treat as owned later, safe), write
  `.reviewgate/sessions/<session_id>.json`. **session_id from the SessionStart stdin** (parse
  it; absent → write no manifest → gate fail-closes to full review). SessionStart runs BEFORE
  any edit, so the baseline excludes this session's own work. ALSO prune session files older
  than a TTL (e.g. 7d) so they don't accumulate; do NOT wipe OTHER sessions' files (fixes S9).
- **`src/hooks/handlers.ts` `handleTrigger` (PostToolUse, 46-106):** parse stdin; extract
  `tool_input.file_path` / `notebook_path` / `edits[].file_path`; canonicalize via
  `normalizeRepoPath(p, repoRoot)`, **assert repo-relative** (not `/`-absolute or `../` —
  else skip that path; M10); union into the current session's `owned[]` (read-modify-write
  with the unique-temp+rename pattern, or append-log). session_id from the PostToolUse stdin.
  Keep the existing dirty.flag write unchanged.
- **`src/cli/commands/gate.ts` `gatherReviewContext` (~435-568):** parse session_id from the
  Stop stdin; load that session's manifest; for each diff changed file compute
  `foreign = (path ∈ baseline) && (sha256(currentContent) === baseline[path]) && (path ∉ owned)`.
  Build `foreignFiles: Set<string>` (normalized). Thread into the Orchestrator. **Disable on
  the synthesized-flag paths (505-549) and when no manifest/session_id → foreignFiles = null →
  full review (fail-closed).**
- **`src/core/orchestrator.ts`:** thread `foreignFiles?:Set<string>|null` into `AggregateInput`;
  **fold its signature into `computeCacheKey`** (sorted list, or null) so a scoped result can't
  be served to a differently-scoped run (M3).
- **`src/core/aggregator.ts` `scopeFindings` (248-294):** add an INDEPENDENT layer reusing the
  existing `demote()` helper (→ INFO + `scope_demoted`, **NOT** `demoted_from_critical` — S1,
  G0-EXEMPT, structural like off-diff). When `foreignFiles` non-null, demote a blocking finding
  whose normalized file ∈ `foreignFiles`, honoring the SAME `outOfDiffBlocking` escape hatch.
  ALSO stamp `foreign_to_session:true` on every demoted finding (M8 — the persisted ownership
  snapshot Slice B reads). Must NOT touch the existing harness-config demote (271).
- **`src/schemas/finding.ts`:** add `foreign_to_session: z.boolean().optional()` (M8).
- **`src/core/report-writer.ts`:** render a visible "Foreign (other session / pre-existing) —
  advisory" subsection in pending.md (the report's "at least visibly separate" ask).
- **`src/cli/commands/init.ts` `GITIGNORE_LINES`:** add `**/.reviewgate/sessions/`.

**Config:** `phases.review.scopeToSession` — `z.boolean().optional()` + `true` in `defaults.ts`.
`null` foreignFiles ⇒ full review = safe.

**Test surface:** `handlers.test.ts` (SessionStart captures + hashes the dirty baseline; absent
session_id → no manifest; PostToolUse unions repo-relative owned; **absolute `tool_input.file_path`
stored repo-relative** (M10); TTL prune keeps other sessions). `aggregator` (foreign-by-baseline
CRITICAL → INFO + `foreign_to_session` + NO `demoted_from_critical` (S1); a file CHANGED since
baseline → NOT demoted (Bash-safe, M2); a file ∈ owned → NOT demoted; `outOfDiffBlocking` keeps
it blocking; agent's OWN finding (absolute input) NOT demoted (M10); `from_critical_demoted===0`
for a foreign-demoted CRITICAL (S5 inverse)). New gate test: agent edited nothing → empty owned,
baseline holds the foreign files → all foreign → clean allow-stop (the reported case). Cache test:
two runs, same diff, different `foreignFiles` → different cache key (M3). Synthesized-flag path →
foreignFiles null → full review (M4). Config round-trip (~30 partial fixtures parse).

**Risks/guards:** demote is provably-safe (foreign ⟹ unchanged-since-baseline ∧ not-tool-edited ⟹
this session did not author it) — Bash edits change the hash → reviewed (M2 closed). No baseline
(SessionStart missed) → full review (fail-closed). DEMOTE not DROP. Cache keyed on foreignFiles
(M3). Committed work never demoted (M4). Baseline lives for the SESSION; re-edits change the hash
→ reviewed (M5 closed). Hashing cost is bounded (baseline-dirty set is empty in the common
single-agent case → zero overhead). **Live e2e required:** verify the SessionStart + PostToolUse +
Stop stdin all carry a stable `session_id` against the real Claude Code CLI (no fixture proves it).

---

### Slice B — P2 + P3: honest out-of-scope verdict + de-fanged escalation (depends on A)

**P2 — out-of-scope disposition (snapshot-gated, fail-CLOSED):**
- `src/schemas/decision.ts`: add accepted **action** `"out-of-scope"` (keep the 2-branch
  discriminatedUnion). `superRefine` branch requiring `reason` ≥20 non-whitespace chars.
- `src/core/loop-driver.ts` `evaluateDecisions` (444-561): accept `action==="out-of-scope"`
  (`seen.add`) **ONLY when the finding's persisted `foreign_to_session === true`** (read via
  `metaOf()`, which already loads pending.json — M7/M8: one consistent source, no live re-derive).
  Not-foreign / flag-absent → `invalidIds.add` ("out-of-scope is only valid for a finding on a
  file this session did not author"). This auto-fail-closes when Slice A didn't run (no flag).
- Neutrality: `reputation/learn.ts` (61-66) — **add `&& d.action !== "out-of-scope"`** (M6,
  MANDATORY — else a disowned finding credits the reviewer as correct). `decision-outcome.ts
  classifyDecision`, `fp-ledger/learn.ts`, `reject-rate.ts` need **NO code change** (already
  neutral by construction — S3, verify-only + regression test).
- `src/schemas/state.ts`: `consecutive_out_of_scope: z.number().int().nonnegative().default(0)`.
- `docs/AGENTS.md` (108-153): document — valid only for a foreign finding, reputation-neutral,
  bounded, surfaced to the human.

**P3 — escalation framing:**
- `EscalationReason` + `ALLOW_STOP_ESCALATIONS` (54-61): add `"findings-out-of-scope"` (allow-stop).
- `loop-driver.ts:1142-1148`: partition still-missing required ids by `foreign_to_session`.
  **All-foreign → reason `findings-out-of-scope`** + non-accusatory copy. **Any-owned → keep
  `decisions-unaddressed`** (firm).
- `loop-driver.ts:1873-1877`: replace the single hardcoded "gate gave up … no longer reviewing
  your changes" with a reason-keyed copy map (default arm = current firm wording; a structural
  test guarantees every EscalationReason has an entry). Soften `decisions-unaddressed` tone.
- `report-writer.ts writeEscalation`: reason-aware "Suggested human actions" + label.
- Cap: `consecutive_out_of_scope` bounded by `loop.maxConsecutiveOutOfScope` (default 3); exceed →
  escalate `findings-out-of-scope`. **Reset at BOTH re-arm sites** (PASS path ~1414 via
  `passed ? 0 : cur.x`, and the escalation-announce zeroing ~1861) (M9). Must still call
  `escalate()` (set escalated/announced) so the F-002 post-escalation re-arm (786) survives.

**Config:** `loop.maxConsecutiveOutOfScope: z.number().int().nonnegative().default(3)`. `0`
disables the cap. P3 framing is unconditional.

**A↔B handoff (must document):** under the DEFAULT `outOfDiffBlocking:[]`, Slice A already
demotes EVERY foreign finding (incl. sec/corr) to INFO → they drop out of the required-ids gate
and the turn ends cleanly — **that IS the field-report fix**. The out-of-scope action + P3
reframe only fire when the user keeps foreign sec/corr blocking via
`outOfDiffBlocking:['security','correctness']` (or the rare residual where a foreign finding
stays blocking). Slice B's "foreign CRITICAL/security is addressable via out-of-scope" tests
MUST set `outOfDiffBlocking:['security','correctness']` to exercise the path.

**Test surface:** `decisions-gate-acknowledge.test.ts` (out-of-scope valid on a
`foreign_to_session:true` finding w/ ≥20 reason; invalid on a non-foreign finding even w/ reason;
invalid without reason; **fail-CLOSED when the flag is absent**, M7). `decision.test.ts` (20-space
reason rejected). `decision-outcome.test.ts` (→ `declined`). `reputation-learn.test.ts` (out-of-scope
emits NO `correct` event — M6). `fp-reject-rate.test.ts` (denominator only — S3). `loop-driver`
(consecutive cap escalates `findings-out-of-scope` + ALLOWS stop; **counter resets at both re-arm
sites**, M9; all-foreign vs mixed routing). `report-writer.test.ts` (reason-aware actions).
Structural: every EscalationReason has a copy-map entry. Update the two existing `evaluateDecisions`
test callers for the new manifest/flag param (S4).

**Risks:** universal CRITICAL-bail unless the gate is airtight → keyed on the persisted
`foreign_to_session` flag (set only by Slice A's provably-safe baseline-delta) + fail-CLOSED when
absent. Do NOT weaken `acknowledged-low-value` / `verified-not-applicable`. An out-of-scoped
finding re-appears each panel (no FP-pin) — bounded by the cap.

---

## Operational notes

- **This repo dogfoods itself** — editing here fires Reviewgate on my own changes. Big gate
  edits can self-block; if the dogfood gate misbehaves mid-work, prefer a manual
  codex+opus diff review over fighting the live gate, and `reviewgate reset` to re-arm.
- **`bun run build` deploys to ALL repos** (the `~/.local/bin/reviewgate` symlink → dist).
  Do NOT build before merge + maintainer OK.
- **Never `git add -A`** — local `.reviewgate/` state files and `.review/` artifacts must
  stay untracked. Commit only source/test/doc changes.
- One feature branch (`feat/multiagent-ownership-remediation`), one commit per slice (TDD).
- **Pre-implementation Plan-Gate (this doc) → external codex review BEFORE coding.**
- **Post-implementation DoD:** `bunx tsc --noEmit` + `bun run lint` + full `bun test`,
  then codex×2 + opus/claude×2 review pipeline, all PASS, before commit. Ask before push.
