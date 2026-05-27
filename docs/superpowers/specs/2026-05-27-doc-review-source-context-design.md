# Slice 2 — Doc/Plan-Review Source Context (inject referenced files so reviewers stop guessing)

**Date:** 2026-05-27
**Status:** Design (approved) → ready for implementation plan
**Part of:** "Reviewgate ohne false flags" initiative (4 slices). This is Slice 2. (Slice 1 = codex reviewer stability, done — see `2026-05-27-codex-reviewer-stability-design.md`.)
**Locus:** new `src/research/plan-refs.ts`; wired into `src/core/orchestrator.ts` (doc-review path only); small `docReview` config addition.

## Problem (root cause of the flashbuddy plan-review FPs)

When Reviewgate reviews a plan/spec markdown (doc-review mode, persona `plan`), the reviewer panel receives the plan text (diff + full content), `conventions`, and optional Context7 library docs — but **none of the source the plan references**. The symbol graph is built from the changed files (here: the markdown), so it is empty. With no view of the actual code, reviewers **guess** about referenced components and report false positives — e.g. flagging `Card`'s `variant` prop as invalid when the repo's `Card` is a `class-variance-authority`-extended component that has exactly that prop (confirmed FPs FP-001/FP-002 in flashbuddy's ledger, the CRITICALs that drove the 1→2→4 divergence → false ESCALATE).

Slice 1 removed codex's *own* repo exploration (`--disable shell_tool`) precisely because it was non-deterministic. This slice replaces that ad-hoc exploration with **deterministic, curated** context: resolve the file paths the plan explicitly names and inject their content as a trusted reference.

## Goals / non-goals

**Goals**
- For doc/plan reviews, extract explicit repo-relative **file paths** named in the plan, read them (path-safe, budgeted), and inject their content as a trusted reference section in the reviewer prompt.
- Deterministic, fail-safe (never throws, never blocks a review), path-traversal/symlink-safe, byte- and count-bounded.
- Isolated in its own module with a clear interface; independently testable.

**Non-goals (explicitly deferred / out of scope)**
- Resolving bare **symbol names** (e.g. `Card`) to their defining file — deferred (possible Slice 2b if FP rate stays high). This slice does paths only.
- Code-diff reviews referencing unchanged files → Slice 3 (diff-scoping).
- Any change to how `research.md` or the existing "Full content of changed files" (`fileContext`) section is built.

## Design

### New module `src/research/plan-refs.ts`

Single responsibility: turn untrusted plan text into a trusted, bounded "referenced source files" block. Two exported functions:

```ts
// Extract repo-relative-looking file paths with a known code extension from
// arbitrary plan text (works on raw text OR a `git diff` body — the leading
// "+"/"-"/" " columns don't interfere). Dedupes, preserves first-seen order.
export function extractReferencedPaths(text: string): string[];

export interface ReferencedFilesInput {
  repoRoot: string;
  planText: string;
  budgetBytes: number;      // TOTAL byte cap for the rendered block
  maxFiles?: number;        // hard cap on number of files (default 20)
  excludePaths?: string[];  // repo-relative paths to skip (e.g. the changed files already in fileContext)
  signal?: AbortSignal;     // loop self-deadline: stop reading more files when aborted
}

// Resolve + read the referenced files, path-safe and bounded. Returns the
// rendered markdown block (each file as a fenced "### <relpath>" section) plus a
// trailing "_(N referenced files omitted: budget|cap)_" note when applicable.
// Returns "" when no valid references resolve. NEVER throws.
export async function collectReferencedFileContents(input: ReferencedFilesInput): Promise<string>;
```

**`extractReferencedPaths` — extraction rules**
- Regex matches path-like tokens ending in a known code extension — reuse the exact set from `diff-facts.ts:35`: `(ts|tsx|js|jsx|py|go|rs|java|kt|c|cc|cpp|h|hpp|rb|php|cs)`.
- Token charset: `[A-Za-z0-9_./-]`. Strip surrounding backticks / quotes / parens / trailing punctuation before matching.
- Dedupe, preserve first-seen order. Drop tokens containing `..` (rejected at resolution anyway) and tokens with no `/` AND no recognized directory prefix only if they don't resolve (resolution handles existence — extraction stays permissive, resolution is the gate).

**`collectReferencedFileContents` — resolution, safety, budgeting** (fail-safe; wrap the whole body so it can never throw — on any error return what's accumulated so far, or ""):
- For each extracted path, in order:
  1. `abs = resolve(repoRoot, rel)`; `relCheck = relative(repoRoot, abs)`; **reject** if `relCheck.startsWith("..")` or `isAbsolute(relCheck)` (escapes repo).
  2. **reject** if `relCheck` is the plan file itself, is in `excludePaths`, equals `reviewgate.config.ts`, or starts with `.reviewgate/`.
  3. `existsSync(abs)` must be true; **reject** otherwise.
  4. **Symlink-escape guard:** `realpathSync(abs)` must still be within `repoRoot` (resolve repoRoot via `realpathSync` once for comparison); reject if it escapes.
  5. **reject binary:** read the file; if it contains a NUL byte in the first ~8 KB, skip it (don't inject binaries).
  6. Budget: if adding this file's (capped) content would exceed `budgetBytes`, stop and count the rest as omitted. Enforce `maxFiles` likewise. A single oversized file is truncated to the remaining budget with a "… (truncated)" marker.
  7. Check `signal?.aborted` between files; stop early if aborted.
- Render each included file as:
  ```
  ### <relCheck>
  ```​
  <content>
  ```​
  ```
- Append `_(N referenced files omitted: budget)_` / `_(… : max-files)_` when applicable.

### Orchestrator integration (`src/core/orchestrator.ts`, doc-review path only)

In `runIteration`, the per-reviewer prompt is assembled in the reviewer loop (where `docPersona`, `reaffirm`, `sanitised`, `sanitisedCtx` already exist). Compute the referenced-files block **once** (it depends only on the diff + repo, not the persona) before/at the top of that section, gated on doc-review:

```ts
// Doc/plan reviews only: the reviewer can't see the source the plan names, so
// resolve the explicit file paths it references and inject them as trusted
// context (Slice 2). Code-diff reviews already get fileContext + symbol graph.
const referencedRaw = docPersona
  ? await collectReferencedFileContents({
      repoRoot: this.input.repoRoot,
      planText: this.input.diff,
      budgetBytes: this.input.config.docReview.referencedFilesBudgetBytes ?? 32_000,
      excludePaths: facts.files.map((f) => f.path),
      signal: opts.signal,
    }).catch(() => "")
  : "";
```

Inside the per-reviewer prompt build, sanitize and push it **in the same trusted-reference position as the existing "Full content of changed files" block** (immediately after the untrusted diff fence — that is where the codebase already places trusted full-file content):

```ts
const sanitisedRefs = referencedRaw
  ? sanitizeDiff({ diff: referencedRaw, personaReaffirm: reaffirm }).text
  : "";
// … after pushing the diff fence (and sanitisedCtx if present):
if (sanitisedRefs)
  promptParts.push(
    "",
    "## Referenced source files (TRUSTED reference — the plan names these paths; consult them before claiming a symbol, prop, or signature is wrong)",
    sanitisedRefs,
  );
```

`docPersona` is already derived in `runIteration` (`triage.riskClass === "docs" ? this.input.config.docReview.persona : null`-style; the reviewer loop uses `docPersona ?? r.persona`). Reuse that exact flag — when it is null (code review) the block is never computed (cost-free) and never injected.

### Config

Add an optional budget knob to `docReview` (both the zod schema in `src/config/define-config.ts` and `src/config/defaults.ts`):
- `define-config.ts`: add `referencedFilesBudgetBytes: z.number().int().positive().optional()` to the `docReview` object, and `referencedFilesBudgetBytes: 32_000` to its `.default({...})`.
- `defaults.ts`: add `referencedFilesBudgetBytes: 32_000` to the `docReview` block.

Default 32 000 bytes mirrors `fileContextBudgetBytes`. The config hash already feeds the review cache key, so changing it invalidates the cache (existing behavior — no extra work).

## Files touched

- **Create:** `src/research/plan-refs.ts` — `extractReferencedPaths` + `collectReferencedFileContents`.
- **Modify:** `src/core/orchestrator.ts` — compute the block for doc reviews; push the trusted section in the prompt.
- **Modify:** `src/config/define-config.ts` + `src/config/defaults.ts` — `docReview.referencedFilesBudgetBytes`.
- **Create:** `tests/unit/plan-refs.test.ts` — extraction + resolution/safety/budget tests.
- **Modify:** an orchestrator/integration test (or new `tests/integration/doc-review-source-context.test.ts`) — proves the section is injected for doc reviews and absent for code reviews.

## Test plan (real behavior; no vacuous mocks)

`extractReferencedPaths` (pure, deterministic):
1. Mixed text with backtick `` `src/a.ts` ``, bare `src/b.tsx`, prose word `architecture`, a non-code `notes.md`, and a dup `src/a.ts` → returns `["src/a.ts","src/b.tsx"]` (code-ext only, deduped, ordered).
2. Works on a `git diff` body (lines prefixed `+`/`-`/space) — paths still extracted.

`collectReferencedFileContents` (real temp repo dirs):
3. Two existing repo files under budget → both rendered as `### <path>` fenced blocks.
4. **Path traversal:** `../../etc/passwd` → rejected, not read.
5. **Symlink escape:** a symlink inside the repo pointing outside → rejected (realpath guard).
6. **Exclusions:** the plan file itself, a path in `excludePaths`, `reviewgate.config.ts`, and a `.reviewgate/x.ts` path → all skipped.
7. **Binary:** a file with a NUL byte → skipped.
8. **Budget / max-files:** more/larger files than the budget (or > maxFiles) → included up to the limit, with the omitted-count note; never exceeds `budgetBytes`.
9. Non-existent path → skipped silently. No referenced paths at all → returns "".

Orchestrator integration:
10. A doc-review iteration whose plan text names an existing source file → the assembled reviewer prompt contains the "## Referenced source files" section with that file's content. (Drive via a stub reviewer adapter that captures the prompt it receives, as existing orchestrator tests do.)
11. A **code** (non-doc) review iteration → the section is **absent** and `collectReferencedFileContents` is not invoked (scope guard).

Real/representative:
12. A plan that references a file defining a non-obvious API — e.g. a `class-variance-authority` `Card` with a `variant` prop — produces a referenced-files section that contains the `variant` definition. This is the mechanism that would have prevented flashbuddy's FP-001/FP-002. (Unit-level: assert the injected block contains the prop; the reviewer-behavior improvement itself is not asserted.)

## Acceptance

- `bunx tsc --noEmit` and `bun run lint` clean.
- `bun test` green incl. new tests.
- Definition-of-Done review pipeline (Codex ×2 + Claude ×2) passes; spec also Codex-reviewed before implementation.

## Risks

- **Untrusted plan controls which paths are read.** Mitigated: only existing, in-repo, non-binary code files are read (content the reviewer's process can already access); path-traversal + symlink-escape are rejected; `.reviewgate/` and config are excluded; output is fenced via `sanitizeDiff` (defense-in-depth against a source file containing injection-looking text). No network/SSRF (local FS only).
- **Noise / wrong files:** a plan may name a path that exists but is only tangential. Bounded by budget + max-files; the section is clearly labeled "reference … consult before claiming wrong," not "review this." Acceptable.
- **Budget pressure:** referenced files share the prompt with the diff + research; 32 KB default is conservative and configurable. If prompts get large, the budget is the single tuning point.
- **Paths-only coverage gap:** a plan that names a component only by symbol (no path) gets no injection — accepted (see non-goals; Slice 2b if needed).
