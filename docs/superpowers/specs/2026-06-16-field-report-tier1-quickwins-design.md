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

## Slice 1 — Deterministic REDACTED-artifact drop (#1)

**File:** `src/core/aggregator.ts` (+ `AggregateResult` shape)

**Where:** at the very top of `aggregate()`, **before** path normalization and clustering. A
finding that is a false positive by construction must never enter a cluster, contribute to
consensus, or pollute reputation/FP-ledger accounting.

**Subject rule** (the approved "only when REDACTED is the subject" semantics): drop a finding
when `<REDACTED:` appears in **`message`** OR **`suggested_fix`**.

- These two fields *assert what is wrong* (the ≤200-char headline) and *propose the fix*. A
  synthetic placeholder in either means the finding is definitionally **about** the placeholder.
- Deliberately **NOT** `diff_hunk` or `details`: the sanitizer legitimately writes
  `<REDACTED:…>` into the diff, so a *good* finding can quote a redacted line there as
  surrounding **context**. Triggering on those fields would false-drop real findings.

**Detection:** match the literal prefix `<REDACTED:` (case-sensitive — the sanitizer always
emits uppercase `<REDACTED:HIGH_ENTROPY>`). A substring check on the two fields; no regex
needed.

**Residual (documented trade-off):** a reviewer that mentions the token *only* in `details`
prose slips past this filter. That case stays covered by the existing prompt instruction
(`7fe9ea3`). We accept this to avoid false-dropping genuine findings whose `details` quote a
redacted context line.

**Audit / accounting:** dropped findings are returned via a new `redactionDropped: Finding[]`
field on `AggregateResult` (mirroring `criticDropped`). The orchestrator emits a
`finding.suppressed` audit event (reason `redaction_artifact`) per drop. These are **not**
counted as false positives in the precision metric (they are tool artifacts, not reviewer
hallucinations about real code) — i.e. they do not flow into the FP-ledger or
`decision.applied`/FP precision accounting.

**Default:** always on, no config toggle. A pure correctness filter with no downside.

**Edge cases:**
- A finding whose `suggested_fix` is `null`/absent → only `message` is checked.
- Multiple findings in the input each independently evaluated; the drop is per-finding.

---

## Slice 2 — Test-file security-severity demote (#9)

**Files:** `src/core/aggregator.ts`, `src/schemas/finding.ts`, `src/config/defaults.ts`,
`src/config/define-config.ts`, the orchestrator's `AggregateInput` wiring.

**Schema:** add optional `test_severity_demoted?: boolean` to `FindingSchema` (exact pattern
of `scope_demoted`).

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
- Keyed on the finding's **representative** `f.file` via the existing `classify()` from
  `src/research/diff-facts.ts` (regex: `/\.(test|spec)\.[a-z]+$|(^|\/)tests?\//`). Reuse it;
  do not duplicate the pattern.

**Config:** `phases.review.demoteTestSecurity: boolean`, default `true` (lives beside
`scopeToDiff`/`confidenceFloor`). Wired into `AggregateInput` as `demoteTestSecurity?: boolean`
(absent/false → pass is a no-op, preserving pre-feature behaviour). Set `false` for
security-critical test suites where a weak secret in a fixture is itself a finding.

**Interaction:** runs independently of scope/confidence/reputation demotes. Because it only
ever lowers severity (never raises, never drops), composition with the other passes is safe —
the most-conservative outcome already wins elsewhere, and INFO is the floor.

---

## Slice 3 — Diff-size early warning (#6)

**Files:** `src/core/orchestrator.ts`, `src/core/report-writer.ts`,
`src/config/defaults.ts`, `src/config/define-config.ts`.

**Config (new, under `loop`, beside `runTimeoutMs`):**
- `loop.diffWarnBytes: number` — default `600_000`.
- `loop.diffWarnFiles: number` — default `80`.
- Either threshold `0`/absent → that check disabled.

**Where:** in the orchestrator, immediately after `collectDiff`, **before** the reviewer panel
runs. Compute `diff.length` (bytes) and the changed-file count (reuse `computeDiffFacts(diff).files.length`,
already computed for triage). If either threshold is exceeded:

1. **`console.warn`** a one-line message immediately. This is the critical part: on a
   self-deadline abort the gate fails closed and may write no `pending.md`, so the warning must
   reach the gate's stderr/log **before** the panel can time out.
2. Set a flag/string passed to the report-writer so, *if* a report is written, a **banner**
   appears at the top of `pending.md`.

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

**Plumbing (definite):** the orchestrator computes `{ files: number, bytes: number }` for the
diff and a boolean `overLimit` (either threshold exceeded). It passes a single optional
`largeDiff?: { files: number; bytes: number }` value to the report-writer (present only when
`overLimit`). The **report-writer** owns the banner *formatting* (so presentation stays in one
place, beside `diffIncomplete`/`panel_note`). The orchestrator's `console.warn` uses its own
short inline string (`Large diff: N files / X KB — see pending.md`) — it does NOT need to match
the banner verbatim, which avoids duplicating the formatted text. If the counts must persist
for a written report, the pending-report schema gains an optional `large_diff` field (mirror
`panel_note`); otherwise it is render-only.

---

## Testing (TDD — red first)

`bun test`, in-process, no provider subprocesses.

**Slice 1 (`tests/unit/aggregator-redaction-drop.test.ts`):**
- A finding with `<REDACTED:HIGH_ENTROPY>` in `message` → dropped, present in
  `redactionDropped`, absent from `findings`.
- `<REDACTED:` in `suggested_fix` → dropped.
- `<REDACTED:` only in `details` → **kept** (subject rule).
- `<REDACTED:` only in `diff_hunk` (context) → **kept**.
- A clean finding co-located with a dropped one is unaffected (drop is pre-cluster, per-finding).

**Slice 2 (`tests/unit/aggregator-test-severity.test.ts`):**
- `category:"security"` on `foo.test.ts` (CRITICAL) → INFO, `test_severity_demoted:true`.
- `category:"security"` on `tests/fixtures/x.ts` → demoted.
- `category:"correctness"` on a test file → **unchanged** (still blocking).
- `category:"security"` on `src/foo.ts` (non-test) → **unchanged**.
- `demoteTestSecurity:false` → no-op even for security-on-test.

**Slice 3 (`tests/unit/diff-size-warning.test.ts`):**
- Diff over `diffWarnBytes` → warning condition true, banner string rendered, counts correct.
- Diff over `diffWarnFiles` (but under bytes) → warning true.
- Diff under both → no banner.
- Threshold `0` → check disabled.

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
