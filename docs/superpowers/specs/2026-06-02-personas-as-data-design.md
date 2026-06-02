# Personas-as-data (§3.1) — Design (rev. 2)

**Status:** Approved in principle; revised after a 2-reviewer design pass that found
a CRITICAL (false no-op invariant) + WARNs. Roadmap §3.1. §3.2 deferred (YAGNI).

## Problem

Persona reaffirmation text — the per-persona instruction injected before the diff
that tells a reviewer *how* to review (e.g. "You are a hostile senior security
auditor…") — is a hardcoded inline `Record<string,string>` (`PERSONA_REAFFIRM`) in
`src/core/orchestrator.ts`. The repo ships richer `.reviewgate/personas/<id>.md`
files (`security.md`, `plan.md`) that are currently **dead** (nothing reads them).
A repo cannot tune *how* a reviewer reviews without editing Reviewgate's source.

## Goal

Make persona reaffirmation data-driven: drive it from `.reviewgate/personas/<id>.md`
files and a `reviewgate.config.ts` override, with the built-in inline map as the
fallback.

### This is an INTENDED behavior improvement, NOT a no-op (corrected from rev.1)

The shipped `.reviewgate/personas/{security,plan}.md` files **differ materially**
from the inline `PERSONA_REAFFIRM` entries (richer: a what-to-look-for checklist).
Because precedence is file > built-in, wiring them in **changes** the effective
persona prompt for repos that have those files (including this dogfood repo, whose
default reviewer is `codex:security`). This is **deliberate** — the richer files are
better persona prompts. The honest invariants are:
- **Repos WITHOUT persona files + no config override → built-in map → today's exact
  behavior** (true no-op there).
- **Repos WITH persona files → the file text becomes effective** (the improvement).

Both are locked by tests (see Testing). The spec does NOT claim a global no-op.

**Footer fix (required, part of this slice):** the shipped persona files end with
`Output ONLY a JSON object matching the schema you were given. No prose.` That line
conflicts with `REVIEW_PROMPT_PREAMBLE` (which owns the authoritative
`{verdict, findings[…], memory_proposals}` output contract) and could suppress
`memory_proposals` or confuse strict-schema providers (codex/openrouter). The
reaffirmation slot is about reviewer STANCE / what-to-look-for, NOT output format.
→ Strip the output-format footer from `.reviewgate/personas/*.md` (and any
`src/personas/*` template if present) as part of this change.

**Non-goal:** §3.2 thresholds-as-config.

## Precedence (highest first)

For a persona `id`, the effective reaffirmation text is the first that exists:
1. `config.phases.review.personas[id]` — inline override in `reviewgate.config.ts`.
2. `.reviewgate/personas/<id>.md` — whole file content, trimmed (size-capped).
3. Built-in `PERSONA_REAFFIRM[id]` — the current inline map.
4. Neutral `DEFAULT_REAFFIRM` for an unknown persona, with one `console.warn`.

## Keyspace (bounded — corrected from rev.1)

`resolvePersonas` resolves ONLY the persona ids actually in use this run, NOT every
`*.md` in the dir. The in-use set = (every reviewer slot's persona in
`config.phases.review.reviewers`) ∪ `config.docReview.persona` ∪ any `forcePersona`
passed to the run. For each in-use id, look up the file `<id>.md` by exact name.
This avoids phantom personas from stray files, unbounded keyspace, and macOS
case-folding collisions (we look up known ids, not enumerate the dir). An in-use id
with no file/override falls to the built-in/neutral default; a persona FILE that
matches no in-use id is ignored (optionally `console.warn`'d as unreferenced).

## Architecture

### Components

**`src/core/personas.ts`** (new — moves persona logic out of orchestrator):
- `PERSONA_REAFFIRM` (built-in map) + `DEFAULT_REAFFIRM` — relocated verbatim from
  `orchestrator.ts`.
- `resolvePersonas(repoRoot, inUse: string[], configPersonas?): Record<string,string>`
  — for each id in `inUse`: pick config override, else read
  `.reviewgate/personas/<id>.md` (≤ `PERSONA_FILE_CAP` bytes, e.g. 8000;
  `neutralizeInjectionMarkers(content.trim())`), else built-in, else neutral
  default. Whitespace-only file → treated as absent. Best-effort per id: a read
  error falls through (never throws). Returns the resolved map (keys = inUse).
- `reaffirmFor(persona, personas): string` — `personas[persona] ?? (warn +
  DEFAULT_REAFFIRM)`. Replaces the orchestrator-local one. Keeps the existing
  unknown-persona `console.warn`.

**`src/core/orchestrator.ts`** (modify):
- Import from `personas.ts`; drop the inline map.
- Compute `inUse` = reviewer personas ∪ `docPersona` (the `docReview.persona`/
  `forcePersona` value already resolved earlier in `runIteration`).
- Call `resolvePersonas(repo, inUse, config.phases.review.personas)` ONCE, **before
  `computeBehaviorHash`** (~orchestrator.ts:550), so the resolved text can feed the
  cache key. The reviewer panel loop then consumes the already-resolved map via
  `reaffirmFor(persona, personas)`.

**`src/config/define-config.ts`** (modify):
- `phases.review` gains `personas: z.record(z.string(), z.string()).optional()`.

**`src/cache/behavior-hash.ts`** (modify — ordering + continuity critical):
- Add a persona segment that contributes ONLY the **delta from built-ins**: the
  subset of the resolved map whose text differs from `PERSONA_REAFFIRM` (i.e. came
  from a file). Empty delta → append nothing (preserves the module's byte-identical
  continuity rule, like the `fp`/`docs`/`refs` segments → no global cache wipe on
  upgrade for file-less repos). The config-override path is already covered by the
  existing `configHash` (full config is hashed at orchestrator.ts:~569), so it must
  NOT be double-folded here — only the FILE contribution is the gap this closes.
- The orchestrator passes the resolved map (or the precomputed delta) into
  `computeBehaviorHash`; this is why `resolvePersonas` must run before it.

**`.reviewgate/personas/security.md` + `plan.md`** (edit): strip the trailing
`Output ONLY a JSON object…` footer (see Footer fix above).

### Security

Persona text lands in the TRUSTED prompt section (before the untrusted-diff fence);
a committer could embed `[INST]`/`### Instruction:` tokens in a persona file.
`resolvePersonas` applies `neutralizeInjectionMarkers` to every file/override value,
AND caps the read at `PERSONA_FILE_CAP` bytes so an oversized committed file can't
bloat the prompt. (Config override is trusted code, but sanitized for symmetry —
defense-in-depth, not a security boundary.)

### Error handling

- Missing personas dir / unreadable / empty / oversized file → fall through to the
  next precedence source. `resolvePersonas` NEVER throws.
- Unknown persona at lookup → neutral `DEFAULT_REAFFIRM` + one `console.warn`.
- Runs in the gate (parent) process — NOT sandboxed; the small synchronous read sits
  alongside existing pre-panel reads (conventions, research) — negligible hot-path cost.

## Testing (TDD)

1. **No-op for file-less repos** (`personas.test.ts`): `resolvePersonas(tmpdirWithNoPersonas, ["security","plan"])` === the built-in `PERSONA_REAFFIRM` entries. (Uses a temp dir, NOT the repo root, so the shipped files don't leak in.)
2. **Precedence:** config override > file > built-in for the same id; an id present only as a file → file text; only built-in → built-in text.
3. **Effective-text lock (intended change):** a temp `.reviewgate/personas/security.md` with known richer text → resolved `security` === that text (not the built-in). Locks the deliberate behavior change.
4. **Security:** a persona file with `[INST]`/`### Instruction:` → resolved text has them neutralized; an oversized file (> cap) is ignored (falls to built-in).
5. **Keyspace:** only in-use ids are resolved; a stray `notes.md` is NOT in the map; a missing file for an in-use id → built-in/neutral; unknown persona → neutral default (no throw).
6. **Cache freshness + continuity:** changing an in-use persona file's text changes the behavior-hash input; with NO files/override the persona segment is empty (behavior-hash byte-identical to pre-feature for a brain-less/file-less run).
7. **Footer:** the shipped `.reviewgate/personas/{security,plan}.md` no longer contain the `Output ONLY a JSON object` footer (guards the fix).

## Implementation notes (from the 2-reviewer pass — both PASS on rev.2)

- **Delta comparison is on RESOLVED text.** The behavior-hash persona delta compares
  the *resolved* (sanitized + trimmed) text against the built-in `PERSONA_REAFFIRM`
  value, NOT the raw file bytes — so a file identical to the built-in except trailing
  whitespace correctly yields an empty delta.
- **`inUse` uses the already-resolved `docPersona`.** Build the in-use set from the
  same `docPersona` value the panel keys on (`docPersona ?? r.persona`, resolved at
  ~orchestrator.ts:390 before the behavior-hash), NOT the raw `docReview.persona` —
  else a doc review could fall back to the built-in when a file exists.
- **Unreferenced-file warn fires at most once per run** (avoid log spam).

## Files

- Create: `src/core/personas.ts`, `tests/unit/personas.test.ts`
- Modify: `src/core/orchestrator.ts` (resolve before behavior-hash; consume map; drop inline map),
  `src/config/define-config.ts` (`phases.review.personas`),
  `src/cache/behavior-hash.ts` (delta-from-built-ins persona segment),
  `.reviewgate/personas/security.md` + `plan.md` (strip footer),
  `tests/unit/orchestrator-persona-reaffirm.test.ts` (new `reaffirmFor(persona, map)` signature; build the map via `resolvePersonas` on a no-persona temp dir).
