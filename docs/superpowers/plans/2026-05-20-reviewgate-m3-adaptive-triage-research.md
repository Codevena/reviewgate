# Reviewgate M3 — Adaptive Triage + Research Phase Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make Reviewgate *adaptive*: a deterministic + 1-LLM-call Triage phase classifies each diff and picks which phases/reviewers/budget to run; a Research phase builds a `research.md` (diff facts + git history + a tree-sitter 1-hop symbol graph + repo conventions) that every reviewer reads first; and a content-addressed cache short-circuits unchanged diffs without spawning any reviewer.

**Architecture:** Three new pre-review phases run before the M2 panel. (0) Static — already exists implicitly. (1) Triage — deterministic diff facts feed a single cheap LLM call that returns a triage decision (risk class, which reviewers, budget tier, loop cap); doc-only diffs skip review entirely. (2) Research — assembles `research.md` from diff facts, `git log` per file, a tree-sitter symbol graph (1-hop callees via tree-sitter + callers via ripgrep), and cached repo conventions. The symbol graph also upgrades the M1 finding *signature* from line-buckets to real symbol-relative context. A cache keyed on `sha256(diff + config + provider-versions + reviewgate-version + schema)` returns a prior verdict when nothing that affects it changed.

**Tech Stack:** Bun 1.x + TypeScript 5.x (strict) + zod + biome. Symbol graph: `web-tree-sitter` (WASM) + prebuilt grammar wasm (`tree-sitter-typescript`, `tree-sitter-python`, …) + `ripgrep` (`rg`). All reviewer infra from M1/M2 is reused.

**Spec reference:** `docs/superpowers/specs/2026-05-20-reviewgate-design.md` §5.3 (Adaptive Pipeline, Research output, Symbol-graph scope, Cache layer), §5.5 (signature). M2 plan: `docs/superpowers/plans/2026-05-20-reviewgate-m2-multi-reviewer-panel.md`.

**Verified contracts (recon 2026-05-20):**
- `ripgrep` 15.1.0 present at `/opt/homebrew/bin/rg`.
- `web-tree-sitter` 0.26.9 parses in Bun: `await Parser.init(); const L = await Language.load("<grammar>.wasm"); const p = new Parser(); p.setLanguage(L); const tree = p.parse(code); new Query(L, "(function_declaration name:(identifier) @fn)").captures(tree.rootNode)` → extracts function names and `(call_expression function:(identifier) @callee)` → callees. The Query API is `new Query(language, sexpr)` (NOT `language.query(...)`).
- `tree-sitter-typescript` ships `tree-sitter-typescript.wasm` + `tree-sitter-tsx.wasm`. **`bun build --compile` does NOT auto-bundle these wasm files** — see Spike SM3-3 (resolve grammar paths from `node_modules` at runtime, or copy grammars next to the binary and resolve relative to the executable).

**M3 EXCLUDES** (later milestones): Brain + Curator (M4); FP-Ledger learning loop (M5); cassette replay, weekly reports, full `reviewgate stats` (M6); native sandbox isolation (still blocked on `@anthropic-ai/sandbox-runtime` v1 — keep M1/M2 fail-closed + `sandbox.mode:"off"` default). LSP-based whole-project reference resolution is out of scope — M3 ships the ripgrep+tree-sitter 1-hop graph only. If a step would build something on this list, STOP and ask.

---

## Phase 0 — File structure

```
src/
├── research/
│   ├── diff-facts.ts          # CREATE: classify files, sensitivity tags, LOC delta (deterministic)
│   ├── symbol-graph.ts        # CREATE: tree-sitter parse + 1-hop callees/callers + enclosing symbol
│   ├── grammars.ts            # CREATE: language→wasm-path resolution (handles node_modules + compiled binary)
│   ├── conventions.ts         # CREATE: load CLAUDE.md/README/package.json scripts (cached)
│   └── research-writer.ts     # CREATE: assemble research.md from the above + triage decision
├── triage/
│   ├── matrix.ts              # CREATE: deterministic diff-profile → phase/reviewer/budget/cap matrix
│   └── triage-engine.ts       # CREATE: deterministic tags + 1 LLM call → TriageDecision
├── cache/
│   └── cache.ts               # CREATE: cache key + research/symbol/review get/set with invalidation
├── diff/
│   └── signature.ts           # MODIFY: consume real symbol context (replace M1 line-bucket fallback)
├── schemas/
│   ├── triage.ts              # CREATE: TriageDecision + zod
│   └── research.ts            # CREATE: ResearchFacts + zod (the structured side of research.md)
├── core/
│   └── orchestrator.ts        # MODIFY: triage → cache check → research → adaptive panel → cache store
├── config/
│   ├── defaults.ts            # MODIFY: phases.triage, cache{}, research{ languages }
│   └── define-config.ts       # MODIFY: schema for the above
docs/superpowers/spikes/M3/{SM3-1-tree-sitter.md,SM3-2-ripgrep.md,SM3-3-wasm-packaging.md,SUMMARY.md}
tests/unit/{diff-facts,symbol-graph,triage-matrix,triage-engine,cache,signature-symbol,research-writer}.test.ts
tests/fixtures/symgraph/{a.ts,b.ts}    # small TS files for symbol-graph tests
```

**Each `src/` file ≤ 300 lines.** Run bun via `export PATH="$HOME/.bun/bin:$PATH"`. tsconfig has `allowImportingTsExtensions: true`. No Claude attribution in commits. `bun run format` before each commit.

**New deps (Task 1):** `web-tree-sitter`, `tree-sitter-typescript`, `tree-sitter-python` (others optional). Add to package.json.

---

## Pre-flight: Spikes

### Spike SM3-1: tree-sitter symbol extraction in Bun (informs Task 3)
- [ ] **Verify** (already done in recon; reproduce + record):
```bash
cd /tmp && mkdir rg-ts && cd rg-ts && bun init -y && bun add web-tree-sitter tree-sitter-typescript
cat > t.ts <<'TS'
import { Parser, Language, Query } from "web-tree-sitter";
await Parser.init();
const TS = await Language.load("node_modules/tree-sitter-typescript/tree-sitter-typescript.wasm");
const p = new Parser(); p.setLanguage(TS);
const tree = p.parse("export function f(a){return g(a);}\nfunction g(x){return x;}");
console.log(new Query(TS, "(function_declaration name:(identifier) @fn)").captures(tree.rootNode).map(c=>c.node.text));
console.log(new Query(TS, "(call_expression function:(identifier) @c)").captures(tree.rootNode).map(c=>c.node.text));
TS
bun run t.ts
```
Expected: `[ "f", "g" ]` and `[ "g" ]`.
- [ ] **Record** `docs/superpowers/spikes/M3/SM3-1-tree-sitter.md`: confirm the API (`Parser.init`, `Language.load(wasm)`, `new Query(L, sexpr)`, `.captures(node)`), node fields `startPosition.row` / `endPosition.row`, and the queries that find enclosing functions/methods/classes.

### Spike SM3-2: ripgrep availability + fallback (informs Task 3)
- [ ] **Verify** `rg --version` (present: 15.1.0). Test a symbol search: `rg -n --no-heading -w 'compareToken' .`.
- [ ] **Record** SM3-2: confirm `rg -n --no-heading -w <symbol> <dir>` lists `file:line:text` for callers; document the JS fallback (recursive read + indexOf) when `rg` is absent, and that the SandboxManager net/fs rules don't block local `rg`.

### Spike SM3-3: wasm grammar packaging for the compiled binary (informs Task 2 + build)
- [ ] **Build a probe**: `bun build` a tiny entry that imports web-tree-sitter and loads a grammar; run the compiled binary from a DIFFERENT cwd and confirm whether the `.wasm` resolves.
- [ ] **Record** SM3-3 with the chosen strategy: most likely **copy the grammar wasm + web-tree-sitter's runtime wasm into `dist/grammars/` during build and resolve paths relative to the executable** (`process.execPath`), with a `node_modules` fallback for `bun run dev`. The `grammars.ts` resolver (Task 2) implements whatever this spike concludes. If packaging proves hard, M3 ships symbol-graph as **dev/runtime-only** (works under `bun run`, gracefully degrades to "no symbol graph" in the compiled binary) — degrade, never crash.

**After spikes:** write `docs/superpowers/spikes/M3/SUMMARY.md`, commit before Task 1.

---

## Phase 1 — Diff facts (deterministic, no LLM)

### Task 1: deps + diff-facts module

**Files:** `package.json` (add deps), `src/research/diff-facts.ts`, `tests/unit/diff-facts.test.ts`

- [ ] **Step 1: Add deps**
```bash
export PATH="$HOME/.bun/bin:$PATH" && bun add web-tree-sitter tree-sitter-typescript tree-sitter-python
```

- [ ] **Step 2: Write the failing test**
```ts
// tests/unit/diff-facts.test.ts
import { describe, expect, it } from "bun:test";
import { computeDiffFacts } from "../../src/research/diff-facts.ts";

const DIFF = `diff --git a/src/auth/token.ts b/src/auth/token.ts
--- a/src/auth/token.ts
+++ b/src/auth/token.ts
@@ -1,2 +1,2 @@
-export const x = 1;
+export const x = 2;
+export const y = 3;
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-# hi
+# hello
`;

describe("computeDiffFacts", () => {
  it("lists changed files with per-file added/removed counts", () => {
    const f = computeDiffFacts(DIFF);
    const ts = f.files.find((x) => x.path === "src/auth/token.ts");
    expect(ts?.added).toBe(2);
    expect(ts?.removed).toBe(1);
  });
  it("classifies file kinds (code / docs)", () => {
    const f = computeDiffFacts(DIFF);
    expect(f.files.find((x) => x.path === "README.md")?.kind).toBe("docs");
    expect(f.files.find((x) => x.path === "src/auth/token.ts")?.kind).toBe("code");
  });
  it("tags sensitive paths (auth/)", () => {
    const f = computeDiffFacts(DIFF);
    expect(f.sensitivityTags).toContain("auth");
  });
  it("flags doc-only diffs", () => {
    const docOnly = computeDiffFacts(`diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-a
+b
`);
    expect(docOnly.docOnly).toBe(true);
  });
});
```

- [ ] **Step 3: Implement** `src/research/diff-facts.ts`:
```ts
// src/research/diff-facts.ts
export type FileKind = "code" | "docs" | "tests" | "config" | "lockfile" | "other";

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
  kind: FileKind;
}

export interface DiffFacts {
  files: DiffFile[];
  totalAdded: number;
  totalRemoved: number;
  sensitivityTags: string[]; // e.g. "auth","crypto","sql","migrations","payment","env"
  docOnly: boolean;
  testsOnly: boolean;
}

const SENSITIVE: Array<[RegExp, string]> = [
  [/(^|\/)auth\//, "auth"],
  [/(^|\/)crypto\//, "crypto"],
  [/\.sql$/, "sql"],
  [/(^|\/)migrations?\//, "migrations"],
  [/(^|\/)payment/, "payment"],
  [/\.env(\.|$)/, "env"],
];

function classify(path: string): FileKind {
  if (/(^|\/)(package-lock\.json|pnpm-lock\.yaml|bun\.lock[b]?|yarn\.lock)$/.test(path)) return "lockfile";
  if (/\.(md|mdx|txt|rst)$|(^|\/)LICENSE$/.test(path)) return "docs";
  if (/\.(test|spec)\.[a-z]+$|(^|\/)tests?\//.test(path)) return "tests";
  if (/\.(json|ya?ml|toml|ini|config\.[a-z]+)$/.test(path)) return "config";
  if (/\.(ts|tsx|js|jsx|py|go|rs|java|kt|c|cc|cpp|h|hpp|rb|php|cs)$/.test(path)) return "code";
  return "other";
}

export function computeDiffFacts(diff: string): DiffFacts {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  for (const line of diff.split("\n")) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) {
      current = { path: m[2] ?? m[1] ?? "", added: 0, removed: 0, kind: classify(m[2] ?? m[1] ?? "") };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+") && !line.startsWith("+++")) current.added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) current.removed += 1;
  }
  const tags = new Set<string>();
  for (const f of files) for (const [re, tag] of SENSITIVE) if (re.test(f.path)) tags.add(tag);
  const totalAdded = files.reduce((s, f) => s + f.added, 0);
  const totalRemoved = files.reduce((s, f) => s + f.removed, 0);
  const nonDoc = files.filter((f) => f.kind !== "docs");
  const nonTest = files.filter((f) => f.kind !== "tests");
  return {
    files,
    totalAdded,
    totalRemoved,
    sensitivityTags: [...tags],
    docOnly: files.length > 0 && nonDoc.length === 0,
    testsOnly: files.length > 0 && nonTest.length === 0,
  };
}
```

- [ ] **Step 4: Pass + typecheck + format + lint + commit**
```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/diff-facts.test.ts && bun run typecheck && bun run format && bun run lint
git add package.json bun.lock src/research/diff-facts.ts tests/unit/diff-facts.test.ts
git commit -m "feat(research): deterministic diff facts (file kinds, sensitivity tags, doc/test-only)"
```

---

## Phase 2 — Symbol graph (tree-sitter + ripgrep)

### Task 2: grammar resolver + symbol graph

**Files:** `src/research/grammars.ts`, `src/research/symbol-graph.ts`, `tests/fixtures/symgraph/{a.ts,b.ts}`, `tests/unit/symbol-graph.test.ts`

- [ ] **Step 1: Create fixtures**
```bash
mkdir -p tests/fixtures/symgraph
printf 'export function alpha(x: number): number {\n  return beta(x) + 1;\n}\n' > tests/fixtures/symgraph/a.ts
printf 'import { alpha } from "./a";\nexport function beta(y: number): number {\n  return y * 2;\n}\nexport function gamma(): number {\n  return alpha(3);\n}\n' > tests/fixtures/symgraph/b.ts
```

- [ ] **Step 2: Write the failing test**
```ts
// tests/unit/symbol-graph.test.ts
import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { buildSymbolGraph, enclosingSymbol } from "../../src/research/symbol-graph.ts";

const DIR = join(process.cwd(), "tests/fixtures/symgraph");

describe("symbol-graph", () => {
  it("finds the enclosing symbol for a line in a TS file", async () => {
    const sym = await enclosingSymbol(join(DIR, "a.ts"), 2); // line 2 is inside alpha()
    expect(sym?.name).toBe("alpha");
    expect(sym?.startLine).toBe(1);
  });

  it("lists 1-hop callees (tree-sitter) and callers (ripgrep)", async () => {
    const g = await buildSymbolGraph({ files: [join(DIR, "a.ts")], repoRoot: DIR });
    const alpha = g.symbols.find((s) => s.name === "alpha");
    expect(alpha?.callees).toContain("beta"); // alpha calls beta
    // gamma() in b.ts calls alpha → alpha has a caller reference in b.ts
    expect(g.callers.alpha?.some((ref) => ref.file.endsWith("b.ts"))).toBe(true);
  });

  it("degrades gracefully for unsupported languages (no throw, empty graph)", async () => {
    const g = await buildSymbolGraph({ files: [join(DIR, "..", "repo-with-bug", "foo.ts")], repoRoot: DIR }).catch(() => null);
    expect(g === null || Array.isArray(g.symbols)).toBe(true);
  });
});
```

- [ ] **Step 3: Implement `src/research/grammars.ts`** (per SM3-3 strategy):
```ts
// src/research/grammars.ts
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

// Maps a file extension to its tree-sitter grammar wasm + support tier.
// Tier mirrors spec §5.3: full (TS/JS/PY), basic (GO/RS), none (skip).
export interface GrammarInfo {
  lang: string;
  wasmFile: string; // basename, resolved against candidate dirs
  tier: "full" | "basic";
}

const EXT_GRAMMAR: Record<string, GrammarInfo> = {
  ".ts": { lang: "typescript", wasmFile: "tree-sitter-typescript.wasm", tier: "full" },
  ".tsx": { lang: "tsx", wasmFile: "tree-sitter-tsx.wasm", tier: "full" },
  ".js": { lang: "typescript", wasmFile: "tree-sitter-typescript.wasm", tier: "full" },
  ".jsx": { lang: "tsx", wasmFile: "tree-sitter-tsx.wasm", tier: "full" },
  ".py": { lang: "python", wasmFile: "tree-sitter-python.wasm", tier: "full" },
};

// Resolve a grammar wasm path across: node_modules (bun run dev), and a
// dist/grammars dir next to the compiled binary (bun build --compile).
export function resolveGrammarWasm(wasmFile: string): string | null {
  const candidates = [
    join(process.cwd(), "node_modules/tree-sitter-typescript", wasmFile),
    join(process.cwd(), "node_modules/tree-sitter-python", wasmFile),
    join(dirname(process.execPath), "grammars", wasmFile),
    join(process.cwd(), "dist/grammars", wasmFile),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export function grammarForFile(path: string): GrammarInfo | null {
  const ext = path.slice(path.lastIndexOf("."));
  return EXT_GRAMMAR[ext] ?? null;
}
```

- [ ] **Step 4: Implement `src/research/symbol-graph.ts`** (tree-sitter callees + ripgrep callers; degrade to empty on any failure):
```ts
// src/research/symbol-graph.ts
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Language, Parser, Query } from "web-tree-sitter";
import { grammarForFile, resolveGrammarWasm } from "./grammars.ts";

export interface SymbolInfo {
  name: string;
  startLine: number; // 1-based
  endLine: number;
  callees: string[];
}
export interface CallerRef {
  file: string;
  line: number;
}
export interface SymbolGraph {
  symbols: SymbolInfo[];
  callers: Record<string, CallerRef[]>;
}

let parserReady: Promise<void> | null = null;
const langCache = new Map<string, Awaited<ReturnType<typeof Language.load>>>();

async function getLanguage(wasmFile: string): Promise<Awaited<ReturnType<typeof Language.load>> | null> {
  const path = resolveGrammarWasm(wasmFile);
  if (!path) return null;
  if (langCache.has(wasmFile)) return langCache.get(wasmFile) ?? null;
  if (!parserReady) parserReady = Parser.init();
  await parserReady;
  const lang = await Language.load(path);
  langCache.set(wasmFile, lang);
  return lang;
}

const FN_QUERY =
  "[(function_declaration name:(identifier) @n) (method_definition name:(property_identifier) @n) (function_signature name:(identifier) @n)] @sym";
const CALL_QUERY = "(call_expression function: [(identifier) @c (member_expression property:(property_identifier) @c)])";

async function parseFile(file: string): Promise<{ symbols: SymbolInfo[] } | null> {
  const g = grammarForFile(file);
  if (!g) return null;
  const lang = await getLanguage(g.wasmFile);
  if (!lang) return null;
  let code: string;
  try {
    code = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const p = new Parser();
  p.setLanguage(lang);
  const tree = p.parse(code);
  if (!tree) return null;
  const symbols: SymbolInfo[] = [];
  const symQ = new Query(lang, FN_QUERY);
  for (const match of symQ.matches(tree.rootNode)) {
    const symNode = match.captures.find((c) => c.name === "sym")?.node;
    const nameNode = match.captures.find((c) => c.name === "n")?.node;
    if (!symNode || !nameNode) continue;
    const callQ = new Query(lang, CALL_QUERY);
    const callees = [...new Set(callQ.captures(symNode).map((c) => c.node.text))];
    symbols.push({
      name: nameNode.text,
      startLine: symNode.startPosition.row + 1,
      endLine: symNode.endPosition.row + 1,
      callees,
    });
  }
  return { symbols };
}

// The symbol that encloses a 1-based line in a file (for symbol-relative signatures).
export async function enclosingSymbol(file: string, line: number): Promise<{ name: string; startLine: number } | null> {
  const parsed = await parseFile(file);
  if (!parsed) return null;
  const hit = parsed.symbols.find((s) => line >= s.startLine && line <= s.endLine);
  return hit ? { name: hit.name, startLine: hit.startLine } : null;
}

function ripgrepCallers(symbol: string, repoRoot: string): CallerRef[] {
  const r = spawnSync("rg", ["-n", "--no-heading", "-w", symbol, repoRoot], { encoding: "utf8" });
  if (r.status !== 0 || !r.stdout) return [];
  const refs: CallerRef[] = [];
  for (const ln of r.stdout.split("\n")) {
    const m = ln.match(/^(.+?):(\d+):/);
    if (m?.[1] && m[2]) refs.push({ file: m[1], line: Number(m[2]) });
  }
  return refs;
}

export async function buildSymbolGraph(input: { files: string[]; repoRoot: string }): Promise<SymbolGraph> {
  const symbols: SymbolInfo[] = [];
  for (const f of input.files) {
    const parsed = await parseFile(f).catch(() => null);
    if (parsed) symbols.push(...parsed.symbols);
  }
  const callers: Record<string, CallerRef[]> = {};
  for (const s of symbols) {
    const refs = ripgrepCallers(s.name, input.repoRoot).filter((r) => r.file.endsWith(".ts") || r.file.endsWith(".tsx") || r.file.endsWith(".js") || r.file.endsWith(".py"));
    if (refs.length) callers[s.name] = refs;
  }
  return { symbols, callers };
}
```

- [ ] **Step 5: Pass + typecheck + format + lint + commit**
```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/symbol-graph.test.ts && bun run typecheck && bun run format && bun run lint
git add src/research/grammars.ts src/research/symbol-graph.ts tests/fixtures/symgraph tests/unit/symbol-graph.test.ts
git commit -m "feat(research): tree-sitter symbol graph (1-hop callees + ripgrep callers) with graceful degradation"
```

---

## Phase 3 — Symbol-relative signatures

### Task 3: upgrade `computeSignature` to use real symbol context

**Files:** `src/diff/signature.ts` (MODIFY), `tests/unit/signature-symbol.test.ts`

M1's `computeSignature` already accepts optional `symbolName` + `symbolStartLine` and uses them when present (offset within symbol), falling back to 10-line buckets otherwise. M3 wires the real symbol context in; the function itself needs only a small refinement to bucket the symbol-relative offset to 5-line groups (per spec §5.5) so minor edits inside a function don't churn the signature.

- [ ] **Step 1: Write the failing test**
```ts
// tests/unit/signature-symbol.test.ts
import { describe, expect, it } from "bun:test";
import { computeSignature } from "../../src/diff/signature.ts";

describe("computeSignature with symbol context", () => {
  it("is stable when a line moves but stays the same offset-bucket within its symbol", () => {
    const a = computeSignature({ file: "a.ts", ruleId: "r", category: "security", lineStart: 12, lineEnd: 12, symbolName: "foo", symbolStartLine: 10 });
    const b = computeSignature({ file: "a.ts", ruleId: "r", category: "security", lineStart: 14, lineEnd: 14, symbolName: "foo", symbolStartLine: 10 });
    expect(a).toBe(b); // offsets 2 and 4 → same 5-line bucket
  });
  it("differs across symbols even at the same absolute line", () => {
    const a = computeSignature({ file: "a.ts", ruleId: "r", category: "security", lineStart: 12, lineEnd: 12, symbolName: "foo", symbolStartLine: 10 });
    const b = computeSignature({ file: "a.ts", ruleId: "r", category: "security", lineStart: 12, lineEnd: 12, symbolName: "bar", symbolStartLine: 10 });
    expect(a).not.toBe(b);
  });
  it("falls back to line buckets when no symbol context (unchanged M1 behavior)", () => {
    const a = computeSignature({ file: "a.ts", ruleId: "r", category: "security", lineStart: 41, lineEnd: 41 });
    const b = computeSignature({ file: "a.ts", ruleId: "r", category: "security", lineStart: 49, lineEnd: 49 });
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run, expect fail** (the symbol-offset bucketing isn't 5-line yet)
```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/signature-symbol.test.ts
```

- [ ] **Step 3: Modify `computeSignature`** so the symbol-relative offset is bucketed to 5-line groups:
```ts
// in src/diff/signature.ts, replace the offset computation:
  const symbolName = input.symbolName ?? "";
  let bucketedOffset: number;
  if (input.symbolName && input.symbolStartLine !== undefined) {
    const offset = Math.max(0, input.lineStart - input.symbolStartLine);
    bucketedOffset = Math.floor(offset / 5) * 5; // 5-line buckets within the symbol (spec §5.5)
  } else {
    bucketedOffset = lineBucket(input.lineStart, 10); // M1 fallback: 10-line absolute buckets
  }
```
(Keep the existing `parts`/sha256 assembly and the `normalizeRuleId`/`lineBucket` helpers.)

- [ ] **Step 4: Pass (new + existing signature.test.ts) + typecheck + format + lint + commit**
```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/signature.test.ts tests/unit/signature-symbol.test.ts && bun run typecheck && bun run format && bun run lint
git add src/diff/signature.ts tests/unit/signature-symbol.test.ts
git commit -m "feat(diff): symbol-relative signature offset (5-line buckets) when symbol context is known"
```

---

## Phase 4 — Triage

### Task 4: triage matrix (deterministic) + schema

**Files:** `src/schemas/triage.ts`, `src/triage/matrix.ts`, `tests/unit/triage-matrix.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// tests/unit/triage-matrix.test.ts
import { describe, expect, it } from "bun:test";
import { triageFromFacts } from "../../src/triage/matrix.ts";
import { computeDiffFacts } from "../../src/research/diff-facts.ts";

function facts(diff: string) { return computeDiffFacts(diff); }

describe("triageFromFacts (deterministic)", () => {
  it("doc-only → skip review", () => {
    const d = triageFromFacts(facts(`diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n`));
    expect(d.runReview).toBe(false);
    expect(d.riskClass).toBe("trivial");
  });
  it("sensitive path (auth) → expanded budget, higher loop cap", () => {
    const d = triageFromFacts(facts(`diff --git a/src/auth/x.ts b/src/auth/x.ts\n--- a/src/auth/x.ts\n+++ b/src/auth/x.ts\n@@ -1 +1 @@\n-a\n+b\n`));
    expect(d.riskClass).toBe("sensitive");
    expect(d.budgetTier).toBe("expanded");
    expect(d.loopCap).toBeGreaterThanOrEqual(5);
  });
  it("default code change → standard", () => {
    const d = triageFromFacts(facts(`diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n`));
    expect(d.riskClass).toBe("default");
    expect(d.runReview).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect fail**
```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/triage-matrix.test.ts
```

- [ ] **Step 3: Implement schema `src/schemas/triage.ts`**:
```ts
// src/schemas/triage.ts
import { z } from "zod";

export const RiskClass = z.enum(["trivial", "minimal", "standard", "sensitive"]);
export type RiskClass = z.infer<typeof RiskClass>;

export const TriageDecisionSchema = z.object({
  schema: z.literal("reviewgate.triage.v1"),
  riskClass: RiskClass,
  runReview: z.boolean(),
  budgetTier: z.enum(["trivial", "minimal", "standard", "expanded"]),
  loopCap: z.number().int().positive(),
  reviewerHint: z.array(z.string()), // provider ids the matrix suggests (orchestrator intersects with enabled)
  justification: z.string(),
});
export type TriageDecision = z.infer<typeof TriageDecisionSchema>;
```

- [ ] **Step 4: Implement `src/triage/matrix.ts`** (deterministic; the LLM call is Task 5 and may only NARROW, never widen budget — spec §5.3):
```ts
// src/triage/matrix.ts
import type { DiffFacts } from "../research/diff-facts.ts";
import type { TriageDecision } from "../schemas/triage.ts";

export function triageFromFacts(facts: DiffFacts): TriageDecision {
  const base = { schema: "reviewgate.triage.v1" as const };
  if (facts.docOnly) {
    return { ...base, riskClass: "trivial", runReview: false, budgetTier: "trivial", loopCap: 1, reviewerHint: [], justification: "Doc-only diff; review skipped." };
  }
  if (facts.sensitivityTags.length > 0) {
    return { ...base, riskClass: "sensitive", runReview: true, budgetTier: "expanded", loopCap: 5, reviewerHint: ["codex", "gemini", "claude-code", "openrouter"], justification: `Sensitive paths: ${facts.sensitivityTags.join(", ")}.` };
  }
  if (facts.testsOnly) {
    return { ...base, riskClass: "minimal", runReview: true, budgetTier: "minimal", loopCap: 2, reviewerHint: ["codex"], justification: "Tests-only diff." };
  }
  return { ...base, riskClass: "default", runReview: true, budgetTier: "standard", loopCap: 3, reviewerHint: ["codex", "gemini", "claude-code"], justification: "Default code change." };
}
```

- [ ] **Step 5: Pass + typecheck + format + lint + commit**
```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/triage-matrix.test.ts && bun run typecheck && bun run format && bun run lint
git add src/schemas/triage.ts src/triage/matrix.ts tests/unit/triage-matrix.test.ts
git commit -m "feat(triage): deterministic diff-profile → risk/budget/loop matrix"
```

### Task 5: triage engine (deterministic + 1 LLM call, anti-sycophancy)

**Files:** `src/triage/triage-engine.ts`, `tests/unit/triage-engine.test.ts`

The engine starts from `triageFromFacts`, then (optionally) asks ONE cheap LLM to refine `riskClass`/`justification` — but it can only KEEP or NARROW the deterministic budget, never widen it (only deterministic sensitivity tags grant `expanded`). The triage provider obeys the anti-sycophancy downgrade table just like reviewers. If no triage provider is configured or the LLM errors, the deterministic decision stands (fail-safe).

- [ ] **Step 1: Write the failing test** (LLM injected as a stub returning a refinement; verify it can't widen budget)
```ts
// tests/unit/triage-engine.test.ts
import { describe, expect, it } from "bun:test";
import { refineTriage } from "../../src/triage/triage-engine.ts";
import { triageFromFacts } from "../../src/triage/matrix.ts";
import { computeDiffFacts } from "../../src/research/diff-facts.ts";

const det = triageFromFacts(computeDiffFacts(`diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n`));

describe("refineTriage", () => {
  it("keeps the deterministic decision when the LLM call is absent", async () => {
    const d = await refineTriage(det, { llm: null });
    expect(d).toEqual(det);
  });
  it("lets the LLM lower risk but NEVER widen budget beyond deterministic", async () => {
    const d = await refineTriage(det, { llm: async () => ({ riskClass: "sensitive", budgetTier: "expanded", justification: "llm tried to widen" }) });
    expect(d.budgetTier).toBe("standard"); // capped at the deterministic tier
  });
  it("falls back to the deterministic decision if the LLM throws", async () => {
    const d = await refineTriage(det, { llm: async () => { throw new Error("boom"); } });
    expect(d).toEqual(det);
  });
});
```

- [ ] **Step 2: Run, expect fail**
```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/triage-engine.test.ts
```

- [ ] **Step 3: Implement `src/triage/triage-engine.ts`**:
```ts
// src/triage/triage-engine.ts
import type { TriageDecision } from "../schemas/triage.ts";

const TIER_RANK: Record<TriageDecision["budgetTier"], number> = { trivial: 0, minimal: 1, standard: 2, expanded: 3 };

export type TriageLlm = (() => Promise<{ riskClass?: string; budgetTier?: string; justification?: string }>) | null;

// Refine a deterministic triage decision with one optional LLM call. The LLM may
// only KEEP or NARROW the budget tier — never widen it past what the
// deterministic matrix granted (only deterministic sensitivity tags grant
// 'expanded'). Any error keeps the deterministic decision (fail-safe).
export async function refineTriage(det: TriageDecision, opts: { llm: TriageLlm }): Promise<TriageDecision> {
  if (!opts.llm) return det;
  let out: { riskClass?: string; budgetTier?: string; justification?: string };
  try {
    out = await opts.llm();
  } catch {
    return det;
  }
  const detRank = TIER_RANK[det.budgetTier];
  const llmTier = out.budgetTier && out.budgetTier in TIER_RANK ? (out.budgetTier as TriageDecision["budgetTier"]) : det.budgetTier;
  const cappedTier = TIER_RANK[llmTier] <= detRank ? llmTier : det.budgetTier;
  return {
    ...det,
    budgetTier: cappedTier,
    ...(out.justification ? { justification: `${det.justification} | LLM: ${out.justification.slice(0, 200)}` } : {}),
  };
}
```

- [ ] **Step 4: Pass + typecheck + format + lint + commit**
```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/triage-engine.test.ts && bun run typecheck && bun run format && bun run lint
git add src/triage/triage-engine.ts tests/unit/triage-engine.test.ts
git commit -m "feat(triage): LLM refinement that can only narrow budget (fail-safe to deterministic)"
```

---

## Phase 5 — research.md + conventions

### Task 6: conventions loader + research writer

**Files:** `src/research/conventions.ts`, `src/research/research-writer.ts`, `src/schemas/research.ts`, `tests/unit/research-writer.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// tests/unit/research-writer.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeResearch } from "../../src/research/research-writer.ts";
import { computeDiffFacts } from "../../src/research/diff-facts.ts";
import { triageFromFacts } from "../../src/triage/matrix.ts";

describe("writeResearch", () => {
  it("writes research.md with diff facts, triage, and a symbol section", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-research-"));
    mkdirSync(join(repo, ".reviewgate"), { recursive: true });
    const diff = `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n`;
    const facts = computeDiffFacts(diff);
    await writeResearch({ repoRoot: repo, facts, triage: triageFromFacts(facts), symbolGraph: { symbols: [], callers: {} }, conventions: { summary: "Uses biome + zod." } });
    const md = readFileSync(join(repo, ".reviewgate", "research.md"), "utf8");
    expect(md).toContain("# Reviewgate Research");
    expect(md).toContain("src/x.ts");
    expect(md).toContain("default"); // risk class
    expect(md).toContain("biome");
  });
});
```

- [ ] **Step 2: Run, expect fail**
```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/research-writer.test.ts
```

- [ ] **Step 3: Implement `src/research/conventions.ts`** (best-effort, cached read of CLAUDE.md/README/package.json scripts):
```ts
// src/research/conventions.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Conventions { summary: string }

export function loadConventions(repoRoot: string): Conventions {
  const parts: string[] = [];
  for (const f of ["CLAUDE.md", "README.md"]) {
    const p = join(repoRoot, f);
    if (existsSync(p)) parts.push(`${f}: ${readFileSync(p, "utf8").slice(0, 600).replace(/\n+/g, " ")}`);
  }
  const pkg = join(repoRoot, "package.json");
  if (existsSync(pkg)) {
    try {
      const j = JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> };
      if (j.scripts) parts.push(`scripts: ${Object.keys(j.scripts).join(", ")}`);
    } catch {
      // ignore
    }
  }
  return { summary: parts.join(" | ").slice(0, 1500) || "No project conventions found." };
}
```

- [ ] **Step 4: Implement `src/schemas/research.ts`** (the structured facts; small) and **`src/research/research-writer.ts`**:
```ts
// src/schemas/research.ts
import { z } from "zod";
export const ResearchFactsSchema = z.object({
  schema: z.literal("reviewgate.research.v1"),
  files: z.array(z.object({ path: z.string(), added: z.number(), removed: z.number(), kind: z.string() })),
  sensitivityTags: z.array(z.string()),
});
export type ResearchFacts = z.infer<typeof ResearchFactsSchema>;
```
```ts
// src/research/research-writer.ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DiffFacts } from "./diff-facts.ts";
import type { SymbolGraph } from "./symbol-graph.ts";
import type { Conventions } from "./conventions.ts";
import type { TriageDecision } from "../schemas/triage.ts";

export interface ResearchInput {
  repoRoot: string;
  facts: DiffFacts;
  triage: TriageDecision;
  symbolGraph: SymbolGraph;
  conventions: Conventions;
}

export function researchPath(repoRoot: string): string {
  return join(repoRoot, ".reviewgate", "research.md");
}

export async function writeResearch(input: ResearchInput): Promise<string> {
  const lines: string[] = [
    "# Reviewgate Research",
    "",
    `**Risk class:** ${input.triage.riskClass}  ·  **Budget:** ${input.triage.budgetTier}  ·  **Loop cap:** ${input.triage.loopCap}`,
    `**Triage:** ${input.triage.justification}`,
    "",
    "## Changed files",
    ...input.facts.files.map((f) => `- ${f.path} (${f.kind}, +${f.added}/-${f.removed})`),
    "",
    `**Sensitivity tags:** ${input.facts.sensitivityTags.join(", ") || "none"}`,
    "",
    "## Symbol graph (1-hop)",
    ...(input.symbolGraph.symbols.length
      ? input.symbolGraph.symbols.map(
          (s) => `- ${s.name} (L${s.startLine}-${s.endLine}) calls: ${s.callees.join(", ") || "—"}; callers: ${(input.symbolGraph.callers[s.name] ?? []).map((c) => `${c.file}:${c.line}`).slice(0, 5).join(", ") || "—"}`,
        )
      : ["_No symbol graph (unsupported language or grammar unavailable)._"]),
    "",
    "## Project conventions",
    input.conventions.summary,
    "",
  ];
  const p = researchPath(input.repoRoot);
  if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, lines.join("\n"), { mode: 0o600 });
  return p;
}
```

- [ ] **Step 5: Pass + typecheck + format + lint + commit**
```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/research-writer.test.ts && bun run typecheck && bun run format && bun run lint
git add src/research/conventions.ts src/research/research-writer.ts src/schemas/research.ts tests/unit/research-writer.test.ts
git commit -m "feat(research): conventions loader + research.md writer"
```

---

## Phase 6 — Cache

### Task 7: content-addressed cache

**Files:** `src/cache/cache.ts`, `tests/unit/cache.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// tests/unit/cache.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeCacheKey, getCachedReview, putCachedReview } from "../../src/cache/cache.ts";

describe("cache", () => {
  it("computeCacheKey changes when any input changes", () => {
    const base = { diff: "d", configHash: "c", providerVersions: "p", reviewgateVersion: "0.1", schemaVersion: "v1" };
    const k1 = computeCacheKey(base);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(computeCacheKey({ ...base, diff: "d2" })).not.toBe(k1);
    expect(computeCacheKey({ ...base, configHash: "c2" })).not.toBe(k1);
    expect(computeCacheKey({ ...base, providerVersions: "p2" })).not.toBe(k1);
  });
  it("round-trips a cached review verdict", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-cache-"));
    const key = computeCacheKey({ diff: "d", configHash: "c", providerVersions: "p", reviewgateVersion: "0.1", schemaVersion: "v1" });
    expect(await getCachedReview(repo, key)).toBeNull();
    await putCachedReview(repo, key, { verdict: "PASS", counts: { critical: 0, warn: 0, info: 0 } });
    const got = await getCachedReview(repo, key);
    expect(got?.verdict).toBe("PASS");
  });
});
```

- [ ] **Step 2: Run, expect fail**
```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/cache.test.ts
```

- [ ] **Step 3: Implement `src/cache/cache.ts`**:
```ts
// src/cache/cache.ts
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface CacheKeyInput {
  diff: string;
  configHash: string;
  providerVersions: string;
  reviewgateVersion: string;
  schemaVersion: string;
}

export function computeCacheKey(input: CacheKeyInput): string {
  return createHash("sha256")
    .update([input.diff, input.configHash, input.providerVersions, input.reviewgateVersion, input.schemaVersion].join("|"))
    .digest("hex");
}

export interface CachedReview {
  verdict: "PASS" | "SOFT-PASS" | "FAIL";
  counts: { critical: number; warn: number; info: number };
}

function reviewCachePath(repoRoot: string, key: string): string {
  return join(repoRoot, ".reviewgate", "cache", "reviews", `${key}.json`);
}

const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function getCachedReview(repoRoot: string, key: string): Promise<CachedReview | null> {
  const p = reviewCachePath(repoRoot, key);
  if (!existsSync(p)) return null;
  try {
    const o = JSON.parse(readFileSync(p, "utf8")) as { ts: number; review: CachedReview };
    if (Date.now() - o.ts > TTL_MS) return null;
    return o.review;
  } catch {
    return null;
  }
}

export async function putCachedReview(repoRoot: string, key: string, review: CachedReview): Promise<void> {
  const p = reviewCachePath(repoRoot, key);
  mkdirSync(join(repoRoot, ".reviewgate", "cache", "reviews"), { recursive: true });
  writeFileSync(p, JSON.stringify({ ts: Date.now(), review }), { mode: 0o600 });
}
```

- [ ] **Step 4: Pass + typecheck + format + lint + commit**
```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/cache.test.ts && bun run typecheck && bun run format && bun run lint
git add src/cache/cache.ts tests/unit/cache.test.ts
git commit -m "feat(cache): content-addressed review cache (sha256 key + 7d TTL)"
```

Note: `.reviewgate/cache/` is already gitignored (M1 `init`).

---

## Phase 7 — Orchestrator integration

### Task 8: wire triage → cache → research → adaptive panel

**Files:** `src/core/orchestrator.ts` (MODIFY), `src/config/defaults.ts` + `define-config.ts` (MODIFY: `phases.triage`, `cache`, `research.languages`), `tests/unit/orchestrator-triage.test.ts`

The orchestrator's `runIteration` gains a prelude (after the sandbox guard):
1. `facts = computeDiffFacts(diff)`; `triage = refineTriage(triageFromFacts(facts), {llm})`.
2. If `!triage.runReview` → write a PASS report ("triage: review skipped — <justification>"), return PASS (allow_stop). Doc-only diffs cost $0.
3. Compute cache key; if a cached review exists → write its verdict to the report, return it (no reviewers spawned).
4. Build the symbol graph for changed files; write `research.md`.
5. Run the panel (existing M2 code), but the per-reviewer prompt now PREPENDS the research.md content so reviewers see facts + symbol graph + conventions. The reviewer set is the configured reviewers INTERSECTED with `triage.reviewerHint` when the hint is non-empty (deterministic narrowing only).
6. After aggregation, store the verdict in the cache.
7. Findings get symbol-relative signatures: when computing a finding's signature, look up `enclosingSymbol(file, line)` from the graph and pass `symbolName`/`symbolStartLine` (the mapping in `review-output.ts` gains an optional resolver — see Step 3).

- [ ] **Step 1: Write the failing test** (stub adapters; assert triage skip + research.md written + cache hit on 2nd run)
```ts
// tests/unit/orchestrator-triage.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";

function stub(id: ProviderAdapter["id"]): ProviderAdapter {
  return {
    id,
    async preflight() { return { available: true, version: "x", authMode: "oauth", error: null }; },
    async review(inp) {
      return { reviewerId: inp.reviewerId, verdict: "PASS", findings: [], usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null }, durationMs: 1, exitCode: 0, rawEventsPath: "", status: "ok" } satisfies ReviewResult;
    },
  };
}

describe("Orchestrator triage/research", () => {
  it("skips review for a doc-only diff (PASS, no reviewers)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-tri-"));
    writeFileSync(join(repo, "README.md"), "x");
    const orch = new Orchestrator({
      repoRoot: repo, config: defaultConfig, adapters: { codex: stub("codex") },
      sandboxMode: "off", hostTier: "opus",
      diff: `diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-a\n+b\n`,
      reasonOnFailEnabled: true,
    });
    const r = await orch.runIteration({ runId: "RUN", iter: 1 });
    expect(r.verdict).toBe("PASS");
  });

  it("writes research.md for a code diff", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-tri2-"));
    writeFileSync(join(repo, "x.ts"), "export function f(){return 1;}");
    const orch = new Orchestrator({
      repoRoot: repo, config: defaultConfig, adapters: { codex: stub("codex") },
      sandboxMode: "off", hostTier: "opus",
      diff: `diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-a\n+b\n`,
      reasonOnFailEnabled: true,
    });
    await orch.runIteration({ runId: "RUN", iter: 1 });
    expect(existsSync(join(repo, ".reviewgate", "research.md"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run, expect fail**
```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit/orchestrator-triage.test.ts
```

- [ ] **Step 3: Implement the orchestrator prelude.** In `runIteration`, after the sandbox guard and before building reviewer tasks:
  - `const facts = computeDiffFacts(this.input.diff);`
  - `const triage = await refineTriage(triageFromFacts(facts), { llm: null });` (M3 wires the real triage LLM only if `config.phases.triage` is set and a triage adapter is supplied; default `llm: null` keeps deterministic. Build the triage LLM closure analogously to a reviewer call, applying the host-tier downgrade — reuse the panel's adapter map.)
  - If `!triage.runReview`: `await this.writeReport(opts, start, [], [], "PASS"); return { verdict: "PASS", costUsd: 0, durationMs: Date.now()-start, signaturesThisIter: [] };`
  - Build the symbol graph: `const graph = await buildSymbolGraph({ files: facts.files.map(f=>join(repoRoot,f.path)), repoRoot }).catch(() => ({ symbols: [], callers: {} }));`
  - `await writeResearch({ repoRoot, facts, triage, symbolGraph: graph, conventions: loadConventions(repoRoot) });`
  - Prepend `research.md` content to each reviewer prompt (read the file, put it before the diff block — keep it inside the trusted-instruction region, NOT inside the `<<UNTRUSTED_DIFF>>` fence).
  - Narrow reviewers: `const active = triage.reviewerHint.length ? reviewers.filter(r => triage.reviewerHint.includes(r.provider)) : reviewers;`
  - After `aggregate`, store cache: compute the key (diff + a config hash + provider-versions placeholder + reviewgate version + schema) and `putCachedReview`. Add the cache short-circuit at the top of the prelude (after triage): if `getCachedReview` hits, write that verdict and return.
  - For symbol-relative signatures: pass the `graph` into a finding-signature resolver. SIMPLEST M3 approach — after aggregation, recompute each finding's signature using `enclosingSymbol(join(repoRoot, f.file), f.line_start)` when available; if it changes signatures, do it BEFORE dedup. To keep Task 8 bounded, implement this as a post-map step in the orchestrator: for each raw finding, resolve the enclosing symbol and recompute its signature via `computeSignature({...})` BEFORE calling `aggregate`. (Document that this supersedes the per-adapter signature for supported languages.)

- [ ] **Step 4: Extend config** — `defaults.ts`: add `phases.triage: null as null | { provider; model? }`, `cache: { enabled: true, reviewTtlDays: 7 }`, `research: { languages: ["typescript","tsx","python"] }`. `define-config.ts`: add the matching zod. Keep all existing fields.

- [ ] **Step 5: Pass (new + ALL existing orchestrator/panel tests) + typecheck + format + lint + commit**
```bash
export PATH="$HOME/.bun/bin:$PATH" && bun test tests/unit tests/integration && bun run typecheck && bun run format && bun run lint
git add src/core/orchestrator.ts src/config/defaults.ts src/config/define-config.ts tests/unit/orchestrator-triage.test.ts
git commit -m "feat(core): triage → cache → research → adaptive panel; reviewers read research.md"
```

---

## Phase 8 — Build, doctor, e2e, docs

### Task 9: wasm grammar packaging in the build + doctor check

**Files:** `package.json` (build script), `src/cli/commands/doctor.ts` (MODIFY), `tests/integration/binary.test.ts` (extend)

- [ ] **Step 1: Make `bun run build` copy grammars next to the binary** (per SM3-3). Update the `build` script to also copy `node_modules/tree-sitter-*/**.wasm` and web-tree-sitter's runtime wasm into `dist/grammars/`:
```jsonc
"build": "bun build src/cli/index.ts --compile --outfile dist/reviewgate && mkdir -p dist/grammars && cp node_modules/tree-sitter-typescript/*.wasm node_modules/tree-sitter-python/*.wasm dist/grammars/ 2>/dev/null || true"
```
(The `grammars.ts` resolver already checks `dirname(process.execPath)/grammars`.)

- [ ] **Step 2: doctor** — add a check that ripgrep is present (warn if absent: symbol-graph callers degrade) and that at least one grammar wasm resolves (warn if absent: symbol-graph disabled). Reuse the `Check` pattern.

- [ ] **Step 3: Build + smoke**
```bash
export PATH="$HOME/.bun/bin:$PATH" && bun run build && ./dist/reviewgate --version && ./dist/reviewgate doctor || true
```

- [ ] **Step 4: Commit**
```bash
git add package.json src/cli/commands/doctor.ts tests/integration/binary.test.ts
git commit -m "build+cli: bundle tree-sitter grammars into dist; doctor checks rg + grammars"
```

### Task 10: real e2e — adaptive run with a symbol graph

**Files:** `tests/e2e/triage-real.test.ts`

- [ ] **Step 1: Write an opt-in e2e** (gated by `REVIEWGATE_E2E=1`): a multi-file repo where the buggy function is CALLED elsewhere; assert `research.md` lists the symbol + a caller, a doc-only follow-up commit is SKIPPED by triage, and a repeated identical diff hits the cache (2nd run spawns no reviewer — assert by timing or a reviewer-call counter via a stub provider override). Mirror the structure of `codex-real.test.ts`.

- [ ] **Step 2: Confirm skip without the flag; run with `REVIEWGATE_E2E=1` once to verify; commit**
```bash
git add tests/e2e/triage-real.test.ts
git commit -m "test(e2e): adaptive triage + research symbol graph + cache hit"
```

### Task 11: docs

**Files:** `README.md`, `docs/AGENTS.md` (MODIFY)

- [ ] **Step 1: README** — add an "Adaptive pipeline" section: triage skips doc-only diffs, research.md context, the symbol graph (supported languages + ripgrep), and the review cache. Move triage/research/symbol-graph/caching from "Not yet (M3–M6)" into "In M3".
- [ ] **Step 2: docs/AGENTS.md** — note that `pending.md` findings now have more stable symbol-relative signatures, and that trivial (doc-only) diffs may pass without a review. Protocol unchanged.
- [ ] **Step 3: Commit**
```bash
git add README.md docs/AGENTS.md
git commit -m "docs: document the M3 adaptive pipeline (triage, research, symbol graph, cache)"
```

---

## Wrap-up checklist (run before claiming M3 done)

- [ ] **Spikes documented:** `docs/superpowers/spikes/M3/SUMMARY.md` lists SM3-1..3.
- [ ] **All unit tests green:** `bun test tests/unit` exits 0.
- [ ] **Integration green:** `bun test tests/integration` exits 0.
- [ ] **Typecheck + lint clean.**
- [ ] **Build green AND grammars bundled:** `dist/grammars/*.wasm` exists; `./dist/reviewgate doctor` finds the grammars.
- [ ] **Triage works:** a doc-only diff is reviewed in $0 with verdict PASS and no reviewer spawned; a sensitive-path diff selects the expanded reviewer set.
- [ ] **Research works:** a real code diff produces `.reviewgate/research.md` with a non-empty symbol graph for a TS file, including a cross-file caller (ripgrep).
- [ ] **Cache works:** re-running the identical diff returns the prior verdict without spawning a reviewer.
- [ ] **Signatures stable:** a finding's signature is unchanged when unrelated lines are inserted above its enclosing function (symbol-relative), verified in `signature-symbol.test.ts`.
- [ ] **Graceful degradation:** with `rg` absent or a grammar missing, review still runs (no symbol graph, no crash).

When fully ✓, M3 ships. Then write the M4 plan (Brain + Curator + memory proposals).

---

## Self-review notes (author)

- **Spec coverage:** §5.3 triage matrix (Task 4), adaptive phase selection + LLM-can't-widen-budget (Task 5/8), research.md contents — diff facts (Task 1), git-history (NOTE: research-writer currently omits `git log -5` per file; ADD a `gitHistory` section in Task 6 if desired — flagged as a small gap), symbol graph (Task 2), conventions (Task 6); symbol-relative signatures (Task 3 + Task 8 wiring); cache key with the spec's components (Task 7 — NOTE: brain/fp-ledger hashes are M4/M5 and intentionally omitted from the key now; document that cache invalidates on their introduction).
- **Known gaps to confirm during impl:** (a) git-history section in research.md (cheap `git log -5 -- <file>` per changed file — add to research-writer); (b) the cache key omits brain/fp-ledger (don't exist yet) — fine for M3; (c) `bun build --compile` wasm bundling is the riskiest item (SM3-3) — if it can't be solved cleanly, ship symbol-graph as dev/runtime-only and degrade in the binary.
- **Type consistency:** `TriageDecision`, `DiffFacts`, `SymbolGraph` shapes are used identically across matrix/engine/research-writer/orchestrator. The orchestrator's reviewer-narrowing intersects `reviewerHint` (provider ids) with configured reviewers.
- **Anti-sycophancy:** the triage LLM obeys the same downgrade as reviewers (Task 5/8) — wire via the existing host-tier logic.
