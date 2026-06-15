# Field-Report Tier-1 Quick-Wins — Design

**Date:** 2026-06-16
**Status:** Approved (design), pending implementation plan
**Source:** flashbuddy field report (10 prioritised recommendations from a ~10-iteration
production run: a 170-file audit PR + a 23-PR test-backlog merge). This spec covers the
three lowest-risk, highest-leverage items — #1, #9, #6 in the report's numbering.

## Motivation

The field report is honest evidence from running the deployed binary (a symlink to this
repo's `dist`) on flashbuddy. Several of its recommendations are already (partially) shipped;
these three are genuine gaps that need no architecture change:

- **#1 — Reviewgate flags its OWN redaction artifact as a CRITICAL bug.** The sanitizer
  replaces high-entropy tokens with `<REDACTED:HIGH_ENTROPY>` (`src/diff/sanitizer.ts`). A
  reviewer then flagged that placeholder as "undefined variable / invalid CUID" at
  **CRITICAL confidence 1.00**. A prompt-level mitigation exists since 2026-05-29 (`7fe9ea3`:
  a TRUSTED instruction "never report a `<REDACTED:…>` token"), but the field report proves a
  single prompt line is not enough — the report calls this the single biggest trust-killer.
- **#9 — Test/fixture code is treated with production severity.** A mocked return value
  (`TempPass123!` from `generateSecurePassword`) was flagged as a security CRITICAL
  "weak password". A fixture is not production code.
- **#6 — Fixed 12-min timeout breaks the gate on exactly the large PRs where review matters
  most.** `loop.runTimeoutMs` defaults to `720_000`; on the 170-file diff the review aborted
  repeatedly ("GATE CLOSED — did not complete within 12min"). There is no diff-size-coupled
  warning.

## Principles

- Three **disjoint, additive** slices. No existing verdict logic is changed; each slice only
  **suppresses noise** (1, 9) or **adds a warning** (6).
- All three are **deterministic** (no LLM) → free, non-flaky, testable in `bun test` without
  spawning a provider.
- Follow existing patterns: the aggregator already has a demote chain
  (`scope_demoted`/`fact_invalid`/`reputation_demoted`/…) and a `criticDropped` return list
  for removed findings; the report-writer already renders banners (`diffIncomplete`,
  `panel_note`). We extend those, we don't invent new mechanisms.

---

## Slice 1 — Deterministic REDACTED-artifact demote (#1)

> **UPDATE (driven by the dogfood gate's own codex review, iteration 1).** This slice originally
> **dropped** matching findings pre-cluster. Codex (gate) — echoing the spec-review concern from
> codex-r2 and opus — flagged that a *destructive drop* remains a fail-open for a REAL secret
> leak that a reviewer reports with bland, lead-word-free wording (e.g. `correctness`: "exposed
> value `<REDACTED:…>`"): such a finding would be deleted before it ever reached `pending.md`.
> The gates bound this but cannot fully prove a finding is benign (category + wording are
> reviewer-supplied). The fix, per codex's own remediation ("demote rather than drop"): **DEMOTE
> to advisory INFO instead of dropping.** A mis-worded real leak then stays **visible** in the
> advisory section (fail-VISIBLE, not fail-open) while losing the blocking weight that was the
> field-report trust-killer. The two gates are unchanged — they now decide what stays *blocking*
> vs. what is *demoted*, not what is *kept* vs. *deleted*.

**File:** `src/core/aggregator.ts` (+ `FindingSchema` flag, `findingBadges()`)

**Where:** a pre-cluster `map` at the very top of `aggregate()`, **before** path normalization
and clustering. Pre-cluster matters: a demoted artifact is now **INFO** (the lowest severity),
so it can never become a cluster **representative** that masks a real co-located finding — a real
CRITICAL/WARN seeds the cluster and the artifact rides as an INFO member.

**Subject rule** (the approved "only when REDACTED is the subject" semantics): **demote a finding
to INFO** (`redaction_demoted: true`) when **all** of the following hold:

1. `<REDACTED:` appears in **`message`** OR **`suggested_fix`**, AND
2. `category !== "security"`, AND
3. **neither `message` NOR `suggested_fix`** contains a **secret-leak lead word**
   (case-insensitive). The set is a **superset** of the lead words the sanitizer uses in
   `HEX_SECRET_WITH_CONTEXT` — `api[_-]?key | secret | token | passwo?r?d | pwd | auth | bearer |
   access[_-]?key | private[_-]?key | client[_-]?secret` — **plus** `credential | hardcoded`
   (the latter two are not in the sanitizer regex; adding them only KEEPS more findings blocking).

When any gate fails, the finding is left **blocking** (un-demoted).

**Gate (3) MUST scan the SAME field set as gate (1)** (`message` ∪ `suggested_fix`). If the demote
*triggers* on a field the backstop does not *scan*, a real secret leak whose lead language lives
only in `suggested_fix` (message "remove this committed value" / suggested_fix "delete the
hardcoded `api_key` `<REDACTED:…>`") would trip gate 1, pass gate 2 if mislabeled non-security,
and slip gate 3 → wrongly demoted. The backstop is **co-extensive with the trigger** so the two
can never diverge.

**Why two gates + DEMOTE (defense in depth).** `redactHighEntropy()` emits the SAME
`<REDACTED:HIGH_ENTROPY>` placeholder for a *benign* high-entropy token (a CUID used as a real
identifier — the field-report FP) **and for a genuinely committed secret**
(`HEX_SECRET_WITH_CONTEXT`: `api_key=deadbeef…`). A redaction therefore means *a secret was in the
diff*. Three layers protect a real leak: gate (2) keeps `security` findings blocking; gate (3) —
the **trusted, content-based backstop** (independent of the reviewer-supplied `category`) — keeps
any finding that *names* a secret blocking; and DEMOTE-not-drop means even a leak that slips both
gates (non-security, bland wording) is still **surfaced as advisory**, never silently deleted.
- "Hardcoded api_key `<REDACTED:…>` committed" mislabeled `correctness` → gate (3) trips →
  **stays blocking**.
- "exposed value `<REDACTED:…>`" `correctness` (no lead word) → **demoted to advisory INFO**,
  still visible — a human/agent can act on it (the gate-flagged residual, now fail-visible).
- "undefined variable `<REDACTED:…>`" `correctness` → **demoted to advisory** (the field-report
  CRITICAL @1.00 FP no longer blocks).

- **Subject fields, not context.** `message` (the ≤200-char headline) and `suggested_fix`
  *assert what is wrong* / *propose the fix*; a synthetic placeholder there means the finding
  is **about** the placeholder. Deliberately **NOT** `diff_hunk`/`details`: the sanitizer
  writes `<REDACTED:…>` into the diff itself, so a *good* finding legitimately quotes a redacted
  line there as surrounding **context** — triggering on those would wrongly demote real findings.
- **`suggested_fix` is currently dead weight (kept defensively).** `mapReviewOutputToFindings()`
  does not populate `suggested_fix` for panel findings, so today the rule is effectively
  `message`-only. We still check `suggested_fix` for non-panel/future sources at no cost.

**Detection:** match the literal prefix `<REDACTED:` (case-sensitive — the sanitizer always
emits uppercase `<REDACTED:HIGH_ENTROPY>`). A substring check on the two fields; no regex needed.

**Visibility:** a new `redaction_demoted?: boolean` on `FindingSchema` (pattern of
`scope_demoted`) + a `findingBadges()` entry (🙈 "targets a `<REDACTED:…>` placeholder …
advisory") so the demoted finding is clearly labelled in the advisory section. No new audit
EventType / `AggregateResult` field — the finding stays in `dedupedFindings` as INFO (countable
via the flag), consistent with every other demote-only suppressor.

**Residual (documented trade-off):** a reviewer that mentions the token *only* in `details`
prose is unaffected (kept at full severity) — that case stays covered by the existing prompt
instruction (`7fe9ea3`). Demote (not drop) also makes any residual strictly *fail-visible*.

**Default:** always on, no config toggle. Demote-only, so it can never hide a blocking finding.

**Edge cases:**
- `category:"security"` finding mentioning `<REDACTED:` → **stays blocking** (gate 2; possible real leak).
- Non-security finding whose `message` OR `suggested_fix` names a secret (`api_key`/`hardcoded`/…)
  → **stays blocking** (gate 3 backstop scans both fields; covers a real leak miscategorized as non-security).
- A finding whose `suggested_fix` is `null`/absent → only `message` is checked.
- A demoted artifact co-located with a real finding never masks it (demote is pre-cluster → the
  INFO artifact is never the cluster representative).
- Multiple findings in the input each independently evaluated; the demote is per-finding.

---

## Slice 2 — Test-file security-severity demote (#9)

**Files:** `src/core/aggregator.ts`, `src/schemas/finding.ts`, `src/config/defaults.ts`,
`src/config/define-config.ts`, the orchestrator's `AggregateInput` wiring.

**Schema & visibility:** add optional `test_severity_demoted?: boolean` to `FindingSchema`
(exact pattern of `scope_demoted`), AND a corresponding entry in the report-writer's
`findingBadges()` (e.g. `📁 test-only` / "demoted: security finding on a test file") so the
demote is visible in `pending.md` — `isAdvisory()` already routes the INFO-demoted finding into
the advisory section, but without a badge the *reason* is invisible. Note a Slice-2 demote and
the existing `categories.size > 1` masking warning can co-occur on one finding (a security
member merged under a non-security representative): both notes should render coherently.

**Where:** a new demote pass in `aggregate()`, a peer of `scopeFindings` (runs over deduped
survivors; order relative to the other demotes does not matter — it is path+category based and
idempotent).

**Rule:** for a finding where `classify(f.file) === "tests"` **AND** `f.category === "security"`:
- set `severity = "INFO"`, `test_severity_demoted = true`, and append a note to `details`
  (e.g. `"📁 Demoted to advisory: security finding on a test/fixture file — not production code."`).
- An already-INFO finding just gets the flag (mirrors the `scopeFindings` demote helper).

**Scope discipline:**
- **Only `category === "security"`.** `correctness`/`quality`/other categories on a test file
  stay at full severity — a real bug in test logic is still a bug worth blocking on.
- Keyed on the finding's **representative** `f.file`. Reuse the existing `classify()` from
  `src/research/diff-facts.ts` (regex: `/\.(test|spec)\.[a-z]+$|(^|\/)tests?\//`) — **export it**
  (currently module-private) rather than duplicating the pattern or reaching around the module.

**Cluster safety (WARN from spec review).** Clustering is **per-file** (`anchorFile`), so every
member of a cluster shares the representative's file — there is no cross-file demote risk. The
remaining edge is a *wording-merge across categories*: a `security` member can merge under a
non-`security` representative in a test file. We **keep the representative-keyed rule** and
accept the resulting **under-demote** (the finding simply stays at full severity — the SAFE
direction; we never suppress). We deliberately do **NOT** do a member-aware whole-cluster
demote: that would wrongly lower the `correctness`/other concerns the masking-warning
(`categories.size > 1`) already surfaces for the agent's combined decision.

**Residual & visibility (WARN from spec review).** `classify()`'s `(^|\/)tests?\//` is broad: a
repo that ships production-reachable code under a `tests/` path would see a real security
CRITICAL demoted. Two things bound this: (1) the demote moves the finding to the **advisory
section — still visible in `pending.md`, just non-blocking — it is NOT deleted**; (2) it is
config-gated. Such repos set `demoteTestSecurity:false`. We accept this documented residual
rather than adding reachability/import analysis (out of scope, over-engineered for the target
case: `*.test.*` / fixture secrets).

**Config:** `phases.review.demoteTestSecurity: boolean`, default `true` (lives beside
`scopeToDiff`/`confidenceFloor`). Wired into `AggregateInput` as `demoteTestSecurity?: boolean`
(absent/false → pass is a no-op, preserving pre-feature behaviour). Set `false` for
security-critical test suites where a weak secret in a fixture is itself a finding.

**Interaction:** runs independently of scope/confidence/reputation demotes. Because it only
ever lowers severity (never raises, never drops), composition with the other passes is safe —
the most-conservative outcome already wins elsewhere, and INFO is the floor.

---

## Slice 3 — Diff-size early warning (#6)

**Files:** `src/cli/commands/gate.ts`, `src/core/orchestrator.ts`, `src/core/report-writer.ts`,
`src/config/defaults.ts`, `src/config/define-config.ts`.

**Config (new, under `loop`, beside `runTimeoutMs`):**
- `loop.diffWarnBytes: number` — default `600_000`.
- `loop.diffWarnFiles: number` — default `80`.
- Either threshold `0`/absent → that check disabled.

**Where (corrected by spec review).** `collectDiff` runs in `src/cli/commands/gate.ts`,
**before** the `Orchestrator` is constructed and **outside** the loop self-deadline. The
warning must be computed and `console.warn`'d **there**, right after `collectDiff` — so it
reaches the gate's stderr/log even when the subsequent review hits the self-deadline and fails
closed without writing `pending.md`. Putting it in `runIteration()` would be later AND under the
deadline (preemptable). Steps:

1. In `gate.ts` after `collectDiff`: compute `bytes = diff.length` and
   `files = ` count of raw `diff --git ` headers (NOT `computeDiffFacts().files.length`, which
   filters pure renames/binary/mode-only changes and would **undercount** operational diff
   size). If `(diffWarnBytes>0 && bytes>diffWarnBytes) || (diffWarnFiles>0 && files>diffWarnFiles)`
   → `console.warn` a one-line message and pass the counts into the Orchestrator input.
2. The Orchestrator carries the over-limit info to the report-writer so, *if* a report is
   written, a **banner** appears at the top of `pending.md`.

**Banner / warning text** names the measured size and the remediation, explicitly both knobs:

> ⚠ **Large diff:** N files / X KB exceed the review-size warning threshold. If the review
> times out, raise **`loop.runTimeoutMs`** in `reviewgate.config.ts` **AND** the Stop-hook
> `timeout` in `.claude/settings.json` — **both**, or the OS kills the hook before Reviewgate's
> own deadline and the turn ends **un-reviewed** (fail-open).

**No auto-scaling.** Confirmed: Reviewgate does not know the OS Stop-hook timeout at runtime,
so blindly raising `runTimeoutMs` risks exceeding it → the OS kills the hook → fail-open (the
documented `gate-timeout-failopen` failure mode; budgets.ts invariant
`SETUP + runTimeoutMs + SETTLE < OS timeout`). "Configurable cap" = the existing `runTimeoutMs`
stays the single knob; we only *warn*.

**Plumbing (definite):** `gate.ts` computes `{ files, bytes }` and `overLimit`, does the
`console.warn` (short inline string `Large diff: N files / X KB — raise loop.runTimeoutMs AND
the Stop-hook timeout if the review times out`), and passes a single optional
`largeDiff?: { files: number; bytes: number }` into the `Orchestrator` input (present only when
`overLimit`). The orchestrator forwards it to the **report-writer**, which owns the banner
*formatting* (presentation stays in one place, beside `diffIncomplete`/`panel_note`). The
console.warn text need not match the banner verbatim. If the counts must persist for a written
report, the pending-report schema gains an optional `large_diff` field (mirror `panel_note`);
otherwise it is render-only.

---

## Testing (TDD — red first)

`bun test`, in-process, no provider subprocesses.

**Slice 1 (`tests/unit/aggregator-redaction-drop.test.ts`):**
- A **non-security** finding with `<REDACTED:HIGH_ENTROPY>` in `message` → **demoted to INFO**,
  `redaction_demoted:true`, kept in `dedupedFindings`, verdict not FAIL.
- Non-security `<REDACTED:` in `suggested_fix` → demoted to INFO.
- **`category:"security"`** finding with `<REDACTED:` in `message` → **stays CRITICAL** (gate 2:
  could be a real committed secret).
- **`category:"correctness"`** finding `message:"Hardcoded api_key <REDACTED:…> committed"` →
  **stays CRITICAL** (gate 3 lead-word backstop: a real leak miscategorized as non-security).
- **`category:"correctness"`**, `message:"remove this committed value <REDACTED:…>"` (no lead
  word), `suggested_fix:"delete the hardcoded api_key"` → **stays CRITICAL** (gate 3 scans
  `suggested_fix` too — a message-only backstop would have wrongly demoted this real leak).
- `<REDACTED:` only in `details` → **stays CRITICAL** (subject rule).
- lowercase `<redacted:…>` → **stays CRITICAL** (case-sensitive gate).
- A real co-located finding still BLOCKS — the demoted INFO artifact never masks it (demote is
  pre-cluster, so the artifact is never the cluster representative).

**Slice 2 (`tests/unit/aggregator-test-severity.test.ts`):**
- `category:"security"` on `foo.test.ts` (CRITICAL) → INFO, `test_severity_demoted:true`.
- `category:"security"` on `tests/fixtures/x.ts` → demoted.
- `category:"correctness"` on a test file → **unchanged** (still blocking).
- `category:"security"` on `src/foo.ts` (non-test) → **unchanged**.
- `demoteTestSecurity:false` → no-op even for security-on-test.

**Slice 3 (`tests/unit/diff-size-warning.test.ts`):**
- Diff over `diffWarnBytes` → `overLimit` true; report-writer renders the banner with correct
  counts (test the pure `overLimit` predicate + the report-writer rendering — both unit-level,
  no need to drive the whole gate).
- Diff over `diffWarnFiles` (but under bytes), file count via raw `diff --git ` headers → true.
- A diff with renames/binary-only entries does not over-count files (raw-header count, but the
  predicate still reflects real `diff --git` headers).
- Diff under both → no banner.
- Either threshold `0` → that check disabled.
- The over-limit predicate / `console.warn` path is exercised **independently** of report
  writing (it lives in `gate.ts` before the deadline) — so the stderr warning is asserted to
  fire even when no `pending.md` is produced (the self-deadline-abort case it exists for).

## Definition of Done

- `bunx tsc --noEmit` clean, `bun run lint` clean, full `bun test` green.
- New tests above pass; no existing test regresses.
- Then the reviewgate self-gate (dogfood) must PASS.

## Explicitly out of scope

Report items **#2** (file-context budget tuning), **#3** (`node_modules`/types grounding),
**#4** (cross-iteration adjudication persistence / FP-ledger signature fragmentation),
**#5** (treadmill / net-diff review), **#7** (in-flight detection), **#8** (per-provider
precision-weighted confidence), **#10** (no-escalate-on-degraded-panel) — each its own slice in
a later roadmap. Doctor integration for #6 is YAGNI (the report banner + stderr warning suffice).
