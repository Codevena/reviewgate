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
3. **Resolve the package's type surface** under `repoRoot/node_modules/<pkg>`:
   - Read `node_modules/<pkg>/package.json` (via `safeReadContained`) → `types`/`typings` field; else try `index.d.ts`, `dist/index.d.ts`, `lib/index.d.ts`.
   - Collect `.d.ts` files in the package dir via `Bun.Glob("**/*.d.ts")`, capped (≤ 50 files, ≤ 2 MB total read) to bound work and survive re-exports. All reads via `safeReadContained` (node_modules is UNDER repoRoot → stays contained; symlink/size guards apply).
4. **Member presence** — the member appears in a **declaration position** in any collected `.d.ts`: regex `(^|[^.\w$])<member>\s*[?(:<]` (matches `member?:`, `member(`, `member:`, `member<T>`; does NOT match `obj.member` usage). Found in any → present.
5. **Action:** present → **one-step demote** (CRITICAL→WARN, WARN→INFO) + `dep_verified: true` + a details note. Not present / package unresolvable / no `.d.ts` / cap exhausted without a hit / non-JS-TS → **leave blocking** (fail-safe; never demote on uncertainty).

We ONLY demote when we POSITIVELY confirm the member exists. A genuinely-absent member (a TRUE "doesn't exist" finding) is never found → never demoted. The only feature-miss is a present-but-too-deep member we don't reach within the caps → safe (leaves a fabricated finding blocking; no real finding suppressed).

### Schema / report / config / orchestrator

- `src/schemas/finding.ts`: `dep_verified?: boolean` (pattern of `scope_demoted`).
- `src/core/report-writer.ts`: `findingBadges()` entry — `🔍 cited dependency symbol exists in the installed package — "does not exist" claim refuted`.
- `src/config/define-config.ts` + `defaults.ts`: `phases.review.verifyDeps: boolean`, default `true` (demote-only + fail-safe → low downside; set false to disable).
- `src/core/orchestrator.ts`: in the grounding chain, after `groundFindings(...)` and before the optional LLM grounding judge / critic / aggregate, insert `groundedFindings = config.phases.review.verifyDeps ? await verifyDepClaims(groundedFindings, repo, opts.signal) : groundedFindings`. (It demotes; composes with the other demote-only passes.)

### Demote target rationale
One-step (CRITICAL→WARN) — NOT straight to INFO like fact-check — because the `.d.ts` declaration-regex presence heuristic is weaker than fact-check's exact line-count: a one-step demote removes the unconditional security/correctness hard-FAIL while keeping the finding decision-required if it was WARN-worthy. Conservative for a precision-sensitive suppressor.

## Testing (TDD, `bun test`, against real mini-package fixtures written to a tmp repo)

`tests/unit/dep-verify.test.ts` (write a `node_modules/<pkg>/` fixture with a `package.json` + `.d.ts`, a source file importing it, and findings):
- `import { z } from "zod"` (fixture zod with `partialRecord(` in its `.d.ts`); finding `message:"z.partialRecord is not a valid method"` on that file → **demoted to WARN**, `dep_verified:true`.
- Member ABSENT from the fixture `.d.ts` (true "doesn't exist") → **stays CRITICAL**.
- A non-existence claim but `binding` not imported in `f.file` → **stays** (fail-safe).
- A `binding.member` token but NO non-existence keyword (e.g. "z.partialRecord is the wrong validator here") → **stays** (only non-existence claims).
- Member appears in `.d.ts` only as `.member` usage, never as a declaration → **stays** (regex excludes `.member`).
- Package dir missing in node_modules → **stays** (fail-safe).
- Namespace import `import * as z from "zod"` and default `import z from "zod"` both resolve `z`→zod.
- `verifyDeps:false` → no-op.
- `tests/unit/imports.test.ts` (extend): `importBindings` maps default/namespace/named (incl. `as` alias) bindings → package; skips relative/builtin; empty map for non-JS/TS.

## Definition of Done
`bunx tsc --noEmit` + `bun run lint` clean; full `bun test --timeout 30000` green; then the dogfood gate PASS. Do NOT `bun run build`/deploy before merge + user OK (it deploys via the dist symlink).

## Out of scope
- **Wrong-usage / arg-count / signature claims** (only non-existence/invalid-member). Verifying a symbol exists cannot refute "you called it wrong".
- **semver range resolution** — we verify the *installed* `.d.ts` (ground truth on disk), not the declared range.
- **Bare named-import symbol claims** (`import { foo }` then "foo doesn't exist") — only `binding.member` (the dot anchors it to a package member; bare identifiers over-match). Possible follow-up.
- **Non-JS/TS** ecosystems; **Context7/contextDocs** (separate soft mechanism, untouched).
- Packages whose types live outside the package dir (e.g. a separate `@types/<pkg>`) — a follow-up; absence → fail-safe leave-blocking, no false demote.
