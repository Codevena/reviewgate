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

### Changed: `src/research/symbol-graph.ts` — per-language queries + export `fileSymbols`

Two changes here, both improving the shared symbol graph (so `enclosingSymbol` — used by fact-check — and `buildSymbolGraph` — used by the brain — get the same richer coverage):

**(1) Per-language symbol queries (replaces the single `FN_QUERY`).** Today `FN_QUERY` is ONE string used for both TS and Python, but it contains only TS/JS node types (`function_declaration`, `method_definition`, `function_signature`) — so it matches **nothing** for Python (a latent gap; only `.ts` is currently tested) and misses the dominant TS/React forms (`const X = () => {}`, exported arrows, function expressions, classes). Split into per-grammar queries selected by `grammarForFile(file).lang`:
- **`FN_QUERY_TS`** (typescript/tsx/js/jsx): the existing three captures PLUS a `lexical_declaration`→`variable_declarator` whose `value` is an `arrow_function` or `function_expression` (the `@sym` span = the whole declaration so the reviewer gets `const Component = (props) => { …full body… }`; `@n` = the bound identifier), PLUS `class_declaration` (name → `@n`, whole class → `@sym`). Arrow consts wrapped in `export_statement` still match because the `lexical_declaration` is a child.
- **`FN_QUERY_PY`** (python): `function_definition` + `class_definition` (name child → `@n`, whole node → `@sym`). This is a net-new capability — Python symbol extraction works for the first time.

A query references only node types that EXIST in its own grammar, so `new Query(lang, …)` never throws on a cross-grammar unknown-node type.

**`CALL_QUERY` must be split per-language too — it is currently TS-only and is the *first* `new Query` compiled for every file.** `CALL_QUERY` (`call_expression`, `member_expression`, `property_identifier`) has no Python node types, so `new Query(pythonLang, CALL_QUERY)` throws `Bad node name 'call_expression'` *before* any symbol is returned — which is why Python symbol extraction is broken today and why splitting only `FN_QUERY` would NOT fix it. Add `CALL_QUERY_PY` (`(call function: [(identifier) @c (attribute attribute: (identifier) @c)])`) and select both `CALL_QUERY_*` and `FN_QUERY_*` by `grammarForFile(file).lang`.

**Defensive compile (belt-and-suspenders):** wrap the two `new Query(lang, …)` calls in `try/catch`; on any compile error, treat the file as unparseable (`parseFileUncached` returns null → `fileSymbols` null → line-window fallback) instead of throwing. So a future grammar/query mismatch degrades gracefully rather than killing the symbol graph for a language.

**This MUST be verified against the real `.wasm` grammars** (a malformed query throws at `new Query` → the symbol graph dies for that language); stub tests do not catch query-compile errors — see Testing.

**(2) Export `fileSymbols`** — `enclosingSymbol` returns only `{name, startLine}` (no `endLine` → cannot extract a body) and `parseFile` is module-private. Add:

```ts
/** A changed file's symbols (name, startLine, endLine, callees) for the per-language
 *  query, or null when the language is unsupported or the file is unparseable / over the
 *  parse size cap (caller falls back to line windows). Reuses the cached parseFile. */
export async function fileSymbols(file: string, repoRoot?: string): Promise<SymbolInfo[] | null> {
  const parsed = await parseFile(file, repoRoot).catch(() => null);
  return parsed ? parsed.symbols : null;
}
```

Reuses the existing `parseCache` (parse-once-per-process) and the per-file parse size cap (over cap → null → line-window fallback). **Blast radius:** the existing consumers get strictly MORE symbols (additive). `enclosingSymbol` still picks the innermost-by-span (an arrow const inside which a line changed now resolves to that const — an improvement); `buildSymbolGraph` lists more symbols (more accurate caller/callee graph). One accepted nuance: a class/outer-const `@sym` spans the whole node, so `CALL_QUERY` captures calls from inner methods/nested functions as the outer symbol's `callees` — a redundant superset in the brain's call graph. Advisory-only (brain is default-off; no verdict impact). The existing `symbol-graph.test.ts` + `signature-symbol.test.ts` must stay green; new-form tests are added.

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

For each changed file (skip `isExcludedFromReview`) — **check `used >= totalBudgetBytes` at the TOP of the iteration and stop** (mirror `git.ts:396`), so read + parse work scales with the output budget, not the file count, on a 170-file diff:
1. **`lstat` probe** (TOCTOU-safe, mirrors current code): not a regular file (symlink/dir/special) → skip.
2. **size ≤ `perFileBytes`** AND fits remaining total → **whole file**: `### <file>\n```\n<safeReadContained(perFileBytes)>\n```\n` (today's behavior for small files; unchanged).
3. **size > `perFileBytes`** → **scoped**:
   - Read the source once: `safeReadContained(repoRoot, file, MAX_READ_BYTES)` where `MAX_READ_BYTES = 2 * 1024 * 1024` (= the symbol-graph's `PARSE_FILE_CAP`). `safeReadContained` returns **null** (does not truncate) when the file exceeds `MAX_READ_BYTES` — so a file **> 2 MB** cannot be read at all → emit the `(omitted — too large for context: N bytes)` marker and continue. (Accepted narrow exception: a >2 MB source file is almost always generated/minified; a bounded range-read is YAGNI.) Otherwise split the content into `lines`.
   - `syms = await fileSymbols(file, repoRoot)`.
   - **Range semantics (explicit).** `parseChangedRanges` yields `Range = [start, endExclusive]` per hunk — NEW-file line numbers from `@@` headers, **including context lines**, and a hunk may span zero, one, or several symbols. So convert each range to inclusive `[rs, re] = [start, endExclusive - 1]` and select symbols by **overlap, not containment**: a symbol `s` is selected if `s.startLine <= re && s.endLine >= rs`. tree-sitter `startLine`/`endLine` are 1-based inclusive.
   - **If `syms` non-null (TS/TSX/Python):**
     - **Outline:** one block `// symbols: name@L<startLine>, …` over all symbols (compact; tells the reviewer what's defined here — closes the *new* "undefined symbol defined elsewhere in the file" FP class).
     - **Enclosing bodies:** the union of all symbols overlapping any changed range, then **collapse nesting** — drop any selected symbol whose span is fully contained within another selected symbol's span (`outer.startLine <= inner.startLine && outer.endLine >= inner.endLine`), keeping the OUTERMOST. This is required because an arrow-const `@sym` is the whole `lexical_declaration` and a class `@sym` is the whole class: a changed line in a method-inside-a-class or a nested-arrow-inside-a-const overlaps BOTH the parent and the child, and a plain `(startLine,endLine)` dedup would emit the inner body twice and double-charge it against the budgets. Emit each surviving symbol's full source once via `lines.slice(startLine - 1, endLine)` (1-based inclusive → JS slice's exclusive end keeps the `endLine` row).
     - **Uncovered lines:** any inclusive `[rs, re]` line not covered by a selected symbol (top-level statement, or a hunk's context spilling outside functions) → a **line-window** `lines.slice(max(0, rs-1-windowLines), re+windowLines)`. Merge windows that overlap so the same lines aren't emitted twice.
   - **If `syms` is null** (non-TS/Python, parse failure) → **line-windows only**: a `±windowLines` window around each changed `[rs, re]`, merged when overlapping. No outline.
   - Header marks it scoped: `### <file> (scoped: symbol outline + enclosing functions of the changed lines)` (or `(scoped: line windows around the changed lines)` for the null-syms path).
   - Cap the file's scoped output at `perFileBytes`; if the selected bodies/windows exceed it, emit what fits in symbol/window order + `… (truncated — over per-file context budget)`.
4. **Total budget exhausted** → `### <file>\n(omitted — context budget exceeded)` marker, then stop (today's behavior, but now reached far less often since scoped output is small).

**Budget accounting (explicit):** `used` counts the **final rendered bytes** of every emitted block — file content AND the outline text, headers, truncation markers, and omission markers — against BOTH the per-file cap (`perFileBytes`) and the running total (`totalBudgetBytes`), mirroring today's `collectChangedFileContents` (which counts rendered block length, not raw file size). The total output is hard-bounded by `totalBudgetBytes`.

### Orchestrator wiring (`src/core/orchestrator.ts`)

`fileContext` has exactly two consumers: the reviewer prompt and the grounding corpus. We split them.

- **Reviewer prompt → scoped (the feature):** add `const promptContext = await collectFileContext({ repoRoot, changedRanges: parseChangedRanges(this.input.diff), totalBudgetBytes: …fileContextBudgetBytes, perFileBytes: …fileContextPerFileBytes, windowLines: …fileContextWindowLines, signal })`. `parseChangedRanges(this.input.diff)` is already computed for `aggregate()`’s `changedRanges` — reuse the one parse. The prompt's `sanitisedCtx` is built from `promptContext`.
- **Grounding corpus → whole-file, UNCHANGED (zero regression).** The deterministic grounding pass `groundFindings(allFindings, groundingCorpus)` runs **unconditionally** (not just when the opt-in `phases.grounding` LLM judge is configured) and demotes a CRITICAL whose cited code-shaped token is *absent from the corpus*. So the grounding corpus MUST keep using **whole-file** content. We therefore keep building `const fileContext = await collectChangedFileContents(...)` exactly as today and keep `groundingCorpus = \`${diff}\n${fileContext}\``. `collectChangedFileContents` is **retained unchanged**; grounding behaves identically to today (same 32 KB-budgeted whole-file corpus — no better, no worse). Only the prompt changes.
- **Cost:** both builders run every gate (the existing whole-file pass for grounding + the new scoped pass for the prompt). The whole-file pass is cheap (stops at the 32 KB budget); the scoped pass reads big files (≤ 2 MB) to slice. Accepted for zero-regression correctness; a future single-pass optimization is possible but YAGNI now.
- Update the comment at `groundingCorpus` so it no longer claims "corpus = exactly what the reviewer was shown" (the reviewer now sees scoped context; grounding deliberately checks against the fuller whole-file corpus — which is *more* correct, not less).

### Header / labeling (`orchestrator.ts` prompt assembly)

The section header changes from "Full content of changed files (reference only — …)" to an honest description so a reviewer never assumes whole-file completeness when the content is scoped:

> ## Changed-file context (reference only — review the DIFF above)
> Full source for small files. For large files: an outline of the functions, methods, components, and classes defined in the file + the full source of the enclosing one(s) for the changed lines (and line windows for anything outside them). Use this to confirm a symbol exists / read the surrounding logic before reporting something undefined or missing; if a symbol you need is not shown, say so rather than assuming it is absent.

### Config (`phases.review`, flat, beside `fileContextBudgetBytes`)

- `fileContextBudgetBytes` — existing, **total** budget; default unchanged `32_000` (stretches much further now). `define-config.ts`: already `z.number().int().positive().optional()`.
- **new** `fileContextPerFileBytes` — default `8_000`. Whole-vs-scoped threshold + per-file output cap. `z.number().int().positive().optional()`.
- **new** `fileContextWindowLines` — default `40`. Line-window radius for the fallback. `z.number().int().nonnegative().optional()`.

Defaults live in `src/config/defaults.ts` (`phases.review`); schema in `src/config/define-config.ts`.

## Testing (TDD, `bun test`, no provider subprocess)

**`tests/unit/symbol-graph.test.ts` (additions — MUST run against the real `.wasm` grammars, not stubs, since a malformed query only fails at real `new Query` time):**
- TS: `function_declaration`, `method_definition`, **`const X = () => {}`**, **`export const X = () => {}`**, **function-expression const**, and **`class Foo {}`** each produce a `SymbolInfo` with the correct `name`, `startLine`, `endLine` (full declaration span).
- TSX: an arrow-function component is captured (the dominant React form).
- Python: `def f():` and `class C:` each produce a `SymbolInfo` (previously zero — net-new, since both `FN_QUERY` and `CALL_QUERY` were TS-only and threw); a `def` that calls another function records the callee (`CALL_QUERY_PY` compiles + matches).
- `enclosingSymbol` behavior shift (lock it explicitly — it's a real change, not "strictly additive"): a line inside an arrow-const body resolves to that const (was null); a line inside a class body but outside any method resolves to the class (was null). Benign (one-time FP-ledger signature drift at deploy), but asserted so it's intentional.
- Defensive compile: a deliberately malformed query / unsupported-grammar path returns null (file treated unparseable → line-window fallback) instead of throwing.
- Regression: the existing `symbol-graph.test.ts` / `signature-symbol.test.ts` assertions still pass (additive coverage).

**`tests/unit/file-context.test.ts`** against a temp repo (write files, build a `changedRanges` map, call `collectFileContext`):
- Small file (≤ perFileBytes) → whole-file block, unchanged.
- Large TS file, change inside one function → output contains that function's full body + the symbol outline; does NOT contain an *unrelated* large function's body.
- A symbol defined elsewhere in the same large file → its name appears in the outline (undefined-FP protection).
- **Hunk overlapping two functions** (a `[start, endExclusive)` range spanning the end of one and the start of another) → BOTH function bodies emitted (overlap selection, not containment).
- **Nested symbols** — a change inside a method-in-a-class (and inside a nested-arrow-in-a-const): the OUTERMOST enclosing body (the class / the const) is emitted exactly ONCE; the inner body is NOT emitted a second time, and the bytes are charged once (nesting-collapse guard).
- Large non-TS file (e.g. `.go`) → line-windows around the changed ranges (no symbol outline, not whole-file, not omitted).
- Change at a top-level statement (no enclosing symbol) in a large TS file → line-window for that range; merged windows don't duplicate lines.
- A changed range whose end runs **past EOF** → clamped, no crash.
- **File > 2 MB** (`MAX_READ_BYTES`) → `(omitted — too large for context)` marker (safeReadContained returns null), continue.
- Many files exceeding the total budget → later files still get scoped context until the total cap; the hard `(omitted)` marker only past the total cap; total output ≤ totalBudgetBytes (outline/headers/markers counted).
- Security: a symlink / binary / `isExcludedFromReview` path is skipped (reuse `safeReadContained` + the lstat probe).
- A file listed in `changedRanges` but deleted/unreadable mid-run → skipped, no crash (safeReadContained null / lstat throws).
- `fileSymbols` returns null for an unsupported extension and for a file over the parse cap (→ line-window fallback taken).

**Read-path constraint:** `file-context.ts` performs NO raw `readFileSync`/`Bun.file` reads — every content read goes through `safeReadContained` (preserving O_NOFOLLOW + realpath containment + binary/NUL skip), and `fileSymbols` parses via the same path. The only direct fs call is the `lstatSync` regular-file probe (which never follows symlinks), exactly mirroring `collectChangedFileContents`.

## Definition of Done

`bunx tsc --noEmit` + `bun run lint` clean; full `bun test` green (use `--timeout 30000`; default-5s failures are known subprocess-spawn flakes); then the dogfood gate PASS.

## Out of scope

Caller/callee-signature injection (YAGNI); raising the budget as the primary mechanism (keeps the #6 timeout posture); symbol extraction for languages beyond TS/TSX/Python (they get line windows). The N5 `collaboratorContext` (imported-file source, default-off) is a separate, complementary feature — untouched.
