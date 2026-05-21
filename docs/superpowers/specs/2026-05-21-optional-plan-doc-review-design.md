# Optional Plan-/Doc Review — Design Spec

**Date:** 2026-05-21
**Status:** Approved (design), pending implementation plan
**Design review:** Codex design pass — initial FAIL (2 CRITICAL) resolved; this
spec folds in all CRITICAL fixes and accepted WARNs.

## Problem

Reviewgate skips doc-only diffs. In `src/triage/matrix.ts`, a diff whose files are
all `docs` (markdown/txt/rst per `src/research/diff-facts.ts`) yields
`runReview: false` → the Orchestrator passes at $0 without spawning any reviewer
(`src/core/orchestrator.ts`, the `if (!triage.runReview)` branch). Consequently
implementation plans / specs written as markdown are **never** reviewed.

Two further realities shape the design:

1. The gate reviews the **working-tree diff** (`git diff HEAD` + untracked, see
   `src/utils/git.ts`). Once a plan is committed it leaves the diff entirely.
2. `Orchestrator.runIteration()` **always** recomputes `computeDiffFacts` and
   `triageFromFacts`. Feeding a synthetic diff alone does not bypass the skip —
   the orchestrator needs an explicit override (see Decision 2).

## Goal

Optionally review plan/spec markdown, **opt-in, default off, zero behavior change**
for existing repos. Two entry points:

- **Auto path** (Stop-hook, uncommitted plans): doc-only diffs matching configured
  globs are reviewed instead of skipped, blocking the turn on FAIL like code.
- **Explicit CLI** (`reviewgate review-plan <file...>`): review any plan file
  (committed or not), one-shot, no block loop — usable manually or in CI.

## Non-Goals

- Reviewing **mixed** code+doc diffs with the plan persona. Mixed diffs keep the
  current code path (security/code persona sees the whole diff, markdown rides
  along). Only **doc-only** diffs use the new path. (Known limitation, see below.)
- Per-glob persona mapping. One `docReview.persona` for all matched docs (YAGNI).
- Making `loopCap` per-risk-class enforceable (it is currently advisory only — see
  Decision 4).

## Configuration

New isolated block in `src/config/defaults.ts`, default **off**:

```ts
docReview: {
  enabled: false,                 // off = today's doc-skip, no behavior change
  globs: [                        // which markdown counts as a reviewable plan
    "docs/superpowers/specs/**",
    "docs/**/plan*.md",
    "docs/**/*spec*.md",
  ],
  persona: "plan",                // persona file under .reviewgate/personas/
}
```

- Added to the validated config type in `src/config/define-config.ts` so it is part
  of the config hash. Enabling `docReview` or changing `persona` therefore
  invalidates pass-cache entries (cache key = diff + full config hash).
- Glob matching uses the built-in **`Bun.Glob`** (`new Bun.Glob(pattern).match(path)`)
  — no new dependency. Paths are matched repo-relative (as emitted by
  `diff-facts.ts`).
- An invalid/unparsable glob is skipped with a `console.warn`; matching fails open
  to "no match" (→ skip), never crashes the gate.

## Design Decisions (resolving the Codex design review)

### Decision 1 — Persona override is explicit, not smuggled through triage metadata

`refineTriage` preserves only known triage fields and the Orchestrator always uses
`config.phases.review.reviewers[*].persona`. So the override is made explicit at
**two well-defined points**:

- **Triage signal:** add a new `RiskClass` value `"docs"` (and a matching
  `budgetTier`) in `src/schemas/triage.ts`. The doc-review branch in `matrix.ts`
  sets `riskClass: "docs"`, `runReview: true`.
- **Orchestrator resolution:** when `triage.riskClass === "docs"` **or** an explicit
  `forcePersona` input is set, the Orchestrator overrides the persona of its single
  reviewer to `config.docReview.persona`. Provider stays the one configured in
  `phases.review.reviewers` (e.g. codex/oauth) — only the persona changes.

Resolution precedence in the Orchestrator:

```
const docPersona =
  forcePersona ??                                      // CLI one-shot
  (triage.riskClass === "docs" ? cfg.docReview.persona // auto path
                               : null);
// if docPersona set → run exactly one reviewer with persona = docPersona
```

### Decision 2 — CLI bypasses triage via an explicit Orchestrator input

`runIteration()` recomputes triage unconditionally, so a markdown-only synthetic
diff would still hit `runReview:false`. The Orchestrator gains an optional input
**`forcePersona?: string`**. When set, the Orchestrator:

- skips the doc-only/`runReview:false` short-circuit (review is forced), and
- uses `forcePersona` as the single reviewer's persona.

This same mechanism cleanly serves both entry points (auto = `riskClass:"docs"`,
CLI = `forcePersona`).

### Decision 3 — `plan` persona + reaffirm + generalized preamble

- New file `.reviewgate/personas/plan.md`. Criteria: completeness, internal
  contradictions, missing edge cases, verifiability/testability, unrealistic
  assumptions, missing migration/rollback, wrong file/symbol references.
- Add a `PERSONA_REAFFIRM["plan"]` entry in `orchestrator.ts`. **Required** —
  the default reaffirm wraps prose in hostile security-auditor instructions
  otherwise.
- The review prompt preamble (`REVIEW_PROMPT_PREAMBLE`) currently says "code diff".
  The Orchestrator selects a **doc-oriented preamble** when the resolved persona is
  the doc persona (i.e. when `docPersona` is set per Decision 1), so plan reviews are
  framed as plan review, not code review. The code preamble is unchanged for all
  other runs.

### Decision 4 — Loop semantics

- **Auto path:** FAIL blocks the turn exactly like code findings — the existing
  decisions loop (`pending.md` → `.reviewgate/decisions/<iter>.jsonl` → re-review)
  applies unchanged. Bounded by the global `config.loop.maxIterations` and the
  stuck/escalation logic in `LoopDriver`. `loopCap` is **not** set per risk class
  (it is advisory only and not enforced by `LoopDriver`).
- **CLI path:** one-shot. No turn to block. Writes a report, prints findings, exits
  `0` (PASS) / non-zero (FAIL). Does **not** participate in the decisions loop.

### Decision 5 — CLI diff synthesis hardening

`reviewgate review-plan <file...>`:

- Normalize each input path to **repo-relative** before diffing. Absolute paths
  make `git diff --no-index` emit `b/Users/...` headers → non-repo-relative
  findings and broken symbol/research paths.
- Synthesize the diff via `git diff --no-index /dev/null <relpath>`. Treat **exit
  code 1 as success-with-differences** (always true for a full new-file diff), as
  `src/utils/git.ts` already does for untracked files.
- Reject binary files with a clear error (no meaningful prose review).
- Missing file → clear error, exit non-zero.

### Decision 6 — One-shot report mode

The report renderer (`src/core/report-writer.ts`) always emits "Required actions"
and decisions-loop instructions in `pending.md`, which are misleading for a
one-shot CLI run. The writer gains a **`mode: "gate" | "one-shot"`** parameter
(default `"gate"`, preserving current output). In `"one-shot"` mode it omits the
decisions-loop / "Required actions" instructions and renders findings only. The
`review-plan` CLI uses `"one-shot"` and prints the findings to stdout; it must not
instruct the user to append decision JSONL.

## Scope cut & known limitation

Mixed code+doc diffs are intentionally unchanged: a spec edited in the same diff as
its implementation is reviewed by the code/security persona (markdown rides along
in the diff), **not** the plan persona. This keeps the change to a single new code
path (doc-only) and avoids multi-persona-per-file complexity. Default globs are
kept broad-ish (`plan*.md`, `*spec*.md`) to catch common plan locations on the
auto path; anything else can be reviewed explicitly via `review-plan`.

## Touched files

- `src/config/defaults.ts` — new `docReview` block (default off)
- `src/config/define-config.ts` — `docReview` in the validated config type
- `src/schemas/triage.ts` — `RiskClass` gains `"docs"`, matching `budgetTier`
- `src/triage/matrix.ts` — doc-only branch: glob match → `riskClass:"docs"`,
  `runReview:true`; else skip as today
- `src/triage/triage-engine.ts` — ensure the `"docs"` class survives `refineTriage`
- `src/core/orchestrator.ts` — `forcePersona` input; persona resolution (Decision
  1); `PERSONA_REAFFIRM["plan"]`; generalized preamble
- `src/core/report-writer.ts` — one-shot report mode (Decision 6)
- `src/cli/index.ts` — register `review-plan` subcommand
- `src/cli/commands/review-plan.ts` — **new**; path normalization, diff synthesis,
  one-shot orchestrator run, exit codes
- `.reviewgate/personas/plan.md` — **new**

## Error handling

- Invalid glob → `console.warn`, treated as no match (fail-open to skip), no crash.
- `review-plan` missing/binary file → clear error, non-zero exit.
- `git diff --no-index` exit 1 → success-with-differences (not an error).
- Reviewer error → fail-closed `ERROR` verdict, identical to the existing path.

## Testing (`bun test`)

- **matrix:** `enabled` + glob match → `runReview:true`, `riskClass:"docs"`;
  `enabled` + no match → skip; `disabled` → skip (regression guard).
- **glob unit:** `docs/superpowers/specs/x.md` matches; `README.md` does not;
  invalid glob fails open.
- **orchestrator:** `forcePersona` forces review on a doc-only diff and uses the
  given persona; `riskClass:"docs"` overrides persona from `config.docReview.persona`.
- **review-plan CLI:** path normalization (absolute → repo-relative), diff synthesis
  parses through `diff-facts.ts`, PASS/FAIL exit codes, missing-file error, binary
  rejection.
- **schema:** `RiskClass:"docs"` validates; config with `docReview` validates.
- **Real end-to-end (no mocks):** `reviewgate review-plan` against a real sample
  spec with the real codex reviewer — must produce a real verdict. (Per project
  rule: real CLI/API verification, not fakes.)
