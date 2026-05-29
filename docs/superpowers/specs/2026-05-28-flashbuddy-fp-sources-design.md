# Spec — Eliminate two Reviewgate-own false-positive sources

**Date:** 2026-05-28
**Status:** Approved (design), pending implementation plan
**Author:** brainstormed with Markus

## Problem / Motivation

A flashbuddy agent's Reviewgate run ESCALATED at max-iterations. Root-cause
analysis (verified against the code) found the panel was partly chasing
**Reviewgate's own artifacts**, not real code:

1. **agy artifact leak.** A reviewer flagged a `.antigravitycli` symlink (→
   `~/.gemini/config`) as a *committed credential leak* (CRITICAL). It was an
   **untracked working-tree artifact** left by `agy` (the Antigravity CLI). Since
   the `gemini` reviewer is now `agy` ([[project-agy-migration]]), the gate itself
   can create these. `collectDiff` (src/utils/git.ts) includes untracked,
   non-gitignored files via `git diff --no-index`, and only excludes
   `reviewgate.config.ts` + `.reviewgate/` — so agy's artifacts entered the
   reviewed diff and became a CRITICAL false positive. This is a regression
   introduced by the agy migration.
2. **Redaction-token finding.** The diff sanitizer replaces 24+ char high-entropy
   strings with the literal `<REDACTED:HIGH_ENTROPY>` (src/diff/sanitizer.ts:73). A
   reviewer flagged *that placeholder token itself* as a finding — it "doesn't
   exist in the code." Reviewers aren't told the token is Reviewgate's own
   redaction artifact.

Both were recurring noise across the rotating-FP iterations that drove the
escalation. Removing them removes two of the rotating FP sources.

**Out of scope (separate work):** Bug 3 — the deeper FP-runaway + codex
quota-degradation that let the loop escalate. This spec only removes the two
Reviewgate-own FP sources.

## Background — verified code

- `src/utils/git.ts`: `collectDiff` reviews `git diff <base> -- . :(exclude)...`
  (tracked) PLUS untracked files (`ls-files --others --exclude-standard` →
  `git diff --no-index`). Two exclusion mechanisms exist:
  - **tracked**: the `:(exclude)…` pathspec list in `diffArgs` (currently
    `reviewgate.config.ts`, `.reviewgate`, `.reviewgate/**`).
  - **untracked**: `isReviewgateManaged(path)` (currently
    `reviewgate.config.ts` / `.reviewgate` / `.reviewgate/**`) filters the
    untracked loop.
  The untracked `.antigravitycli` symlink slipped through both.
- `src/diff/sanitizer.ts`: builds the reviewer text as `preamble` + fenced
  `<<UNTRUSTED_DIFF>> … <<END_UNTRUSTED>>` + `input.personaReaffirm` (Layer 6,
  outside the fence — real instructions). `redactHighEntropy` emits
  `<REDACTED:HIGH_ENTROPY>`.
- `src/cli/commands/init.ts`: appends `GITIGNORE_LINES` to `.gitignore`
  idempotently (skips lines already present).

## Design

### 1. Exclude agy artifacts from the reviewed diff (`src/utils/git.ts`)

agy artifacts must never be reviewed regardless of the repo's `.gitignore` state.
Extend BOTH exclusion mechanisms:

- **Tracked pathspec** (`diffArgs`): add
  `:(exclude).antigravitycli`, `:(exclude).antigravitycli/**`,
  `:(exclude).gemini`, `:(exclude).gemini/**`.
- **Untracked filter:** rename `isReviewgateManaged` → `isExcludedFromReview`
  (semantically honest now that it covers more than Reviewgate's own files) and
  extend it:
  ```ts
  function isExcludedFromReview(path: string): boolean {
    return (
      path === "reviewgate.config.ts" ||
      path === ".reviewgate" || path.startsWith(".reviewgate/") ||
      path === ".antigravitycli" || path.startsWith(".antigravitycli/") ||
      path === ".gemini" || path.startsWith(".gemini/")
    );
  }
  ```
  Update all call sites (the untracked loop) to the new name. Update the
  explanatory comment to mention agy/Antigravity artifacts.

### 2. Tell reviewers to ignore redaction tokens (`src/diff/sanitizer.ts`)

Append one instruction to the Layer-6 text (AFTER `<<END_UNTRUSTED>>`, alongside
`personaReaffirm` — a real instruction, not untrusted data):

> "Sequences like `<REDACTED:HIGH_ENTROPY>` are Reviewgate's own redaction
> placeholders for stripped secrets — they are NOT in the real code. Never report
> them as findings."

The `redactHighEntropy` logic itself is unchanged.

### 3. Scaffold the artifacts into init's `.gitignore` (`src/cli/commands/init.ts`)

Add `.antigravitycli/` and `.gemini/` to `GITIGNORE_LINES`. Belt-and-suspenders:
the diff exclusion (§1) is the real guard (works on existing repos with stale
.gitignore); the gitignore keeps the working tree clean and prevents accidental
commits going forward.

## Components / isolation

- `src/utils/git.ts` — owns diff scope; the single source of truth for "what gets
  reviewed". The exclusion lives here, testable via `collectDiff` on a temp repo.
- `src/diff/sanitizer.ts` — owns the reviewer-facing text; the redaction note lives
  beside the redaction logic.
- `src/cli/commands/init.ts` — owns scaffolding; the gitignore line lives with the
  other scaffolded lines.

## Testing

- **git.ts (`tests/unit/…`):** on a temp git repo, create an untracked normal file
  (`foo.ts`), an untracked `.antigravitycli` symlink/file, and an untracked
  `.gemini/creds` file; assert `collectDiff` output contains `foo.ts` but NOT
  `.antigravitycli` or `.gemini`. (Mirror the existing collectDiff/untracked test
  pattern.)
- **sanitizer.ts:** assert the sanitized output contains the redaction-token
  instruction string; assert a 24+ char high-entropy input still becomes
  `<REDACTED:HIGH_ENTROPY>` (redaction unchanged); assert the instruction sits
  AFTER `<<END_UNTRUSTED>>` (outside the fence).
- **init.ts:** after `runInit` on a temp repo, `.gitignore` contains
  `.antigravitycli/` and `.gemini/`; idempotent on re-run (no duplicates).

## Non-goals / YAGNI

- No generic "tool artifact" abstraction — specific paths (`.antigravitycli`,
  `.gemini`) only.
- No change to the redaction algorithm or the FP-runaway/quota logic (Bug 3).
- No retroactive cleanup of artifacts already in a user's repo (the agent already
  handles that case manually; gitignore prevents recurrence).

## Acceptance criteria

1. An untracked `.antigravitycli` (file or symlink) and `.gemini/*` are excluded
   from `collectDiff` output; a normal untracked file is still included.
2. The same exclusion applies to the tracked pathspec (committed `.antigravitycli`
   would also be excluded).
3. Sanitized reviewer text carries the `<REDACTED:…>`-ignore instruction outside
   the untrusted fence; redaction behavior unchanged.
4. `reviewgate init` adds `.antigravitycli/` + `.gemini/` to `.gitignore`,
   idempotently.
5. `bunx tsc --noEmit`, `bun run lint`, full `bun test` clean (all
   `isReviewgateManaged` call sites updated to the new name).
