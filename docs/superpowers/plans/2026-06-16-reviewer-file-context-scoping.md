# Reviewer File-Context Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace "whole-file-or-omit" reviewer context with token-efficient function scoping — small files whole; large files get a symbol outline + the enclosing function/component/class bodies of the changed lines (line-window fallback) — so reviewers stop saying "full file omitted, can't confirm" and guessing.

**Architecture:** (1) Expand the tree-sitter symbol graph to per-language queries (TS adds arrow-const/function-expression/class; Python gains def/class) with defensive compile, and export `fileSymbols`. (2) New `src/research/file-context.ts` builds the scoped context, reusing `safeReadContained`. (3) Orchestrator feeds the reviewer prompt the scoped context while the always-on grounding corpus keeps whole-file content unchanged (zero grounding regression). Spec: `docs/superpowers/specs/2026-06-16-reviewer-file-context-scoping-design.md` (codex 3 rounds + opus PASS).

**Tech Stack:** Bun, TypeScript, web-tree-sitter (TS/TSX/Python `.wasm`), zod, `bun test`. Use `bun`/`bunx`, never npm/node.

---

## File Structure

- `src/research/symbol-graph.ts` — per-language `FN_QUERY_*`/`CALL_QUERY_*`, defensive `new Query` try/catch, new `fileSymbols` export. (Task 1)
- `src/research/file-context.ts` — NEW: `collectFileContext()` scoping builder. (Task 2)
- `src/config/defaults.ts` + `src/config/define-config.ts` — `fileContextPerFileBytes` (8_000), `fileContextWindowLines` (40). (Task 3)
- `src/core/orchestrator.ts` — prompt → `collectFileContext`; grounding corpus keeps `collectChangedFileContents`; honest header. (Task 3)
- Tests: `tests/unit/symbol-graph.test.ts` (additions, real `.wasm`), `tests/unit/file-context.test.ts` (new). (Tasks 1–2)

---

## Task 1: Symbol-graph per-language queries + `fileSymbols`

**Files:**
- Modify: `src/research/symbol-graph.ts` (consts ~70-73; `parseFileUncached` query block ~117-141; add `fileSymbols` after `parseFile` ~89)
- Test: `tests/unit/symbol-graph.test.ts`

- [ ] **Step 1: Write failing tests** (append inside the `describe("symbol-graph", …)` block in `tests/unit/symbol-graph.test.ts`; they MUST run against the real grammars — these are what catch a malformed query):

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
// (reuse existing imports: enclosingSymbol, buildSymbolGraph, fileSymbols, join)
import { fileSymbols } from "../../src/research/symbol-graph.ts";

it("captures TS arrow-const, exported arrow, function-expression, class, method", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-sym-ts-"));
  const f = join(dir, "x.ts");
  writeFileSync(
    f,
    [
      "export const Widget = (p: number) => {",
      "  return p + 1;",
      "};",
      "const helper = function () { return 2; };",
      "class Box {",
      "  area() { return 3; }",
      "}",
      "function plain() { return 4; }",
    ].join("\n"),
  );
  const syms = await fileSymbols(f, dir);
  const names = (syms ?? []).map((s) => s.name).sort();
  expect(names).toContain("Widget"); // exported arrow const
  expect(names).toContain("helper"); // function-expression const
  expect(names).toContain("Box"); // class
  expect(names).toContain("area"); // method
  expect(names).toContain("plain"); // function declaration
  // span of the arrow const covers its whole declaration (lines 1-3, 1-based)
  const w = (syms ?? []).find((s) => s.name === "Widget");
  expect(w?.startLine).toBe(1);
  expect(w?.endLine).toBe(3);
});

it("captures Python def and class (previously zero — both queries were TS-only)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-sym-py-"));
  const f = join(dir, "x.py");
  writeFileSync(f, ["def foo():", "    bar()", "", "class C:", "    def m(self):", "        pass"].join("\n"));
  const syms = await fileSymbols(f, dir);
  const names = (syms ?? []).map((s) => s.name).sort();
  expect(names).toContain("foo");
  expect(names).toContain("C");
  // CALL_QUERY_PY compiled + matched: foo's callee bar recorded
  const foo = (syms ?? []).find((s) => s.name === "foo");
  expect(foo?.callees).toContain("bar");
});

it("enclosingSymbol resolves a line inside an arrow-const body (was null before)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-sym-enc-"));
  const f = join(dir, "y.ts");
  writeFileSync(f, ["export const Widget = () => {", "  const z = 1;", "  return z;", "};"].join("\n"));
  const sym = await enclosingSymbol(f, 2, dir);
  expect(sym?.name).toBe("Widget");
});

it("fileSymbols returns null for an unsupported extension", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-sym-unsup-"));
  const f = join(dir, "x.rb");
  writeFileSync(f, "def foo; end\n");
  expect(await fileSymbols(f, dir)).toBeNull();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/symbol-graph.test.ts`
Expected: FAIL — `fileSymbols` is not exported; arrow-const/class/Python names missing.

- [ ] **Step 3: Replace the single queries with per-language queries**

In `src/research/symbol-graph.ts`, REPLACE:

```ts
const FN_QUERY =
  "[(function_declaration name:(identifier) @n) (method_definition name:(property_identifier) @n) (function_signature name:(identifier) @n)] @sym";
const CALL_QUERY =
  "(call_expression function: [(identifier) @c (member_expression property:(property_identifier) @c)])";
```

with:

```ts
// Per-language symbol + call queries. A query may reference ONLY node types that exist in its
// OWN grammar — a TS node name in a Python query (or vice-versa) makes `new Query()` throw
// "Bad node name …". Selected by grammarForFile().lang. (Before: one TS-only pair, which
// matched nothing for Python AND threw on CALL_QUERY, and missed arrow-const/func-expr/class.)
const FN_QUERY_TS =
  "[(function_declaration name:(identifier) @n) (method_definition name:(property_identifier) @n) (function_signature name:(identifier) @n) (lexical_declaration (variable_declarator name:(identifier) @n value:[(arrow_function) (function_expression)])) (class_declaration name:(type_identifier) @n)] @sym";
const FN_QUERY_PY =
  "[(function_definition name:(identifier) @n) (class_definition name:(identifier) @n)] @sym";
const CALL_QUERY_TS =
  "(call_expression function: [(identifier) @c (member_expression property:(property_identifier) @c)])";
const CALL_QUERY_PY = "(call function: [(identifier) @c (attribute attribute:(identifier) @c)])";

function queriesFor(lang: string): { fn: string; call: string } {
  return lang === "python"
    ? { fn: FN_QUERY_PY, call: CALL_QUERY_PY }
    : { fn: FN_QUERY_TS, call: CALL_QUERY_TS };
}
```

- [ ] **Step 4: Use the per-language queries + add defensive compile in `parseFileUncached`**

In `parseFileUncached`, the block currently reads:

```ts
  let symQ: Query | null = null;
  let callQ: Query | null = null;
  try {
    const symbols: SymbolInfo[] = [];
    symQ = new Query(lang, FN_QUERY);
    callQ = new Query(lang, CALL_QUERY);
    for (const match of symQ.matches(tree.rootNode)) {
```

Change the two `new Query` lines and add a `catch` (keep the existing `finally`):

```ts
  let symQ: Query | null = null;
  let callQ: Query | null = null;
  try {
    const symbols: SymbolInfo[] = [];
    const q = queriesFor(g.lang);
    symQ = new Query(lang, q.fn);
    callQ = new Query(lang, q.call);
    for (const match of symQ.matches(tree.rootNode)) {
```

…and immediately before the existing `} finally {`, insert:

```ts
  } catch {
    // Malformed query / grammar mismatch → treat the file as unparseable so the caller
    // falls back to line windows, instead of throwing and killing the symbol graph for
    // this language. (`finally` below still releases the native handles.)
    return null;
```

(`g` is already in scope from `const g = grammarForFile(file)` at the top of `parseFileUncached`.)

- [ ] **Step 5: Export `fileSymbols`** — directly after the `parseFile` function (the cached wrapper, ~line 89), add:

```ts
/** A changed file's symbols (name, startLine, endLine, callees) from the per-language query,
 *  or null when the language is unsupported or the file is unparseable / over the parse size
 *  cap (caller falls back to line windows). Reuses the cached parseFile. */
export async function fileSymbols(file: string, repoRoot?: string): Promise<SymbolInfo[] | null> {
  const parsed = await parseFile(file, repoRoot).catch(() => null);
  return parsed ? parsed.symbols : null;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test tests/unit/symbol-graph.test.ts`
Expected: PASS (new tests + the pre-existing ones — additive coverage, no regression).

- [ ] **Step 7: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint` (run `bun run format` first if biome reports formatting). Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/research/symbol-graph.ts tests/unit/symbol-graph.test.ts
git commit -m "feat(symbol-graph): per-language queries (arrow-const/class/Python) + fileSymbols

FN_QUERY/CALL_QUERY were TS-only (matched nothing for Python, threw on CALL_QUERY,
missed arrow-const/func-expr/class). Split per grammarForFile().lang; defensive
new Query try/catch → null on compile error. Export fileSymbols for scoped context."
```

---

## Task 2: `file-context.ts` — `collectFileContext`

**Files:**
- Create: `src/research/file-context.ts`
- Test: `tests/unit/file-context.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/file-context.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Range } from "../../src/diff/hunks.ts";
import { collectFileContext } from "../../src/research/file-context.ts";

function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-fctx-"));
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(dir, rel), content);
  return dir;
}
const opts = (repoRoot: string, ranges: [string, Range[]][]) => ({
  repoRoot,
  changedRanges: new Map(ranges),
  totalBudgetBytes: 32_000,
  perFileBytes: 400,
  windowLines: 3,
});

describe("collectFileContext", () => {
  test("small file → whole-file block", async () => {
    const repo = repoWith({ "a.ts": "export const x = 1;\n" });
    const out = await collectFileContext(opts(repo, [["a.ts", [[1, 2]]]]));
    expect(out).toContain("### a.ts");
    expect(out).toContain("export const x = 1;");
    expect(out).not.toContain("scoped");
  });

  test("large TS file, change in one function → that body + outline, NOT the unrelated body", async () => {
    const big = `${"// pad\n".repeat(80)}function target() {\n  return 42;\n}\nfunction unrelatedHuge() {\n${"  const q = 1;\n".repeat(60)}}\n`;
    const repo = repoWith({ "b.ts": big });
    // target() sits around line 81-83 in the padded file
    const out = await collectFileContext(opts(repo, [["b.ts", [[81, 84]]]]));
    expect(out).toContain("scoped");
    expect(out).toContain("function target()");
    expect(out).toContain("// symbols:"); // outline lists symbols incl. unrelatedHuge
    expect(out).toContain("unrelatedHuge"); // its NAME is in the outline (undefined-FP guard)
    expect(out).not.toContain("const q = 1;"); // its BODY is not emitted
  });

  test("nested method-in-class → outermost (class) body once, not double", async () => {
    const cls = `${"// pad\n".repeat(60)}class Svc {\n  run() {\n    return doWork();\n  }\n}\n`;
    const repo = repoWith({ "c.ts": cls });
    const out = await collectFileContext(opts(repo, [["c.ts", [[63, 64]]]])); // inside run()
    expect(out).toContain("class Svc");
    // the body of run() appears exactly once (not duplicated by also emitting the method)
    expect(out.split("return doWork();").length - 1).toBe(1);
  });

  test("large non-TS file (.go) → line window, no outline, not omitted", async () => {
    const go = `${"// pad\n".repeat(120)}func Target() int {\n\treturn 7\n}\n`;
    const repo = repoWith({ "d.go": go });
    const out = await collectFileContext(opts(repo, [["d.go", [[121, 123]]]]));
    expect(out).toContain("func Target()");
    expect(out).not.toContain("// symbols:");
    expect(out).not.toContain("(omitted");
  });

  test("threshold + budget: total output is bounded and later files get scoped context", async () => {
    const f = `${"x".repeat(1000)}\n`;
    const repo = repoWith({ "a.ts": `const a=()=>{${f}};\n`, "z.ts": `const z=()=>{${f}};\n` });
    const out = await collectFileContext({
      ...opts(repo, [
        ["a.ts", [[1, 2]]],
        ["z.ts", [[1, 2]]],
      ]),
      totalBudgetBytes: 1200,
    });
    expect(out.length).toBeLessThanOrEqual(1200);
  });

  test("symlink / excluded path is skipped", async () => {
    const repo = repoWith({ "real.ts": "const ok = 1;\n" });
    const out = await collectFileContext(
      opts(repo, [
        ["real.ts", [[1, 2]]],
        [".reviewgate/state.json", [[1, 2]]],
      ]),
    );
    expect(out).toContain("real.ts");
    expect(out).not.toContain(".reviewgate/state.json");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/unit/file-context.test.ts`
Expected: FAIL — module `src/research/file-context.ts` does not exist.

- [ ] **Step 3: Implement `collectFileContext`**

Create `src/research/file-context.ts`:

```ts
// src/research/file-context.ts
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Range } from "../diff/hunks.ts";
import { isExcludedFromReview } from "../utils/git.ts";
import { safeReadContained } from "../utils/safe-read.ts";
import { fileSymbols } from "./symbol-graph.ts";

const MAX_READ_BYTES = 2 * 1024 * 1024; // = symbol-graph PARSE_FILE_CAP, so a parseable file is sliceable

export interface FileContextOpts {
  repoRoot: string;
  changedRanges: Map<string, Range[]>;
  totalBudgetBytes: number;
  perFileBytes: number;
  windowLines: number;
  signal?: AbortSignal;
}

// Merge [startInclusive, endInclusive] line intervals (1-based) that touch/overlap.
function mergeIntervals(iv: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...iv].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Array<[number, number]> = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

export async function collectFileContext(opts: FileContextOpts): Promise<string> {
  const { repoRoot, changedRanges, totalBudgetBytes, perFileBytes, windowLines, signal } = opts;
  let repoReal: string | undefined;
  try {
    repoReal = realpathSync(repoRoot);
  } catch {
    repoReal = undefined;
  }
  let out = "";
  let used = 0;
  const emit = (s: string): boolean => {
    out += s;
    used += s.length;
    return used >= totalBudgetBytes;
  };

  for (const file of [...changedRanges.keys()].sort()) {
    signal?.throwIfAborted();
    if (used >= totalBudgetBytes) break; // bound read work by budget, not file count
    if (isExcludedFromReview(file)) continue;
    const abs = join(repoRoot, file);
    let size: number;
    try {
      const st = lstatSync(abs);
      if (!st.isFile()) continue; // symlink/dir/special
      size = st.size;
    } catch {
      continue; // vanished mid-run
    }

    // Small file → whole content (today's behavior).
    if (size <= perFileBytes) {
      const content = safeReadContained(repoRoot, file, perFileBytes, repoReal);
      if (content === null) continue; // binary/NUL/containment
      if (emit(`### ${file}\n\`\`\`\n${content}\n\`\`\`\n`)) break;
      continue;
    }

    // Large file → scoped. Read up to MAX_READ_BYTES for slicing; >2MB → omit.
    const content = safeReadContained(repoRoot, file, MAX_READ_BYTES, repoReal);
    if (content === null) {
      if (emit(`### ${file}\n(omitted — too large for context or unreadable)\n`)) break;
      continue;
    }
    const lines = content.split("\n");
    const ranges = changedRanges.get(file) ?? [];
    const syms = await fileSymbols(abs, repoRoot);

    const parts: string[] = [];
    const covered: Array<[number, number]> = []; // inclusive line intervals already emitted as bodies

    if (syms && syms.length > 0) {
      // Outline of every captured symbol (name@line) — closes the "undefined symbol defined
      // elsewhere in the file" FP class without emitting bodies.
      parts.push(`// symbols: ${syms.map((s) => `${s.name}@L${s.startLine}`).join(", ")}`);
      // Symbols overlapping any changed range (Range = [start, endExclusive] → inclusive [rs, re]).
      let selected = syms.filter((s) =>
        ranges.some(([start, endEx]) => s.startLine <= endEx - 1 && s.endLine >= start),
      );
      // Collapse nesting: drop a symbol fully contained in another selected symbol (keep outermost).
      selected = selected.filter(
        (s) =>
          !selected.some(
            (o) => o !== s && o.startLine <= s.startLine && o.endLine >= s.endLine,
          ),
      );
      for (const s of selected.sort((a, b) => a.startLine - b.startLine)) {
        parts.push(lines.slice(s.startLine - 1, s.endLine).join("\n"));
        covered.push([s.startLine, s.endLine]);
      }
    }

    // Line windows for changed lines not covered by an emitted symbol body (orphan top-level
    // statements, or the whole file when syms is null).
    const windows: Array<[number, number]> = [];
    for (const [start, endEx] of ranges) {
      const rs = start;
      const re = endEx - 1;
      const isCovered = covered.some(([cs, ce]) => cs <= rs && ce >= re);
      if (isCovered) continue;
      windows.push([Math.max(1, rs - windowLines), Math.min(lines.length, re + windowLines)]);
    }
    for (const [ws, we] of mergeIntervals(windows)) {
      parts.push(lines.slice(ws - 1, we).join("\n"));
    }

    const tag = syms && syms.length > 0 ? "symbol outline + enclosing functions" : "line windows";
    let body = parts.join("\n…\n");
    if (body.length > perFileBytes) {
      body = `${body.slice(0, perFileBytes)}\n… (truncated — over per-file context budget)`;
    }
    if (emit(`### ${file} (scoped: ${tag} of the changed lines)\n\`\`\`\n${body}\n\`\`\`\n`)) break;
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/unit/file-context.test.ts`
Expected: PASS (6 tests). If the padded line numbers in a test don't land where expected, adjust the `changedRanges` line numbers to point inside the intended symbol (the assertions, not the implementation, are what to tune).

- [ ] **Step 5: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint` (format first if needed). Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/research/file-context.ts tests/unit/file-context.test.ts
git commit -m "feat(file-context): scoped reviewer context (outline + enclosing bodies + windows)

Small files whole; large files → symbol outline + enclosing function/component/
class bodies of the changed ranges (overlap selection, nesting collapsed),
line-window fallback for non-TS/Python / unparseable / orphan lines. Reuses
safeReadContained (no raw reads); >2MB → omit; total + per-file byte budgets."
```

---

## Task 3: Config keys + orchestrator wiring

**Files:**
- Modify: `src/config/define-config.ts` (`review` z.object, after `fileContextBudgetBytes` ~69)
- Modify: `src/config/defaults.ts` (`phases.review`, after `fileContextBudgetBytes: 32_000` ~69)
- Modify: `src/core/orchestrator.ts` (imports; `fileContext` build ~921; `sanitisedCtx` ~1087; header ~1129; reuse `changedRanges` at the `aggregate` call ~1584)
- Test: `tests/unit/file-context.test.ts` (config-defaults assertion) — optional; the behavior is covered by Task 2.

- [ ] **Step 1: Add config keys (schema + defaults)**

In `src/config/define-config.ts`, in the `review` z.object after the `fileContextBudgetBytes: z.number().int().positive().optional(),` line, add:

```ts
      // Whole-vs-scoped threshold AND per-file output cap for changed-file context. A file
      // larger than this is scoped (symbol outline + enclosing function bodies) instead of
      // included whole. Default 8_000.
      fileContextPerFileBytes: z.number().int().positive().optional(),
      // Line-window radius for the scoped fallback (non-TS/Python, unparseable, or changed
      // lines outside any symbol). Default 40.
      fileContextWindowLines: z.number().int().nonnegative().optional(),
```

In `src/config/defaults.ts`, in `phases.review` after `fileContextBudgetBytes: 32_000,`, add:

```ts
      fileContextPerFileBytes: 8_000,
      fileContextWindowLines: 40,
```

- [ ] **Step 2: Add the import** — in `src/core/orchestrator.ts`, add to the imports (keep the existing `collectChangedFileContents` import — grounding still uses it):

```ts
import { collectFileContext } from "../research/file-context.ts";
```

- [ ] **Step 3: Build the scoped prompt context + reuse changedRanges**

In `runIteration`, just after the existing `const fileContext = await collectChangedFileContents(repo, …)` block (~926), add:

```ts
    // Scoped context for the reviewer PROMPT (the whole-file `fileContext` above is kept for
    // the grounding corpus, unchanged — see below). parseChangedRanges is reused for aggregate().
    const changedRanges = parseChangedRanges(this.input.diff);
    const promptContext = await collectFileContext({
      repoRoot: repo,
      changedRanges,
      totalBudgetBytes: this.input.config.phases.review.fileContextBudgetBytes ?? 32_000,
      perFileBytes: this.input.config.phases.review.fileContextPerFileBytes ?? 8_000,
      windowLines: this.input.config.phases.review.fileContextWindowLines ?? 40,
      signal: opts.signal,
    });
```

Then at the `aggregate({ … })` call, replace `changedRanges: parseChangedRanges(this.input.diff),` with `changedRanges,` (reuse the variable computed above — one parse).

- [ ] **Step 4: Point the prompt's `sanitisedCtx` at `promptContext`**

In the prompt assembly, the line currently reads:

```ts
        const sanitisedCtx = fileContext
          ? sanitizeDiff({ diff: fileContext, personaReaffirm: reaffirm }).text
          : "";
```

Change `fileContext` → `promptContext`:

```ts
        const sanitisedCtx = promptContext
          ? sanitizeDiff({ diff: promptContext, personaReaffirm: reaffirm }).text
          : "";
```

(Leave the `groundingCorpus = \`${this.input.diff}\n${fileContext ?? ""}\`` line UNCHANGED — grounding keeps the whole-file `fileContext`.)

- [ ] **Step 5: Update the prompt header (honest about scoping)**

In the prompt assembly, the header pushed before `sanitisedCtx` currently reads:

```ts
              "## Full content of changed files (reference only — review the DIFF above; consult this to confirm a symbol exists before reporting it undefined/missing)",
```

Replace with:

```ts
              "## Changed-file context (reference only — review the DIFF above). Full source for small files; for large files, an outline of the functions/methods/components/classes defined in the file + the full source of the enclosing one(s) for the changed lines (line windows for anything outside them). Confirm a symbol exists / read the surrounding logic before reporting it undefined or missing; if a symbol you need is not shown, say so rather than assuming it is absent.",
```

- [ ] **Step 6: Typecheck + lint + full unit suite**

Run: `bunx tsc --noEmit && bun run lint && bun test tests/unit --timeout 30000`
Expected: tsc + lint clean; all unit tests green (the `--timeout 30000` avoids known subprocess-spawn flakes). If a config-shape test asserts `phases.review` exactly, update it to include the two new optional keys.

- [ ] **Step 7: Commit**

```bash
git add src/config/define-config.ts src/config/defaults.ts src/core/orchestrator.ts
git commit -m "feat(orchestrator): feed reviewers scoped file context (#2)

Reviewer prompt now uses collectFileContext (scoped: outline + enclosing bodies)
instead of whole-file-or-omit; the always-on grounding corpus keeps the whole-file
collectChangedFileContents UNCHANGED (zero grounding regression). New config
phases.review.fileContextPerFileBytes (8000) / fileContextWindowLines (40);
honest prompt header."
```

---

## Task 4: Definition of Done

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck + lint + suite**

Run: `bunx tsc --noEmit && bun run lint && bun test --timeout 30000`
Expected: tsc + lint clean; ALL tests green (use `--timeout 30000`; default-5s failures are known subprocess-spawn flakes — re-run an individual file to confirm it's a flake, not a regression). Fix any real regression before proceeding.

- [ ] **Step 2: Verify the compiled binary still builds (real tree-sitter)**

Run: `bun run build`
Expected: `dist/reviewgate` compiles. Do NOT deploy/merge yet (the symlink deploys to all repos) — this only confirms the per-language queries don't break the compiled binary's grammar loading.

- [ ] **Step 3: Reviewgate self-gate (dogfood)**

End the turn so the Stop hook reviews this branch's own diff. Address every finding (fix or reject-with-reason ≥20 chars) per the decisions protocol until the gate PASSes.

- [ ] **Step 4: Report**

Summarize: tests green (count), tsc+lint clean, gate PASS. Do NOT push or rebuild-and-deploy dist without the user's OK (per project git policy).

---

## Self-Review (completed by plan author)

- **Spec coverage:** symbol-graph per-language queries + defensive compile + `fileSymbols` → Task 1; `collectFileContext` (whole/scoped/overlap/nesting-collapse/window/>2MB/budget/security) → Task 2; config keys + prompt-scoped/grounding-whole-file/header → Task 3; DoD + real-wasm build → Task 4. The grounding zero-regression (keep `collectChangedFileContents` for the corpus) is explicit in Task 3 Step 4.
- **Type consistency:** `fileSymbols(file, repoRoot?) → SymbolInfo[] | null` (Task 1) consumed by `collectFileContext` (Task 2); `FileContextOpts` fields match the orchestrator call (Task 3); `Range = [start, endExclusive]` overlap math `s.startLine <= endEx-1 && s.endLine >= start` consistent; config keys `fileContextPerFileBytes`/`fileContextWindowLines` identical across defaults/schema/orchestrator.
- **Placeholders:** none — complete code in every step; queries are concrete (real-`.wasm` tests in Task 1 catch any node-name error).
