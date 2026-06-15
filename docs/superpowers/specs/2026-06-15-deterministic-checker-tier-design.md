# Deterministic Checker Tier — Design

**Date:** 2026-06-15 · **Status:** approved (design) · **Reviewed by:** gemini/agy (design review, found + fixed the loop-accounting fail-open)

## Problem

Reviewgate's gate is purely semantic: the LLM reviewer panel reasons about the diff
but **never runs `tsc` / build / tests**. Field reports and the 2026-06-15 audit's
GTM analysis both flag the consequence — "plausible-but-broken" changes (compile
errors, failing tests) pass the panel green. The single strongest *testable
termination condition* of an agentic loop ("it compiles and the tests pass") is the
one thing the verification loop does not enforce.

## Goals

- Run repo-configured deterministic commands (typecheck/build/test/…) as a cheap,
  $0, fast **first gate before the LLM panel**.
- A failing check **blocks the turn** with the real command output, and **skips the
  LLM panel** (no point reviewing — or paying for — code that does not compile).
- Integrate with the existing loop (decisions, fix-verification, escalation) without
  breaking its accounting or opening a fail-open.

## Non-goals (YAGNI v1)

Auto-detection of commands; parallel execution; run-all-and-report-all (we fail-fast);
caching of check results; per-finding "reject" of a check failure; `doctor`/`setup`
auto-suggestion of detected scripts.

## Behavior — fail-fast short-circuit

A new pipeline stage runs **after triage decides a review is needed** and **before
the cache read, research, and the reviewer panel**. Commands run in listed order
(convention: cheap → expensive). The **first** check that exits non-zero (or times
out / errors) produces a blocking finding, the stage returns `verdict: "FAIL"`
immediately, and the **panel is skipped**. If every check passes, the pipeline
continues unchanged into cache/research/panel.

## Configuration

New `phases.checks` block — nullable, **default `null` (off)**, so an un-configured
repo keeps today's behavior. Added to `ConfigSchema` in `src/config/define-config.ts`
and to `defaults.ts` (default null; when present, `defaultTimeoutMs` / `outputCapBytes`
fall back to defaults via deep-merge).

```ts
checks: {
  commands: [
    { name: "typecheck", run: "bun run typecheck", timeoutMs: 120_000 },
    { name: "test",      run: "bun test",          timeoutMs: 300_000 },
  ],
  // optional, with defaults from defaults.ts:
  defaultTimeoutMs: 300_000,
  outputCapBytes:   16_384,
}
```

zod shape: `commands` is `z.array(z.object({ name: z.string().min(1), run:
z.string().min(1), timeoutMs: z.number().int().positive().optional() })).min(1)`;
`defaultTimeoutMs` / `outputCapBytes` optional positive ints. Malformed configs
(missing `name`/`run`, non-positive `timeoutMs`) are rejected at config-load time.

## Failure model — decidable, reject-forbidden (resolves the loop-accounting fail-open)

> The original design made check failures *non-decidable* and kept them OUT of
> `pending.json`. The gemini design review showed this breaks `LoopDriver`: with an
> empty `requiredIds`, the decisions gate is vacuously satisfied, the iteration
> counter advances every turn, and at the cap it ESCALATES — unlinking the dirty flag
> and **allowing the stop with the build still broken (fail-open)**. The fix is to
> ride the existing finding/decision machinery:

A check failure is rendered as a **normal blocking finding** in `pending.json`
(severity `CRITICAL`, category `build` or `test`) with:

- A **stable per-check signature** `check:<name>` (NOT derived from the volatile error
  text), so a still-failing check on re-review is the *same* finding — the existing
  Fix-Verification §4.3 ("claimed-fixed but recurs → force-FAIL") and signature dedup
  apply unchanged.
- A new optional finding flag **`deterministic: true`** (added to the finding /
  pending-report schema).

The finding therefore appears in `requiredIds` and flows through the normal loop:
`LoopDriver` blocks, the agent must address it, and re-review re-runs the check.

**Reject-forbidden:** you cannot "reject" a compiler. `evaluateDecisions` in
`loop-driver.ts` treats a `verdict:"rejected"` decision for a `deterministic` finding
as **invalid** (the finding stays unaddressed → keeps blocking). The only valid
decision is `accepted`/`fixed`, and "fixed" is *verified by the check passing on
re-review*, not by trusting the decision (claimed-fixed + still-red ⇒ force-FAIL).

**Escape hatch:** the human curates the command list in config (remove/scope a check).
There is no per-finding bypass. A genuinely unfixable check still escalates after the
existing `maxIterations` cap — the same human-checkpoint as any stuck FAIL, surfaced
via `ESCALATION.md` (NOT a silent fail-open).

## Pipeline integration

In `Orchestrator.runIteration` (`src/core/orchestrator.ts`), insert the checks stage
**immediately after the triage skip-PASS block (~line 503) and before the cache
pin/read and research**:

```
triage → [NEW: deterministic checks] → cache read → research → reviewer panel → critic → aggregate → report
```

Ordering rationale (from the review):
- **Before the cache read:** a cached LLM `PASS` keyed on the diff text must NOT skip
  the checks — the build depends on the whole working tree + env, not just the diff, so
  a cache hit could otherwise allow-stop on a broken tree (fail-open).
- **Before research:** Context7 docs / embeddings / symbol-graph / conventions are
  wasted cost + latency if the build is red.

On all-pass the stage is a no-op pass-through; on first failure it writes the report
and returns `{ verdict: "FAIL", source: "checks", findings: [<deterministic>] }`.

## Execution

A new runner module `src/core/checks/runner.ts`:

- Runs each command via `spawnSafely` (`src/utils/spawn.ts`) in the repo `cwd`,
  **unsandboxed** (see Security), via a shell so the `run` string works as written.
- **No sandbox profile** is passed (unlike reviewer spawns).
- **Per-check timeout** = `command.timeoutMs ?? checks.defaultTimeoutMs`.
- The iteration's **`AbortSignal` is propagated** into `spawnSafely`, so the gate
  self-deadline (`loop.runTimeoutMs`) can kill a hung check rather than overrun.
- **Output capped** at `outputCapBytes` via `spawnSafely`'s existing `maxOutputBytes`
  (prefix-capture + `outputTruncated`); the rendered block notes truncation.
- **Exit-code semantics (fail-closed):** exit `0` ⇒ pass; any non-zero (incl. `127`
  command-not-found), timeout, or kill ⇒ **FAIL** for that check. A check that cannot
  run is a FAIL, never a silent skip.
- **Fail-fast:** stop at the first failing check; do not run the rest.

## Report rendering

`report-writer.ts` renders a distinct **"Deterministic checks"** section in
`pending.md` showing the failing check `name`, the command, exit status, and the
captured (capped) combined output, plus a line stating these are non-rejectable and
resolved by fixing the build. The corresponding `deterministic` finding(s) go into
`pending.json` (so the loop and `evaluateDecisions` see them).

## Caching

Check results are **not cached** — they depend on the whole working tree + environment,
not just the diff text, so a diff-keyed cache could serve a stale "pass". They are
cheap and local; run fresh every iteration. The LLM panel's verdict cache is unchanged;
note that a checks-FAIL short-circuit writes **no** panel-cache entry (correct — the
panel never ran).

## Security

The check commands are the **user's own config** — the same trust level as
`reviewgate.config.ts`, which Reviewgate already executes as code. This is distinct
from reviewer subprocesses, which ingest the *untrusted* diff and are therefore
sandboxed. Checks need full filesystem access (build artifacts, test runners), so they
run **unsandboxed** in the repo cwd.

Documented residual (INFO): because checks run unsandboxed at hook time, code the agent
*wrote in the diff* (e.g. a test that shells out to `rm -rf`) executes unsandboxed —
the same trust level as "running your own tests." Concurrency is safe: checks run inside
`runIteration`, already serialized under the global flock gate lock.

## Triage interaction

Checks run exactly when the panel would run — i.e. after triage returns `runReview`.
Doc-only / trivial diffs that triage skips also skip the checks (a README change can't
break the build). No new triage logic.

## Testing strategy

- **Unit — runner:** fake commands (`true` / `false` / `sleep`) assert pass, non-zero
  FAIL, timeout→FAIL, command-not-found(127)→FAIL, output capping, fail-fast (second
  command not run after first fails), AbortSignal kill.
- **Unit — config:** `ConfigSchema` accepts a valid `checks` block and rejects malformed
  ones (missing `name`/`run`, bad `timeoutMs`).
- **Unit — orchestrator integration:** a failing check returns `verdict:"FAIL"` with a
  `deterministic` finding and the panel adapter is **never invoked** (short-circuit);
  an all-pass run invokes the panel as today; checks run before the cache read (a prior
  cached PASS does not skip a now-failing check).
- **Unit — loop-driver:** a `deterministic` finding is in `requiredIds`; a `rejected`
  decision for it is invalid (stays blocking); an `accepted/fixed` decision + a still-red
  re-run force-FAILs (fix-verification); the loop does not infinite-loop and terminates
  via the normal escalation cap.
- **Real e2e:** `bun run typecheck` as a configured check in the dogfood repo — green
  passes through to the panel; an injected type error blocks with the tsc output.

## Files touched (estimate)

- `src/config/define-config.ts`, `src/config/defaults.ts` — `phases.checks` schema + defaults
- `src/core/checks/runner.ts` (new) — the command runner
- `src/core/orchestrator.ts` — insert the stage in `runIteration` (after triage, before cache/research)
- `src/schemas/finding.ts` and/or `src/schemas/pending-report.ts` — `deterministic` flag
- `src/core/loop-driver.ts` — `evaluateDecisions`: reject-forbidden for `deterministic` findings
- `src/core/report-writer.ts` — render the "Deterministic checks" section
- `src/diff/signature.ts` (or inline) — stable `check:<name>` signature
- `tests/unit/…`, `tests/e2e/…`

## Risks / verification

- The loop-accounting correctness (no infinite loop, no fail-open) is the load-bearing
  assumption — the loop-driver unit tests above are mandatory, not optional.
- `spawnSafely` must already support: a shell command string, an injected `AbortSignal`,
  and `maxOutputBytes`. The plan's first task verifies/extends these before the runner is
  built (the audit added `maxOutputBytes`; confirm the shell + abort path).
