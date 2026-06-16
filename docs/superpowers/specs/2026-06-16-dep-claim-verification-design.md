# Dependency-Claim Verification — Design

**Date:** 2026-06-16
**Status:** Approved (design), pending implementation plan
**Source:** flashbuddy field report, recommendation #3 ("ground claims against the installed dependency version"). The trust-killing FP: a reviewer flagged `z.partialRecord` / `z.record(userId)` as an invalid/non-existent zod API at high confidence, when the symbol exists in the installed `zod`. The existing Context7 docs injection (soft, network, opt-in) "didn't catch zod", and S6 grounding is *absence*-based (it demotes INVENTED tokens absent from the corpus) so it structurally cannot catch this — `z.partialRecord` IS present in the diff; the reviewer merely claims it is invalid.

## Approach (chosen)

A new **deterministic, local, demote-only + fail-safe** grounding-family pass: when a finding asserts that an imported dependency symbol **does not exist / is not a valid member**, verify the symbol against the **installed package's type definitions** in `node_modules`. If the symbol provably exists there, the "doesn't exist" claim is fabricated → demote. Any uncertainty → leave the finding blocking. No LLM, no network (unlike Context7).

This is the same family as `fact-check` (`validateFindingFacts` — file:line existence) and `groundFindings` (corpus token presence): deterministic, runs before critic+aggregate so the softened severity flows through, demote-only, fail-safe.

## Architecture

### New: `src/research/imports.ts` — export `importBindings`

`treeSitterSpecifiers` already parses import SOURCES but not the local bindings. Add a sibling that maps each local binding to its package:

```ts
/** Local import bindings → package name for one JS/TS file, e.g. { z: "zod", redis: "ioredis" }.
 *  Covers default (`import z from "zod"`), namespace (`import * as z from "zod"`), and named
 *  (`import { z } from "zod"`) imports. Relative/builtin sources are skipped. Reuses the
 *  tree-sitter parser (getLanguage/grammarForFile); [] / empty map for non-JS/TS or parse failure. */
export async function importBindings(repoRoot: string, file: string): Promise<Map<string, string>>;
```

Walk each `import_statement`: take its `source` (→ `specToPackage()` for the package name, reusing the existing helper; skip relative/builtin), and its `import_clause` children — `identifier` (default), `namespace_import` (`* as ns` → the `ns` identifier), `named_imports` (each `import_specifier`'s local name, honoring `as` aliases). Map every local name → the package. (Regex fallback is NOT added here — binding parsing needs the AST; a parse failure yields an empty map → fail-safe no-demote.)

### New: `src/core/dep-verify.ts` — the demote pass

```ts
export async function verifyDepClaims(
  findings: Finding[],
  repoRoot: string,
  signal?: AbortSignal,
): Promise<Finding[]>;
```

Demote-only, fail-safe. For each finding (only CRITICAL/WARN — INFO needs no demote):

1. **Claim detection** over `message` ∪ `details`:
   - A **non-existence assertion** matches `NONEXISTENCE_RE` (case-insensitive, tight):
     `does(n'?t| not) exist | no such | not a valid (method|function|property|export|member|option) | is not a (function|method|property|export|member) | unknown (method|property|option) | not exported (from|by) | no \w+ (method|property)`.
   - AND a **`binding.member`** token: regex `\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\b`. Wrong-USAGE claims (e.g. "set takes 2 args, TTL missing") do NOT match `NONEXISTENCE_RE` → left blocking (verifying `set` exists wouldn't refute an args claim).
   - **Proximity link (precision):** only a `binding.member` token whose `member` appears **within 40 characters of a `NONEXISTENCE_RE` match** (in the same field) is a candidate — so the verified symbol is the one the non-existence claim is ABOUT. This stops a finding that asserts a DIFFERENT (truly-absent) symbol doesn't exist while *incidentally* mentioning a present `y.z` from being wrongly demoted on `y.z`.
   - If no non-existence assertion, or no `binding.member` token linked to it by proximity → skip (leave finding unchanged).
2. **Resolve binding → package** via `importBindings(repoRoot, f.file)`. If `binding` isn't a known import (or `f.file` isn't JS/TS / unparseable) → skip (fail-safe).
3. **Resolve the types ENTRYPOINT** under `repoRoot/node_modules/<pkg>` (NOT a blanket glob — a blanket scan proves "exists somewhere in the package", not "exists on the imported surface": e.g. installed `zod`'s v3 root does NOT export `partialRecord`, but `v4/classic/schemas.d.ts` does — scanning all files would wrongly demote a TRUE "invalid for the v3 root import" finding). Read `node_modules/<pkg>/package.json` (via `safeReadContained`) and pick the entry, in order:
   - `exports["."]` → its `types` (handle a conditional object: `exports["."].types`, or `exports["."].import/require` → their `.types`/string),
   - else `types` / `typings`,
   - else the first existing of `index.d.ts`, `index.d.cts`, `index.d.mts` (modern extensions matter — zod ships `"types":"./index.d.cts"`).
   If no entry resolves → **leave blocking** (fail-safe).
4. **Member presence on the imported surface** — search the entry `.d.ts` for the member in a **declaration position**: regex `(^|[^.\w$])<member>\s*[?(:<]` (matches `member?:`, `member(`, `member:`, `member<T>`; does NOT match `obj.member` usage). If not found in the entry, **follow the entry's re-export graph** — `export * from "./x"` and `export { <member>|… } from "./x"` (a by-name re-export of `<member>` is itself direct presence) — to bounded depth **2** and a bounded budget (≤ 30 files, ≤ 2 MB total), resolving each `./x` relative to the referencing file (try `x`, `x.d.ts`, `x.d.cts`, `x.d.mts`, `x/index.d.ts`). Only files reachable from the entry via re-exports are searched — never an unrelated subpath. Found anywhere on this reachable surface → **present**.
5. **Action:** present → **one-step demote** (CRITICAL→WARN, WARN→INFO) + `dep_verified: true` + a details note. Not found on the reachable surface / package or entry unresolvable / budget exhausted without a hit / non-JS-TS → **leave blocking** (fail-safe; never demote on uncertainty).

We ONLY demote when we POSITIVELY confirm the member exists **on the imported entry's reachable surface**. A genuinely-absent member (a TRUE "doesn't exist" finding) — or one that lives only in an unrelated subpath the root doesn't re-export (the zod-v4 case) — is never found → never demoted. The only feature-miss is a present member behind deeper-than-depth-2 re-exports → safe (leaves a fabricated finding blocking; no real finding suppressed).

### Schema / report / config / orchestrator

- `src/schemas/finding.ts`: `dep_verified?: boolean` (pattern of `scope_demoted`).
- `src/core/report-writer.ts`: `findingBadges()` entry — `🔍 cited dependency symbol exists in the installed package — "does not exist" claim refuted`.
- `src/config/define-config.ts` + `defaults.ts`: `phases.review.verifyDeps: boolean`, default `true` (demote-only + fail-safe → low downside; set false to disable).
- `src/core/orchestrator.ts`: in the grounding chain, after `groundFindings(...)` and before the optional LLM grounding judge / critic / aggregate, insert `groundedFindings = config.phases.review.verifyDeps ? await verifyDepClaims(groundedFindings, repo, opts.signal) : groundedFindings`. (It demotes; composes with the other demote-only passes.)

### Demote target rationale
One-step (CRITICAL→WARN) — NOT straight to INFO like fact-check — because the `.d.ts` declaration-regex presence heuristic is weaker than fact-check's exact line-count: a one-step demote removes the unconditional security/correctness hard-FAIL while keeping the finding decision-required if it was WARN-worthy. Conservative for a precision-sensitive suppressor.

## Testing (TDD, `bun test`, against real mini-package fixtures written to a tmp repo)

`tests/unit/dep-verify.test.ts` (write a `node_modules/<pkg>/` fixture — `package.json` + entry `.d.ts` (± re-exported sub-files) — a source file importing it, and findings):
- **Entry declares it:** fixture `pkg` with `package.json {"types":"./index.d.ts"}`, `index.d.ts` containing `partialRecord(`; `import { z } from "pkg"`; finding `"z.partialRecord is not a valid method"` → **demoted to WARN**, `dep_verified:true`.
- **Re-export following:** entry `index.d.ts` is `export * from "./schemas"`, `schemas.d.ts` has `partialRecord(` → **demoted** (depth-1 re-export reached). And `export { partialRecord } from "./schemas"` (by-name) → **demoted**.
- **WARN-1 regression — member only in an UNRELATED subpath the entry does NOT re-export** (`index.d.ts` exports v3 surface; `v4/schemas.d.ts` has `partialRecord(` but is not re-exported from the entry) → **stays CRITICAL** (we must not "prove" presence from an unreachable subpath).
- **`.d.cts` / exports resolution:** `package.json {"exports":{".":{"types":"./index.d.cts"}}}`, `index.d.cts` has the member → resolved + **demoted** (modern extension + exports["."] honored).
- Member ABSENT from the entry + its reachable re-exports (true "doesn't exist") → **stays CRITICAL**.
- Non-existence claim but `binding` not imported in `f.file` → **stays** (fail-safe).
- `binding.member` token but NO non-existence keyword ("z.partialRecord is the wrong validator here") → **stays**.
- Member appears only as `.member` usage in the `.d.ts`, never as a declaration → **stays** (regex excludes `.member`).
- Incidental present `y.z` token far (>40 chars) from the non-existence phrase about an absent `x.q` → **stays** (proximity link).
- Package dir missing in node_modules → **stays** (fail-safe).
- `import * as z from "pkg"` and `import z from "pkg"` both resolve `z`→pkg.
- `verifyDeps:false` → no-op.
- `tests/unit/imports.test.ts` (extend): `importBindings` maps default/namespace/named (incl. `as` alias) bindings → package; skips relative/builtin; empty map for non-JS/TS or parse failure.

Implementation note: `specToPackage` is currently module-private in `imports.ts`; export it (or have `importBindings` apply the same scoped-package normalization internally) so the dep-verify resolution maps a binding's source (`"zod"`, `"zod/v4"`, `"@scope/x"`) to its `node_modules/<pkg>` dir.

## Definition of Done
`bunx tsc --noEmit` + `bun run lint` clean; full `bun test --timeout 30000` green; then the dogfood gate PASS. Do NOT `bun run build`/deploy before merge + user OK (it deploys via the dist symlink).

## Out of scope
- **Wrong-usage / arg-count / signature claims** (only non-existence/invalid-member). Verifying a symbol exists cannot refute "you called it wrong".
- **semver range resolution** — we verify the *installed* `.d.ts` (ground truth on disk), not the declared range.
- **Bare named-import symbol claims** (`import { foo }` then "foo doesn't exist") — only `binding.member` (the dot anchors it to a package member; bare identifiers over-match). Possible follow-up.
- **Non-JS/TS** ecosystems; **Context7/contextDocs** (separate soft mechanism, untouched).
- Packages whose types live outside the package dir (e.g. a separate `@types/<pkg>`) — a follow-up; absence → fail-safe leave-blocking, no false demote.
