# Reviewer File-Context Scoping — Design

**Date:** 2026-06-16
**Status:** Approved (design), pending implementation plan
**Source:** flashbuddy field report, recommendation #2 ("give reviewers full file/function context, not just the diff hunk"). The report's most common false-positive class was reviewers literally writing *"the full file is omitted so I cannot confirm…"* and then flagging anyway at 0.6–0.95 confidence.

## Problem

`collectChangedFileContents` (`src/utils/git.ts`) injects **whole changed files** into the reviewer prompt against a **single 32 KB TOTAL budget**, processed alphabetically. Once the budget is spent, every remaining file gets `### <file>\n(omitted — context budget exceeded)` and the loop stops; a file larger than the remaining budget is **omitted entirely** (never truncated, never function-scoped). On a large changeset (the report's 170-file diff) or a single large file, most files are omitted → the reviewer sees the diff hunk with no surrounding context → guesses → false positive.

## Approach (chosen)

**Smart function-scoping, not a bigger budget.** Keep small files whole (cheap, maximal context). For a file too big for its budget, replace "omit" with a **token-efficient scoped extract**: a one-line **symbol outline** (what's defined in the file) + the **full source of the enclosing function(s)** of the changed hunks, with a **line-window fallback** for non-TS/Python files, unparseable files, or changed lines outside any symbol. More relevant context for *fewer* tokens — so it does not worsen the timeout pressure that recommendation #6 (already shipped) addresses.

The building blocks exist: `parseChangedRanges(diff)` (`src/diff/hunks.ts`) gives changed line ranges per file; the tree-sitter symbol graph (`src/research/symbol-graph.ts`, TS/TSX/Python `.wasm` grammars) can list a file's symbols with line spans. Reads reuse the existing security-hardened path (`safeReadContained` — O_NOFOLLOW + realpath containment + binary/NUL skip; `isExcludedFromReview`).

## Architecture

### New: `src/research/symbol-graph.ts` — export `fileSymbols`

`enclosingSymbol` returns only `{name, startLine}` (no `endLine` → cannot extract a body) and `parseFile` is module-private. Add:

```ts
/** A changed file's top-level + nested symbols (name, startLine, endLine, callees),
 *  or null when the language is unsupported or the file is unparseable / over the
 *  parse size cap (caller falls back to line windows). Reuses the cached parseFile. */
export async function fileSymbols(file: string, repoRoot?: string): Promise<SymbolInfo[] | null> {
  const parsed = await parseFile(file, repoRoot).catch(() => null);
  return parsed ? parsed.symbols : null;
}
```

This reuses the existing `parseCache` (parse-once-per-process) and the existing per-file parse size cap (a file over the cap → `parseFile` returns null → `fileSymbols` returns null → line-window fallback).

### New: `src/research/file-context.ts` — the scoping builder

```ts
export interface FileContextOpts {
  repoRoot: string;
  changedRanges: Map<string, Range[]>; // from parseChangedRanges(diff)
  totalBudgetBytes: number;            // hard upper bound for the whole block
  perFileBytes: number;                // whole-vs-scoped threshold AND per-file output cap
  windowLines: number;                 // ± context lines for the line-window fallback
  signal?: AbortSignal;
}
export async function collectFileContext(opts: FileContextOpts): Promise<string>;
```

Algorithm (deterministic file order = sorted keys of `changedRanges`; `used`/`totalBudgetBytes` bound the whole output exactly like today):

For each changed file (skip `isExcludedFromReview`):
1. **`lstat` probe** (TOCTOU-safe, mirrors current code): not a regular file (symlink/dir/special) → skip.
2. **size ≤ `perFileBytes`** AND fits remaining total → **whole file**: `### <file>\n```\n<safeReadContained(perFileBytes)>\n```\n` (today's behavior for small files; unchanged).
3. **size > `perFileBytes`** → **scoped**:
   - Read the source once: `safeReadContained(repoRoot, file, MAX_READ_BYTES)` where `MAX_READ_BYTES = 2 * 1024 * 1024` (= the symbol-graph's `PARSE_FILE_CAP`, so any file `fileSymbols` can parse can also be sliced; null → skip). Split into lines.
   - `syms = await fileSymbols(file, repoRoot)`.
   - **If `syms` non-null (TS/TSX/Python):**
     - **Outline:** one block `// symbols: name@L<start>, …` over all symbols (compact; tells the reviewer what's defined here — closes the *new* "undefined symbol defined elsewhere in the file" FP class).
     - **Enclosing bodies:** for each `Range` in this file, find the innermost symbol whose `[startLine,endLine]` contains the range (smallest span = tightest fit, same rule as `enclosingSymbol`). Dedupe the set of enclosing symbols. Emit each symbol's full source (`lines[startLine-1 … endLine]`) once.
     - **Orphan ranges** (changed line inside no symbol — top-level statements) → a **line-window** (`±windowLines`) around the range.
   - **If `syms` is null** (non-TS/Python, parse failure, or over the parse cap) → **line-windows only**: `±windowLines` around each changed range, merged when overlapping.
   - Header marks it scoped: `### <file> (scoped: symbol outline + enclosing functions of the changed lines)`.
   - Cap the file's scoped output at `perFileBytes`; if a single enclosing function alone exceeds it, emit a head slice + `… (function body truncated — over per-file context budget)`.
4. **Total budget exhausted** → `### <file>\n(omitted — context budget exceeded)` marker, then stop (today's behavior, but now reached far less often since scoped output is small).

### Orchestrator wiring (`src/core/orchestrator.ts`)

- The reviewer-prompt context switches from `collectChangedFileContents(...)` to `collectFileContext({ repoRoot, changedRanges: parseChangedRanges(this.input.diff), totalBudgetBytes: …fileContextBudgetBytes, perFileBytes: …fileContextPerFileBytes, windowLines: …fileContextWindowLines, signal })`. `parseChangedRanges(this.input.diff)` is already computed for `aggregate()`’s `changedRanges` — reuse it (one parse).
- **Grounding corpus stays whole-file (no regression).** S6 grounding (default-OFF) demotes a CRITICAL whose cited code token is *absent from the corpus*; a scoped corpus could wrongly mark a token absent. So when `phases.grounding` is configured, build the grounding corpus from **whole-file** content via the retained `collectChangedFileContents` (computed lazily, only when grounding runs). The prompt uses the scoped context; grounding uses whole-file. `collectChangedFileContents` is **kept** (not deleted) for this consumer.

### Header / labeling (`orchestrator.ts` prompt assembly)

The section header changes from "Full content of changed files (reference only — …)" to an honest description so a reviewer never assumes whole-file completeness when the content is scoped:

> ## Changed-file context (reference only — review the DIFF above)
> Full source for small files. For large files: a symbol outline (everything defined in the file) + the full source of the enclosing function(s) of the changed lines (and line windows for anything outside a function). Use this to confirm a symbol exists / read the surrounding logic before reporting something undefined or missing.

### Config (`phases.review`, flat, beside `fileContextBudgetBytes`)

- `fileContextBudgetBytes` — existing, **total** budget; default unchanged `32_000` (stretches much further now). `define-config.ts`: already `z.number().int().positive().optional()`.
- **new** `fileContextPerFileBytes` — default `8_000`. Whole-vs-scoped threshold + per-file output cap. `z.number().int().positive().optional()`.
- **new** `fileContextWindowLines` — default `40`. Line-window radius for the fallback. `z.number().int().nonnegative().optional()`.

Defaults live in `src/config/defaults.ts` (`phases.review`); schema in `src/config/define-config.ts`.

## Testing (TDD, `bun test`, no provider subprocess)

`tests/unit/file-context.test.ts` against a temp repo (write files, build a `changedRanges` map, call `collectFileContext`):
- Small file (≤ perFileBytes) → whole-file block, unchanged.
- Large TS file, change inside one function → output contains that function's full body + the symbol outline; does NOT contain an *unrelated* large function's body.
- A symbol defined elsewhere in the same large file → its name appears in the outline (undefined-FP protection).
- Large non-TS file (e.g. `.go`) → line-windows around the changed ranges (no symbol outline, not whole-file, not omitted).
- Change at a top-level statement (no enclosing symbol) in a large TS file → line-window for that range.
- Many files exceeding the total budget → later files still get scoped context until the total cap; the hard `(omitted)` marker only past the total cap; total output ≤ totalBudgetBytes.
- Security: a symlink / binary / `isExcludedFromReview` path is skipped (reuse `safeReadContained` + the lstat probe).
- `fileSymbols` returns null for an unsupported extension and for a file over the parse cap (→ fallback path taken).

## Definition of Done

`bunx tsc --noEmit` + `bun run lint` clean; full `bun test` green (use `--timeout 30000`; default-5s failures are known subprocess-spawn flakes); then the dogfood gate PASS.

## Out of scope

Caller/callee-signature injection (YAGNI); raising the budget as the primary mechanism (keeps the #6 timeout posture); symbol extraction for languages beyond TS/TSX/Python (they get line windows). The N5 `collaboratorContext` (imported-file source, default-off) is a separate, complementary feature — untouched.
