# Installed-Dependency API-Surface Injection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inject the installed dependencies' API surface (exported names + best-effort object members, read from `node_modules` `.d.ts`) into the reviewer prompt as advisory, sanitized context — so reviewers stop falsely claiming a real installed API (e.g. `z.partialRecord`) is invalid/non-existent.

**Architecture:** Pure context injection — NO demote, NO verdict change (a `.d.ts` grep can't soundly prove member-of-binding without TS type resolution, so demoting would suppress real findings). `collectDepSurface` resolves each imported package's types entry + bounded re-exports, extracts identifier-whitelisted names, and the orchestrator injects them in the trusted region as advisory text. Spec: `docs/superpowers/specs/2026-06-16-dep-claim-verification-design.md` (codex 4 rounds + opus PASS).

**Tech Stack:** Bun, TypeScript, web-tree-sitter (import parsing), `safeReadContained`, zod, `bun test`. Use `bun`/`bunx`, never npm/node.

---

## File Structure

- `src/research/imports.ts` — export `specToPackage`; add `importBindings`. (Task 1)
- `src/research/dep-surface.ts` — NEW: `collectDepSurface`. (Task 2)
- `src/config/defaults.ts` + `src/config/define-config.ts` — `phases.review.depSurface` (true) / `depSurfaceBudgetBytes` (4000). (Task 3)
- `src/core/orchestrator.ts` — build libs+bindings, `collectDepSurface` under `withTimeout`, inject in prompt assembly. (Task 3)
- Tests: `tests/unit/imports.test.ts` (extend), `tests/unit/dep-surface.test.ts` (new). (Tasks 1–2)

---

## Task 1: `imports.ts` — export `specToPackage` + add `importBindings`

**Files:** Modify `src/research/imports.ts` (`specToPackage` ~157; add `importBindings` near `specifiersFromFile` ~177); Test `tests/unit/imports.test.ts`.

- [ ] **Step 1: Write failing tests** — append to `tests/unit/imports.test.ts` (add imports for `importBindings`, `specToPackage`, `mkdtempSync`/`writeFileSync`/`tmpdir`/`join` if not present):

```ts
import { importBindings, specToPackage } from "../../src/research/imports.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("specToPackage normalizes bare, subpath, and scoped specifiers", () => {
  expect(specToPackage("zod")).toBe("zod");
  expect(specToPackage("zod/v4")).toBe("zod");
  expect(specToPackage("@scope/x")).toBe("@scope/x");
  expect(specToPackage("@scope/x/sub")).toBe("@scope/x");
  expect(specToPackage("./local")).toBeNull();
});

it("importBindings maps default/namespace/named (+ alias) to package; skips relative/builtin", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-ib-"));
  const f = join(dir, "a.ts");
  writeFileSync(
    f,
    [
      'import { z } from "zod";',
      'import * as React from "react";',
      'import def from "lodash";',
      'import { foo as bar } from "@scope/pkg";',
      'import { rel } from "./local";',
      'import { readFile } from "node:fs";',
    ].join("\n"),
  );
  const m = await importBindings(dir, f);
  expect(m.get("z")).toBe("zod");
  expect(m.get("React")).toBe("react");
  expect(m.get("def")).toBe("lodash");
  expect(m.get("bar")).toBe("@scope/pkg"); // alias is the local binding
  expect(m.has("rel")).toBe(false); // relative skipped
  expect(m.has("readFile")).toBe(false); // builtin skipped
});

it("importBindings returns an empty map for a non-JS/TS file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-ib2-"));
  const f = join(dir, "a.py");
  writeFileSync(f, "import os\n");
  expect((await importBindings(dir, f)).size).toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/unit/imports.test.ts`
Expected: FAIL — `importBindings`/`specToPackage` not exported.

- [ ] **Step 3: Export `specToPackage`** — in `src/research/imports.ts`, change `function specToPackage(` to `export function specToPackage(`.

- [ ] **Step 4: Add `importBindings`** — in `src/research/imports.ts`, after `specifiersFromFile`, add (reuses the same parser path as `specifiersFromFile`/`treeSitterSpecifiers`):

```ts
/** Local import binding → package name for one JS/TS file (default / `* as ns` / named incl.
 *  `as` alias). Relative/builtin sources skipped. Empty map for non-JS/TS or parse failure. */
export async function importBindings(repoRoot: string, file: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const g = grammarForFile(file);
  if (!g || !JS_TS_LANGS.has(g.lang)) return out;
  const lang = await getLanguage(g.wasmFile);
  if (!lang) return out;
  const code = safeReadContained(repoRoot, relative(repoRoot, file) || file, 2_000_000);
  if (code === null) return out;
  let parser: Parser | null = null;
  let q: Query | null = null;
  try {
    parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(code);
    if (!tree) return out;
    q = new Query(lang, "(import_statement) @imp");
    for (const m of q.matches(tree.rootNode)) {
      const node = m.captures[0]?.node;
      if (!node) continue;
      const source = node.childForFieldName("source");
      const spec = source ? stringNodeValue(source) : null;
      const pkg = spec ? specToPackage(spec) : null;
      if (!pkg) continue;
      // import_clause holds the bindings; default import is an `identifier` child of the clause.
      for (const child of node.descendantsOfType?.(["identifier", "namespace_import", "import_specifier"]) ?? walkClause(node)) {
        if (child.type === "identifier" && child.parent?.type === "import_clause") out.set(child.text, pkg);
        else if (child.type === "namespace_import") {
          const id = child.namedChildren.find((c) => c.type === "identifier");
          if (id) out.set(id.text, pkg);
        } else if (child.type === "import_specifier") {
          const alias = child.childForFieldName("alias");
          const name = child.childForFieldName("name");
          const local = (alias ?? name)?.text;
          if (local) out.set(local, pkg);
        }
      }
    }
    tree.delete();
    return out;
  } catch {
    return out;
  } finally {
    q?.delete();
    parser?.delete();
  }
}

// Fallback walker if descendantsOfType is unavailable in the installed web-tree-sitter:
function walkClause(importNode: Node): Node[] {
  const acc: Node[] = [];
  const visit = (n: Node) => {
    if (n.type === "identifier" || n.type === "namespace_import" || n.type === "import_specifier") acc.push(n);
    for (const c of n.namedChildren) visit(c);
  };
  visit(importNode);
  return acc;
}
```

Add any missing imports at the top of `imports.ts`: `relative` from `node:path` (if not present), and ensure `Node` type is imported from `web-tree-sitter` (it's already used). NOTE: `descendantsOfType` may not exist in this web-tree-sitter version — if the real run errors, delete the `descendantsOfType?.(...) ??` part and use `walkClause(node)` directly (the test is the oracle; the fixture verifies the actual node types `import_clause`/`namespace_import`/`import_specifier`/`name`/`alias`).

- [ ] **Step 5: Run tests** — `bun test tests/unit/imports.test.ts` → PASS. If a node-type/field-name is wrong for the real grammar, the binding-map test fails specifically; fix the node/field names to match the real TS grammar and re-run.

- [ ] **Step 6: Typecheck + lint** — `bunx tsc --noEmit && bun run lint` (format first if biome reports). Clean.

- [ ] **Step 7: Commit**

```bash
git add src/research/imports.ts tests/unit/imports.test.ts
git commit -m "feat(imports): export specToPackage + add importBindings (binding->package)"
```

---

## Task 2: `dep-surface.ts` — `collectDepSurface`

**Files:** Create `src/research/dep-surface.ts`; Test `tests/unit/dep-surface.test.ts`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/dep-surface.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDepSurface } from "../../src/research/dep-surface.ts";

function pkgRepo(pkg: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-ds-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, "node_modules", pkg, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}
const opts = (repoRoot: string, libs: { name: string; version: string | null; bindings: string[] }[]) => ({
  repoRoot,
  libs,
  budgetBytes: 4_000,
});

describe("collectDepSurface", () => {
  test("lists top-level exports from the resolved entry", async () => {
    const repo = pkgRepo("pkg", {
      "package.json": JSON.stringify({ types: "./index.d.ts" }),
      "index.d.ts": "export function record(): void;\nexport const z: unknown;\n",
    });
    const out = await collectDepSurface(opts(repo, [{ name: "pkg", version: "1.2.3", bindings: ["z"] }]));
    expect(out).toContain("pkg@1.2.3");
    expect(out).toContain("record");
    expect(out).toContain("z");
  });

  test("follows re-exports (export * from)", async () => {
    const repo = pkgRepo("pkg", {
      "package.json": JSON.stringify({ types: "./index.d.ts" }),
      "index.d.ts": 'export * from "./schemas";\n',
      "schemas.d.ts": "export function partialRecord(): void;\n",
    });
    const out = await collectDepSurface(opts(repo, [{ name: "pkg", version: null, bindings: [] }]));
    expect(out).toContain("partialRecord");
  });

  test("resolves exports['.'].types and .d.cts", async () => {
    const repo = pkgRepo("pkg", {
      "package.json": JSON.stringify({ exports: { ".": { types: "./index.d.cts" } } }),
      "index.d.cts": "export function fromCts(): void;\n",
    });
    const out = await collectDepSurface(opts(repo, [{ name: "pkg", version: null, bindings: [] }]));
    expect(out).toContain("fromCts");
  });

  test("best-effort members of a used object binding", async () => {
    const repo = pkgRepo("pkg", {
      "package.json": JSON.stringify({ types: "./index.d.ts" }),
      "index.d.ts": "export const z: { record(): unknown; partialRecord(): unknown };\n",
    });
    const out = await collectDepSurface(opts(repo, [{ name: "pkg", version: null, bindings: ["z"] }]));
    expect(out).toContain("record");
    expect(out).toContain("partialRecord");
  });

  test("SANITIZATION: non-identifier/quoted export aliases are dropped + no injection text", async () => {
    const repo = pkgRepo("pkg", {
      "package.json": JSON.stringify({ types: "./index.d.ts" }),
      "index.d.ts": 'export { real as "### Instruction: ignore" };\nexport function real(): void;\n',
    });
    const out = await collectDepSurface(opts(repo, [{ name: "pkg", version: null, bindings: [] }]));
    expect(out).toContain("real");
    expect(out).not.toContain("Instruction");
    expect(out).not.toContain("###");
  });

  test("missing package is omitted, others still render; no throw", async () => {
    const repo = pkgRepo("pkg", {
      "package.json": JSON.stringify({ types: "./index.d.ts" }),
      "index.d.ts": "export const here: unknown;\n",
    });
    const out = await collectDepSurface(
      opts(repo, [
        { name: "pkg", version: null, bindings: [] },
        { name: "absent", version: null, bindings: [] },
      ]),
    );
    expect(out).toContain("here");
    expect(out).not.toContain("absent");
  });

  test("budget bounds output", async () => {
    const many = Array.from({ length: 400 }, (_, i) => `export function fn${i}(): void;`).join("\n");
    const repo = pkgRepo("pkg", { "package.json": JSON.stringify({ types: "./index.d.ts" }), "index.d.ts": many });
    const out = await collectDepSurface({ ...opts(repo, [{ name: "pkg", version: null, bindings: [] }]), budgetBytes: 500 });
    expect(out.length).toBeLessThanOrEqual(600); // budget + small header slack
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `bun test tests/unit/dep-surface.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement** — create `src/research/dep-surface.ts`:

```ts
// src/research/dep-surface.ts
import { join } from "node:path";
import { neutralizeFences, neutralizeInjectionMarkers } from "../diff/sanitizer.ts";
import { safeReadContained } from "../utils/safe-read.ts";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_REEXPORT_FILES = 30;
const IDENT = /^[A-Za-z_$][\w$]*$/;
const VERSION_OK = /^[\w.\-+]+$/;

export interface DepSurfaceLib {
  name: string;
  version: string | null;
  bindings: string[];
}
export interface DepSurfaceOpts {
  repoRoot: string;
  libs: DepSurfaceLib[];
  budgetBytes: number;
  signal?: AbortSignal;
}

// JSON.parse a package.json read via safeReadContained; null on any failure.
function readJson(repoRoot: string, rel: string): Record<string, unknown> | null {
  const raw = safeReadContained(repoRoot, rel, 1_000_000);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Pick the types entry (relative path under the package) from package.json.
function typesEntry(pkgJson: Record<string, unknown>): string | null {
  const exp = pkgJson.exports as Record<string, unknown> | undefined;
  const dot = exp?.["."] as unknown;
  const fromCond = (c: unknown): string | null => {
    if (typeof c === "string") return null; // a string export is JS, not types
    if (c && typeof c === "object") {
      const o = c as Record<string, unknown>;
      if (typeof o.types === "string") return o.types;
      for (const k of ["import", "require", "default"]) {
        const sub = o[k];
        if (sub && typeof sub === "object" && typeof (sub as Record<string, unknown>).types === "string")
          return (sub as Record<string, unknown>).types as string;
      }
    }
    return null;
  };
  return (
    fromCond(dot) ??
    (typeof pkgJson.types === "string" ? pkgJson.types : null) ??
    (typeof pkgJson.typings === "string" ? pkgJson.typings : null)
  );
}

// Resolve a "./x"-style relative type ref under the package to an existing .d.ts rel-path.
function resolveDts(repoRoot: string, baseRel: string, ref: string): string | null {
  const dir = join(baseRel, "..");
  const norm = join(dir, ref);
  const candidates = [norm, `${norm}.d.ts`, `${norm}.d.cts`, `${norm}.d.mts`, join(norm, "index.d.ts")];
  for (const c of candidates) {
    if (safeReadContained(repoRoot, c, 1) !== null || safeReadContained(repoRoot, c, MAX_FILE_BYTES) !== null) {
      // second read confirms readability (the 1-byte probe is cheap existence)
      return c;
    }
  }
  return null;
}

// Collect identifier-whitelisted export names + followed re-export files from a .d.ts.
function extractNames(text: string): { names: Set<string>; reexports: string[] } {
  const names = new Set<string>();
  const reexports: string[] = [];
  const add = (n: string) => {
    if (IDENT.test(n)) names.add(n);
  };
  const declRe =
    /export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/g;
  for (const m of text.matchAll(declRe)) add(m[1] as string);
  // export { a, b as c }  (with or without `from "./x"`)
  const braceRe = /export\s*\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/g;
  for (const m of text.matchAll(braceRe)) {
    for (const part of (m[1] as string).split(",")) {
      const seg = part.trim();
      if (!seg) continue;
      const asMatch = seg.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/);
      add(asMatch ? (asMatch[1] as string) : (seg.split(/\s+/)[0] as string));
    }
    if (m[2]) reexports.push(m[2] as string);
  }
  // export * from "./x"
  for (const m of text.matchAll(/export\s*\*\s*(?:as\s+[A-Za-z_$][\w$]*\s+)?from\s*['"]([^'"]+)['"]/g))
    reexports.push(m[1] as string);
  return { names, reexports };
}

// Best-effort: members of `export const <binding>: { m1; m2 }` or `namespace <binding> { ... }`.
function extractBindingMembers(text: string, binding: string): string[] {
  if (!IDENT.test(binding)) return [];
  const out = new Set<string>();
  // const binding: { ... } — capture the inline object body (single level).
  const constRe = new RegExp(`(?:export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+${binding}\\s*:\\s*\\{`);
  const cm = constRe.exec(text);
  if (cm) {
    const start = cm.index + cm[0].length - 1; // at the `{`
    let depth = 0;
    let i = start;
    for (; i < text.length && i < start + 50_000; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = text.slice(start + 1, i);
    for (const m of body.matchAll(/(?:^|[;{,\n])\s*([A-Za-z_$][\w$]*)\s*[?(:<]/g)) out.add(m[1] as string);
  }
  // namespace binding { export ... }
  const nsRe = new RegExp(`namespace\\s+${binding}\\s*\\{`);
  if (nsRe.test(text)) for (const m of text.matchAll(/(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1] as string);
  return [...out].filter((n) => IDENT.test(n));
}

export async function collectDepSurface(opts: DepSurfaceOpts): Promise<string> {
  const { repoRoot, libs, budgetBytes, signal } = opts;
  const blocks: string[] = [];
  let used = 0;
  for (const lib of [...libs].sort((a, b) => a.name.localeCompare(b.name))) {
    signal?.throwIfAborted();
    if (used >= budgetBytes) break;
    const pkgDir = lib.name.startsWith("@")
      ? join("node_modules", ...lib.name.split("/"))
      : join("node_modules", lib.name);
    const pj = readJson(repoRoot, join(pkgDir, "package.json"));
    if (!pj) continue;
    let entry = typesEntry(pj) ?? "index.d.ts";
    entry = entry.replace(/^\.\//, "");
    let entryRel = join(pkgDir, entry);
    if (safeReadContained(repoRoot, entryRel, MAX_FILE_BYTES) === null) {
      const alt = ["index.d.ts", "index.d.cts", "index.d.mts"].map((x) => join(pkgDir, x)).find((c) => safeReadContained(repoRoot, c, MAX_FILE_BYTES) !== null);
      if (!alt) continue;
      entryRel = alt;
    }
    // BFS the re-export graph (depth 2, ≤30 files), collecting names.
    const names = new Set<string>();
    const seen = new Set<string>();
    let frontier: { rel: string; depth: number }[] = [{ rel: entryRel, depth: 0 }];
    const entryText = safeReadContained(repoRoot, entryRel, MAX_FILE_BYTES) ?? "";
    while (frontier.length && seen.size < MAX_REEXPORT_FILES) {
      const next: { rel: string; depth: number }[] = [];
      for (const { rel, depth } of frontier) {
        if (seen.has(rel) || seen.size >= MAX_REEXPORT_FILES) continue;
        seen.add(rel);
        const text = rel === entryRel ? entryText : (safeReadContained(repoRoot, rel, MAX_FILE_BYTES) ?? "");
        const { names: ns, reexports } = extractNames(text);
        for (const n of ns) names.add(n);
        if (depth < 2)
          for (const ref of reexports) {
            const r = resolveDts(repoRoot, rel, ref);
            if (r && !seen.has(r)) next.push({ rel: r, depth: depth + 1 });
          }
      }
      frontier = next;
    }
    // Best-effort members of used object bindings (from the entry text only).
    const memberLines: string[] = [];
    for (const b of lib.bindings) {
      const ms = extractBindingMembers(entryText, b);
      if (ms.length) memberLines.push(`${b}: { ${[...new Set(ms)].sort().join(", ")} }`);
    }
    const version = lib.version && VERSION_OK.test(lib.version) ? lib.version : null;
    const header = `### ${specSafe(lib.name)}${version ? `@${version}` : ""}`;
    const exportLine = `exports: ${[...names].sort().join(", ")}`;
    const raw = [header, exportLine, ...memberLines].join("\n");
    // Defense-in-depth (the identifier-whitelist above is the primary guarantee — every name
    // matches IDENT, so it has no CR/LF/space/marker; the only newlines are the structural
    // ones we joined, kept for readability).
    const clean = neutralizeFences(neutralizeInjectionMarkers(raw));
    if (used + clean.length + 1 > budgetBytes) {
      blocks.push(`${clean.slice(0, Math.max(0, budgetBytes - used))}\n…`);
      break;
    }
    blocks.push(clean);
    used += clean.length + 1;
  }
  return blocks.join("\n\n");
}

// Package name is already constrained by specToPackage, but keep the header injection-proof.
function specSafe(name: string): string {
  return /^@?[\w.\-/]+$/.test(name) ? name : "dependency";
}
```

- [ ] **Step 4: Run test** — `bun test tests/unit/dep-surface.test.ts` → PASS (7 tests). If a `.d.ts` declaration regex misses a fixture form, adjust the regex (the fixtures are the contract). If `resolveDts`'s double-read is awkward, simplify to a single `safeReadContained(... , MAX_FILE_BYTES) !== null` existence check.

- [ ] **Step 5: Typecheck + lint** — `bunx tsc --noEmit && bun run lint` → clean.

- [ ] **Step 6: Commit**

```bash
git add src/research/dep-surface.ts tests/unit/dep-surface.test.ts
git commit -m "feat(dep-surface): collectDepSurface — sanitized installed API surface from node_modules

Entry resolution (exports['.'].types/.d.cts/index) + bounded re-export following;
identifier-whitelisted export names + best-effort object-binding members; block
neutralized as defense-in-depth. Context-only, no verdict path."
```

---

## Task 3: Config + orchestrator wiring

**Files:** Modify `src/config/define-config.ts`, `src/config/defaults.ts`, `src/core/orchestrator.ts`.

- [ ] **Step 1: Config keys.** In `src/config/define-config.ts`, in the `review` z.object (near `fileContextWindowLines`), add:
```ts
      // #3: inject the installed dependency API surface (exported names from node_modules
      // .d.ts) as advisory reviewer context, so reviewers don't claim a real installed API is
      // non-existent. Context-only, no verdict change. Default ON.
      depSurface: z.boolean().optional(),
      depSurfaceBudgetBytes: z.number().int().positive().optional(),
```
In `src/config/defaults.ts`, in `phases.review`, add:
```ts
      depSurface: true,
      depSurfaceBudgetBytes: 4_000,
```

- [ ] **Step 2: Import + build the surface in the orchestrator.** In `src/core/orchestrator.ts` add the imports:
```ts
import { collectDepSurface } from "../research/dep-surface.ts";
import { importBindings } from "../research/imports.ts";
```
(`extractImportedLibs` + `withTimeout` are already imported.) After the existing `contextDocs` block (~687), add:
```ts
    // #3: installed dependency API surface (advisory, sanitized) — bounded by the same
    // withTimeout posture as contextDocs so a slow .d.ts read can't push the self-deadline.
    let depSurface = "";
    if (this.input.config.phases.review.depSurface) {
      depSurface = await withTimeout(
        (async () => {
          const changed = facts.files.map((f) => f.path);
          const libs = await extractImportedLibs(repo, changed).catch(() => []);
          if (libs.length === 0) return "";
          // One binding map per changed file, merged (binding → package).
          const binds = new Map<string, string>();
          for (const file of changed)
            for (const [b, p] of await importBindings(repo, join(repo, file)).catch(() => new Map()))
              binds.set(b, p);
          const enriched = libs.map((l) => ({
            name: l.name,
            version: l.version,
            bindings: [...binds.entries()].filter(([, p]) => p === l.name).map(([b]) => b),
          }));
          return collectDepSurface({
            repoRoot: repo,
            libs: enriched,
            budgetBytes: this.input.config.phases.review.depSurfaceBudgetBytes ?? 4_000,
            signal: opts.signal,
          });
        })(),
        DOCS_TOTAL_TIMEOUT_MS,
        "dep-surface",
      ).catch(() => "");
    }
```
(`join` from `node:path` is already imported in orchestrator; if not, add it. `DOCS_TOTAL_TIMEOUT_MS` is the constant the contextDocs block uses.)

- [ ] **Step 3: Inject into the prompt (advisory, trusted region).** In the prompt assembly (where `houseRulesText` is pushed, ~1118), after that line add:
```ts
          if (depSurface)
            promptParts.push(
              "## Installed dependency API surface (from this repo's node_modules — the ACTUALLY-installed versions; prefer this over your training data, which may be stale)",
              "These are exported symbols of the libraries this change imports, read from the installed packages. Use them to CHECK before claiming an API is undefined/invalid/non-existent — your training data may predate the installed version. A listed symbol exists somewhere in that package (possibly via a different entrypoint than the one imported here), so confirm the specific import path rather than treating \"listed\" as proof for this exact usage. Names-only surface: a symbol NOT listed may still exist (deeper members aren't all shown) — verify against node_modules, don't assume it's absent.",
              depSurface,
              "",
            );
```

- [ ] **Step 4: Verify.** `bunx tsc --noEmit && bun run lint && bun test tests/unit --timeout 30000` → clean + all green. If a defaults-snapshot test asserts `phases.review` exactly, add the two new keys.

- [ ] **Step 5: Commit**

```bash
git add src/config/define-config.ts src/config/defaults.ts src/core/orchestrator.ts
git commit -m "feat(orchestrator): inject installed dependency API surface (#3, advisory)

Build per-package surface (extractImportedLibs + importBindings) under the
contextDocs withTimeout posture; inject as advisory trusted-region context.
Config phases.review.depSurface (true) / depSurfaceBudgetBytes (4000). No demote."
```

---

## Task 4: Definition of Done

- [ ] **Step 1:** `bunx tsc --noEmit && bun run lint && bun test --timeout 30000` → clean, all green (use `--timeout 30000`; default-5s failures are known subprocess-spawn flakes — re-run the file to confirm a flake vs a real regression).
- [ ] **Step 2:** `bun run build` → compiles. Do NOT deploy/merge yet (`bun run build` deploys via the dist symlink). This only confirms the compiled binary builds.
- [ ] **Step 3:** End the turn so the dogfood gate reviews this branch's diff; address every finding (fix or reject ≥20 chars) until PASS.
- [ ] **Step 4:** Report tests/tsc/lint/gate status. Do NOT push or rebuild-and-deploy dist without the user's OK.

---

## Self-Review (completed by plan author)

- **Spec coverage:** importBindings + specToPackage export → Task 1; collectDepSurface (entry resolution + re-export following + identifier-whitelist sanitization + neutralize + best-effort members + budget) → Task 2; config + withTimeout-guarded build + advisory injection → Task 3; DoD → Task 4. The "no demote / context-only", the identifier-whitelist-as-primary-defense, the advisory (non-imperative) wording, and the withTimeout deadline guard are all implemented.
- **Type consistency:** `DepSurfaceLib {name, version, bindings}` (Task 2) matches the `enriched` objects built in Task 3; `collectDepSurface(opts)` signature consistent; `importBindings(repoRoot, file) → Map<string,string>` (Task 1) consumed in Task 3; config keys `depSurface`/`depSurfaceBudgetBytes` identical across defaults/schema/orchestrator.
- **Placeholders:** none — complete code; the real-fixture/real-grammar tests are the oracle for the tree-sitter node names and `.d.ts` regexes (Task 1 Step 5 / Task 2 Step 4 note how to adjust if a name is off).
