# Spec — Stop Reviewgate's own artifacts/tokens from becoming false positives

**Date:** 2026-05-28
**Status:** Approved (design v2), pending implementation plan
**Author:** brainstormed with Markus

> **v2:** an agy spec-review (verified against the code) corrected v1:
> `.antigravitycli` is a **directory** agy creates in the repo CWD (not a symlink);
> `.gemini` is created only in `$HOME`, never in the repo, and is too generic to
> exclude (would hide legit user code). So we exclude **`.antigravitycli` only**,
> match it **subdir-safe** (any path depth), also close the **plan-refs** read
> channel, place the redaction note **once in the orchestrator** (sanitizeDiff runs
> 3×), and **fold in fence-token hardening** (a found CRITICAL: the fence
> delimiters aren't neutralized).

## Problem / Motivation

A flashbuddy agent's Reviewgate run ESCALATED at max-iterations. Root-cause: the
panel was partly chasing **Reviewgate's own artifacts**, not real code:

1. **agy artifact leak.** A reviewer flagged a `.antigravitycli` entry (an
   Antigravity-CLI working-tree artifact pointing at `~/.gemini/config`) as a
   *committed credential leak* (CRITICAL). `collectDiff` includes untracked,
   non-gitignored files and only excludes `reviewgate.config.ts` + `.reviewgate/`,
   so agy's artifact entered the reviewed diff. Since the `gemini` reviewer is now
   `agy` ([[project-agy-migration]]), the gate itself creates `.antigravitycli/` —
   verified: it appears as a directory in every repo where the agy reviewer ran.
2. **Redaction-token finding.** The sanitizer replaces 24+ char high-entropy
   strings with the literal `<REDACTED:HIGH_ENTROPY>` (src/diff/sanitizer.ts:73). A
   reviewer flagged *that placeholder* as a finding — it isn't in the real code.
3. **Fence-token gap (found during review).** The sanitizer separates untrusted
   diff from trusted instructions with `<<UNTRUSTED_DIFF>>` / `<<END_UNTRUSTED>>`,
   but these are NOT in `INJECTION_MARKERS` and are not neutralized — a diff
   containing the literal `<<END_UNTRUSTED>>` can close the fence early and have
   following text read as trusted. Same class as #2 (Reviewgate's own sanitizer
   tokens causing harm), so folded in.

**Out of scope:** Bug 3 — the deeper FP-runaway + codex quota-degradation that let
the loop escalate. This slice only removes Reviewgate-own FP/injection sources.

## Verified facts (empirical)

- `.antigravitycli` is a **directory** agy creates in the repo CWD (present in both
  reviewgate checkouts where the agy reviewer ran). `.gemini` exists only at
  `~/.gemini` — agy does NOT create a repo-level `.gemini`.
- `src/utils/git.ts`: `collectDiff` reviews tracked (`git diff <base> -- .
  :(exclude)…`) PLUS untracked (`ls-files --others --exclude-standard` →
  `git diff --no-index`). Untracked files are filtered by `isReviewgateManaged()`
  (called at git.ts:123 and git.ts:208). `collectChangedFileContents` builds
  `nameArgs` (git.ts:163) without the excludes but filters via the same predicate.
- `src/diff/sanitizer.ts`: `INJECTION_MARKERS` (lines 2-15) covers `<system>`,
  `<|im_start|>`, `[INST]`, `Human:`, etc. — NOT the `<<…>>` fence delimiters.
  `redactHighEntropy` emits `<REDACTED:HIGH_ENTROPY>`. The reviewer text =
  preamble + `<<UNTRUSTED_DIFF>>` body `<<END_UNTRUSTED>>` + `personaReaffirm`.
- `src/core/orchestrator.ts`: `sanitizeDiff` is called **3×** (diff 689, fileContext
  691, referencedRaw 727); the prompt is assembled in `promptParts` (702-735).
- `src/research/plan-refs.ts`: `collectReferencedFileContents` reads paths a
  reviewed plan references; gated by `PROTECTED_PREFIXES = [".reviewgate/", ".git/",
  ".hg/", ".svn/"]` + `PROTECTED_FILES = ["reviewgate.config.ts"]` (lines 53-54).
- `src/cli/commands/init.ts`: `GITIGNORE_LINES` (line 51) appended idempotently.

## Design

### 1. Exclude `.antigravitycli` from the reviewed diff, subdir-safe (`src/utils/git.ts`)

- Rename `isReviewgateManaged` → `isExcludedFromReview` (it now covers more than
  Reviewgate's own files). Update both call sites (git.ts:123, :208). Match
  `.antigravitycli` as a path **component at any depth** (agy may run in a subdir,
  yielding `subproject/.antigravitycli`):
  ```ts
  const ANTIGRAVITY_ARTIFACT = /(^|\/)\.antigravitycli(\/|$)/;
  function isExcludedFromReview(path: string): boolean {
    return (
      path === "reviewgate.config.ts" ||
      path === ".reviewgate" || path.startsWith(".reviewgate/") ||
      ANTIGRAVITY_ARTIFACT.test(path)
    );
  }
  ```
- Tracked pathspec (`diffArgs`): add `:(exclude).antigravitycli`,
  `:(exclude).antigravitycli/**`, `:(exclude)**/.antigravitycli`,
  `:(exclude)**/.antigravitycli/**`.
- Mirror the same four excludes into `nameArgs` (collectChangedFileContents,
  git.ts:163) so tracked artifacts aren't even name-listed.
- `.gemini` is intentionally NOT excluded (not an in-repo agy artifact; generic
  name → excluding it would silently drop legit user code).

### 2. Close the plan-refs read channel (`src/research/plan-refs.ts`)

Add `.antigravitycli/` to `PROTECTED_PREFIXES` so a reviewed plan that references
an agy artifact path cannot read/inject its contents.

### 3. Redaction-token reviewer instruction — once, in the orchestrator (`src/core/orchestrator.ts`)

Add ONE instruction line to `promptParts` (e.g. just before the diff is pushed at
~719), NOT inside `sanitizeDiff` (which runs 3× and would duplicate it):

> "`<REDACTED:…>` tokens (e.g. `<REDACTED:HIGH_ENTROPY>`) are Reviewgate's own
> placeholders for stripped secrets — they are NOT in the real code. Never report
> them as findings."

It sits among the trusted prompt parts, outside any untrusted fence.

### 4. Fence-token hardening (`src/diff/sanitizer.ts`)

Neutralize the fence delimiters if they appear in the untrusted body, so a diff
cannot spoof the fence. Add a step (alongside the injection-marker pass, before the
fenced wrap) that escapes any literal `<<UNTRUSTED_DIFF>>` / `<<END_UNTRUSTED>>` in
`body` via the existing `escapeAngles` (→ `&lt;&lt;…&gt;&gt;`). Count them into
`flaggedPatternCount`. Redaction logic itself unchanged.

### 5. Scaffold the artifact into init's `.gitignore` (`src/cli/commands/init.ts`)

Add `.antigravitycli` (NO trailing slash — matches both a directory and a symlink;
a trailing-slash pattern matches directories only) to `GITIGNORE_LINES`.
Belt-and-suspenders: §1 is the real guard (works on existing repos); the gitignore
keeps the working tree clean going forward.

## Testing

- **git.ts:** on a temp repo, create untracked `foo.ts`, `.antigravitycli/x`, and
  `sub/.antigravitycli/y`; assert `collectDiff` contains `foo.ts` but neither
  `.antigravitycli` path. Assert a committed `.antigravitycli/z` is also excluded
  (tracked pathspec). Assert a legit `.gemini/config.ts` IS still reviewed (not
  over-excluded).
- **sanitizer.ts:** a body containing `<<END_UNTRUSTED>>` comes out escaped
  (`&lt;&lt;END_UNTRUSTED&gt;&gt;`), so the real fence is unspoofable; a 24+ char
  high-entropy string still becomes `<REDACTED:HIGH_ENTROPY>` (redaction unchanged).
- **orchestrator.ts:** the assembled prompt contains the `<REDACTED:…>`-ignore
  instruction exactly once (even though `sanitizeDiff` runs 3×). (Assert via an
  orchestrator/integration test or a focused prompt-assembly check.)
- **plan-refs.ts:** `collectReferencedFileContents` excludes a referenced
  `.antigravitycli/…` path.
- **init.ts:** after `runInit`, `.gitignore` contains `.antigravitycli` (no slash);
  idempotent on re-run.

## Non-goals / YAGNI

- No generic "tool artifact" abstraction — `.antigravitycli` only.
- No `.gemini` exclusion (generic; not an in-repo agy artifact).
- No change to the redaction algorithm or the FP-runaway/quota logic (Bug 3).

## Acceptance criteria

1. Untracked `.antigravitycli` at root AND in a subdir are excluded from
   `collectDiff`; a normal untracked file and a legit `.gemini/` file are still
   included.
2. A committed `.antigravitycli/*` is excluded via the tracked pathspec + `nameArgs`.
3. `collectReferencedFileContents` refuses an `.antigravitycli/…` reference.
4. The sanitized/assembled prompt: a body `<<END_UNTRUSTED>>` is escaped; the
   `<REDACTED:…>`-ignore instruction appears exactly once, outside the fence.
5. `reviewgate init` adds `.antigravitycli` (no trailing slash) to `.gitignore`,
   idempotently.
6. `bunx tsc --noEmit`, `bun run lint`, full `bun test` clean (all renamed call
   sites updated).
