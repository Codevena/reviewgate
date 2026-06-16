# Installed-Dependency API-Surface Injection (#3) — Design

**Date:** 2026-06-16
**Status:** Approved (design — SOFT-injection pivot), pending implementation plan
**Source:** flashbuddy field report #3 ("ground claims against the installed dependency version"). The FP: a reviewer flagged `z.record(userId)` / `z.partialRecord` as an invalid/non-existent zod API at high confidence, when the symbol exists in the installed `zod`.

## Why SOFT injection (not a hard verify/demote)

The first design draft was a deterministic *demote* of "API does not exist" findings, verified against `node_modules` `.d.ts`. Two codex review rounds proved that **unsound**: a `.d.ts` name-grep proves "a symbol is declared *somewhere* on the package surface", NOT "`member` is a member of the *imported binding's value*". For `import { z } from "zod"; z.record(...)`, `z` is an imported object and `z.record` is a member of its **type** — verifying that soundly needs full TS type resolution (the TS compiler API), out of scope/too heavy for the gate hot path. A grep heuristic would **demote real findings** (a package can export a standalone `record` while `client.record` is truly absent) — suppressing a real finding is the gate's cardinal sin.

So we **do not demote**. Instead we **inject the installed package's API surface as trusted reviewer context** — the reviewer SEES that `z.partialRecord` exists in the actually-installed version and is told to trust that over its training data. This **cannot suppress a real finding** (no verdict change), is local + deterministic (unlike the network Context7 `contextDocs`), and reuses the entry-resolution work. Its only weakness is the reviewer may ignore it — acceptable, since the alternative (a demote) is unsafe.

## Architecture

### `src/research/imports.ts` — export `specToPackage`, add `importBindings`
- **Export `specToPackage`** (currently module-private): maps a specifier (`"zod"`, `"zod/v4"`, `"@scope/x"`) → package name. Reused by the resolver.
- **Add `importBindings(repoRoot, file) → Promise<Map<string,string>>`**: local binding → package, for default (`import z from "zod"`), namespace (`import * as z from "zod"`), and named (`import { z } from "zod"`, honoring `as` aliases) imports. Walks `import_statement`→`import_clause` (`identifier` / `namespace_import` / `named_imports`→`import_specifier` name+alias) via the existing tree-sitter parser (`getLanguage`/`grammarForFile`). Empty map for non-JS/TS or parse failure. Skips relative/builtin sources.

### `src/research/dep-surface.ts` (NEW) — `collectDepSurface`
```ts
export interface DepSurfaceOpts {
  repoRoot: string;
  libs: { name: string; version: string | null; bindings: string[] }[]; // per imported package
  budgetBytes: number;
  signal?: AbortSignal;
}
/** Render a compact "installed API surface" block per imported package, or "" if none resolve. */
export async function collectDepSurface(opts: DepSurfaceOpts): Promise<string>;
```
Per package (sorted, until `budgetBytes` is hit):
1. **Resolve the types entry** under `repoRoot/node_modules/<pkg>` (via `safeReadContained` — node_modules is under repoRoot → contained; pnpm's intermediate package symlink + real file under `.pnpm` still reads contained): `package.json` → `exports["."].types` (incl. conditional `import`/`require` → `.types`/string) ?? `types` ?? `typings` ?? first existing of `index.d.ts`/`index.d.cts`/`index.d.mts`. Unresolved → skip this package.
2. **Extract the export surface** from the entry, following the entry's re-export graph (`export * from "./x"`, `export {…} from "./x"`) to bounded depth **2** / **30 files** / **2 MB** total (resolve `./x` → `x` / `x.d.ts` / `x.d.cts` / `x.d.mts` / `x/index.d.ts` relative to the referencing file), all reads `safeReadContained`:
   - **Top-level exported names:** `export (declare )?(const|let|var|function|class|interface|type|enum|namespace|abstract class) <Name>`, and the names inside `export { a, b as c }` (record the exported alias `c`).
   - **Best-effort members of a USED binding's object/namespace export:** for each `binding` in `opts.libs[].bindings`, if the entry declares an export of that name as an object/namespace/interface whose body is reachable (inline `const <binding>: { m1; m2; … }`, `namespace <binding> { … }`, or `interface <Type>` that `const <binding>: <Type>` points to within the budget), extract the member names (`<member>(`, `<member>:`, `<member>?:`, `<member><`). Best-effort — if the type can't be cheaply located, skip (the top-level names still ship).
3. **Render** (compact): `### <pkg>@<version>` then `exports: name1, name2, …` and, when members were extracted, `<binding>: { m1, m2, … }`. Names sorted + deduped; truncate with `…` when the per-package or total `budgetBytes` is hit.

No `.d.ts` bodies are injected — names only, so the block stays small.

### Orchestrator wiring (`src/core/orchestrator.ts`)
- Build the imported-package list (reuse `extractImportedLibs(repoRoot, changedFiles)` → `{name, version}`; attach `bindings` from `importBindings` over the changed files). `changedFiles` = the keys of `parseChangedRanges(this.input.diff)` (already computed for #2) or the diff-facts file list.
- `const depSurface = config.phases.review.depSurface ? await collectDepSurface({ repoRoot: repo, libs, budgetBytes: …depSurfaceBudgetBytes ?? 4_000, signal }) : ""`.
- Inject into the reviewer prompt as **TRUSTED context** (it's read from the maintainer's own installed `node_modules`, not untrusted diff/LLM output — so it goes BEFORE the untrusted diff fence, like `houseRules`), with a strong instruction:
  > ## Installed dependency API surface (TRUSTED — from this repo's node_modules, the ACTUALLY-installed versions; trust this over your training data)
  > Below are exported symbols of the libraries this change imports. If a symbol is listed here, it EXISTS in the installed version — do NOT report it as undefined/invalid/non-existent. This is a names-only surface; if a symbol you need is NOT listed it may still exist (members behind deeper types aren't all shown) — verify against node_modules, do not assume it's absent.

### Config (`phases.review`)
- `depSurface: boolean` — default `true` (low-risk: pure trusted context, no verdict change; bounded). Set false to disable.
- `depSurfaceBudgetBytes: number` — default `4_000` (small; names-only). Counts toward keeping the prompt lean (the #6 timeout posture).

No `FindingSchema` change, no demote, no verdict path touched.

## Testing (TDD, `bun test`, against mini-package fixtures in a tmp repo)

`tests/unit/dep-surface.test.ts` (write `node_modules/<pkg>/` fixtures + a source file importing them):
- `package.json {"types":"./index.d.ts"}`, entry `export const z = …; export function record() {}` → block contains `record` for that pkg.
- **Re-export following:** entry `export * from "./schemas"`, `schemas.d.ts` has `export function partialRecord()` → `partialRecord` appears (depth-1 reach).
- **`.d.cts` + exports["."]:** `{"exports":{".":{"types":"./index.d.cts"}}}` resolved; its exports listed.
- **Used-binding member extraction (best-effort):** entry `export const z: { record(): unknown; partialRecord(): unknown }`, source `import { z } from "pkg"` → block shows `z: { record, partialRecord }`.
- **Budget:** many exports / many packages → output ≤ `budgetBytes`, truncated with `…`.
- Package missing in node_modules → that package omitted, others still rendered; overall non-throwing.
- `depSurface:false` → `collectDepSurface` not called / returns "" (no block).
- Security: a package whose `.d.ts` is a symlink out of the repo → `safeReadContained` refuses (omitted), no leak.
- `tests/unit/imports.test.ts` (extend): `importBindings` maps default/namespace/named (+ `as` alias) → package; relative/builtin skipped; empty for non-JS/TS / parse failure. `specToPackage` exported + normalizes scoped/subpath specifiers.

## Definition of Done
`bunx tsc --noEmit` + `bun run lint` clean; full `bun test --timeout 30000` green; then the dogfood gate PASS. Do NOT `bun run build`/deploy before merge + user OK (`bun run build` deploys via the dist symlink).

## Out of scope
- **Any demote / verdict change** — this is context-only (the soundness wall: a grep can't prove member-of-binding without TS type resolution).
- **Full TS type resolution** for exact member sets (best-effort member extraction only).
- **Subpath-specific surfaces** (`import { x } from "pkg/sub"`) — we inject the package ROOT surface; a names-only superset is harmless context (it never demotes, so a root export the subpath lacks can't cause a false suppression — worst case the reviewer sees a name that isn't on the subpath, a minor over-list). Note this in the header's "may still exist / verify" caveat.
- **Context7 / `contextDocs`** (the network soft mechanism) — untouched; this is the local, accurate complement.
- Non-JS/TS ecosystems; packages whose types live in a separate `@types/<pkg>` (follow-up; absence → just omitted).
