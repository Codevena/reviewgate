# Slice 1 — Codex Reviewer Stability (no false escalations from a flickering reviewer)

**Date:** 2026-05-27
**Status:** Design (approved) → ready for implementation plan
**Part of:** "Reviewgate ohne false flags" initiative (4 slices). This is Slice 1.
**Locus:** `src/providers/codex.ts` (`review()`).

## Problem (root cause — confirmed by evidence)

In a live flashbuddy run (2026-05-27, run `01KSMD0…`) the reviewer panel diverged
across iterations (CRITICAL 1 → 2 → 4) and hit max-iterations → `ESCALATION`.
One driver of that divergence was the **codex reviewer flickering between `ok`
and `error`** between iterations, which changes the finding/signature set each
round and prevents convergence.

Root cause, confirmed by reading codex's own session rollouts
(`~/.codex/sessions/2026/05/27/rollout-…T11-58-34….jsonl` and `…T12-07-20….jsonl`,
the two errored runs) and comparing against a successful run (`…T12-19-03…`):

- The `CodexAdapter` invokes `codex exec --sandbox read-only --output-schema …`.
  codex runs **agentically** and uses `exec_command` shell tool-calls to explore
  the repo (verifying file/symbol references in the reviewed plan/diff).
- On the errored runs codex made **21 and 25** `exec_command` calls and the turn
  **ended after a tool call without ever emitting the final `agent_message`** —
  no `task_complete`, **no error event, no abort, no rate-limit**. `last.md`
  (the `--output-last-message` target) was therefore empty / not parseable.
- The adapter correctly classifies "exit but no parseable review JSON" as
  `status:"error"` (the `findings === null` branch). The successful run emitted
  `agent_message` + `task_complete` with the review JSON.
- Exploration depth is **stochastic** → the error is **intermittent** (same plan
  content: loop-1 iter1 ok, iter2/iter3 error; loop-2 3/3 ok). It is **not** a
  timeout (`timeoutMs`=300 000, errored runs took 160–175 s) and **not** quota
  (primary 3–5 %, secondary 65 % used).

Observable mechanism is certain; codex's exact *internal* trigger (a step/tool
budget vs. other) is not visible in the rollout and does not change the fix.

## Goals / non-goals

**Goals**
- codex `review()` reliably produces a parseable review JSON (or a *clean*
  non-ok status), so the reviewer stops flickering ok↔error between iterations.
- Fix is local to the codex adapter, independently testable, verified against
  the real codex CLI (not only stubs).

**Non-goals (explicitly deferred)**
- Panel-level containment of an erroring reviewer (carry-forward / exclude from
  convergence calc) → **Slice 4**.
- Disabling shell exploration for other providers → codex-specific here.
- The `complete()` path (LLM judges) → unchanged in this slice.

## Design

### B — Disable codex's shell exploration (root fix)

Add `--disable shell_tool` to the `codex exec` args built in `review()`.
`shell_tool` is a real, stable codex feature flag (`codex features list` →
`shell_tool  stable  true`); `--disable shell_tool` ≡ `-c features.shell_tool=false`.

With it, codex answers **in one shot from the prompt** — the orchestrator already
curates that context (diff + research + full content of changed files, and in
Slice 2 the referenced source). codex no longer wanders the repo, so it can't
exhaust its turn budget mid-exploration.

**Verified real (2026-05-27):** running the exact adapter args + `--disable
shell_tool` against the flashbuddy repo with a code-referencing plan produced
`exit 0`, **0** `function_call`/`exec_command` events, **1** `agent_message`,
and a valid `{"verdict":"FAIL","findings":[…]}` in `last.md` (76 s). It still
surfaced a genuine finding (App-Router `route.ts` vs `page.tsx`) purely from the
prompt — confirming review quality does not depend on self-exploration.

**Trade-off (accepted):** codex loses independent file verification. That same
non-deterministic exploration caused both the error *and* FP flicker; the
orchestrator-curated context + Slice 2 compensate. Net effect: more
deterministic, fewer false flags.

Implementation note: place `--disable shell_tool` in the `args` array
(before the prompt positional) in `review()`. Do **not** touch `complete()`.

### A — Retry-once safety net

Even with B, a run may still yield no parseable review JSON (genuine API hiccup,
truncated stream). Refactor the spawn-and-parse body of `review()` into an inner
helper and call it up to **twice**:

1. First attempt: current behavior (with `--disable shell_tool`).
2. **Retry predicate** — retry **once** when the attempt did **not** yield a
   parseable review JSON *and* none of the no-retry conditions below hold. This
   covers two outcomes: (a) the confirmed root cause — exit 0 but empty/
   unparseable `last.md` (today's `findings === null` branch on the exit-0 path),
   and (b) a plain non-zero exit classified `status:"error"` (transient API
   error). The retry uses the same args plus a stronger trailing directive
   appended to the prompt, e.g.:
   `"\n\nIMPORTANT: Output ONLY the single JSON object of the required schema now. Do not call any tools or explain."`
   (The retry prompt file is written to the same run dir.)
3. The retry's result is returned as-is, with one exception: if the retry again
   ends in the **generic error/unparseable** outcome, suffix its `statusDetail`
   with `" (after retry)"`. If the retry **itself** returns `quota-exhausted`,
   `"timeout"`, or aborts (`killedByAbort`), return it **unchanged** — do not
   suffix — so quota `statusDetail` stays parseable by `parseQuotaResetAt` for
   the cooldown. (The no-retry conditions below gate whether a *second* attempt
   starts at all; this rule governs how a second attempt's own terminal status is
   reported.) First-attempt no-retry statuses likewise keep their original
   `statusDetail` unchanged.

**No-retry conditions** (return the first attempt's result unchanged) — detect
each from the spawn result / signal directly, **not** by inferring from
`status`, because an abort currently surfaces as plain `status:"error"`:
- `res.killedByAbort === true` **or** `input.signal?.aborted === true` — the loop
  self-deadline fired; respect cancellation, do not start a second run.
- `res.killedByTimeout` / `res.killedByWatchdog` (`status:"timeout"`; retry can't help).
- `status === "quota-exhausted"` (cooldown handles it; retry wastes quota).
- **Quota on the exit-0 unparseable path:** the adapter only promotes quota when
  `baseStatus === "error"` (exit≠0; `src/providers/codex.ts:124-127`). An exit-0
  run that emitted a quota/limit banner but **no** parseable `last.md` falls
  through to the `findings === null` branch as a generic error and would be
  retried — wasting quota. The retry predicate MUST therefore also run
  `isQuotaExhausted(quotaText)` on the unparseable exit-0 result and, if true,
  return `quota-exhausted` (with its parseable detail) instead of retrying.

> Implementation guard: `spawnSafely` exposes `killedByAbort`
> (`src/utils/spawn.ts:28`), but `review()` today classifies only
> timeout/watchdog → `"timeout"` (`src/providers/codex.ts:124-127`). The plan
> must add an explicit abort check; otherwise an aborted run looks like an
> ordinary error and would be retried after the deadline.

**Temp-dir / no-leak / stale-file requirement:** `review()` deliberately does
**not** remove its `mkdtempSync` run dir (`src/providers/codex.ts:70`) —
`rawEventsPath` points inside it for post-hoc inspection. The retry MUST **reuse
the same run dir**; `rawEventsPath` then references the **last** attempt. Creating
a second uncleaned `mkdtempSync` dir is a regression (temp leak) and is forbidden.
**Stale-output guard (critical):** codex writes `last.md` only when it emits a
final message, so before **each** spawn the attempt's `last.md` (and
`events.jsonl`) MUST be **truncated/unlinked**. Otherwise a second attempt that
again produces no final message would leave attempt-1's `last.md` in place and
the parser would read **stale** content as if it were the retry's output. Use
attempt-suffixed filenames (`last.1.md`, `last.2.md`) or explicit truncate-before-
spawn; the plan must pick one and test the stale-file case.

**Retry budget semantics:** `timeoutMs` is applied **per attempt** (each
`spawnSafely` call gets the full `input.cfg.timeoutMs`), so the failure path can
roughly double adapter wall time. This is bounded by the orchestrator's loop
self-deadline: `input.signal` aborts an in-flight attempt, and a fired
signal/`killedByAbort` is a no-retry condition (above), so the second attempt is
never started past the deadline. The common (success) path runs exactly one
attempt and is unchanged.

## Files touched

- `src/providers/codex.ts` — add `--disable shell_tool` to `review()` args;
  wrap spawn+parse in an inner function; add the conditional single retry.
- `tests/unit/` — new/extended codex adapter tests (below).

## Test plan (real verification — no fakes; see project memory)

Unit (stubbed `spawnSafely`, deterministic):
1. First attempt returns valid review JSON → exactly **one** spawn, `status:"ok"`,
   no retry.
2. First attempt returns empty/unparseable `last.md` (exit 0) → **two** spawns;
   second returns valid JSON → `status:"ok"`.
3. Both attempts unparseable → `status:"error"`, `statusDetail` suffixed
   `" (after retry)"`; exactly **two** spawns.
3b. First attempt **non-zero exit** generic `status:"error"` (not quota/timeout/
   abort), second attempt returns valid JSON → **two** spawns, `status:"ok"`.
   (Covers the transient exit≠0 retry path, distinct from the exit-0 case.)
3c. Stale-file guard: first attempt writes a `last.md`, second attempt produces
   **no** final message (does not rewrite `last.md`) → result is `status:"error"`,
   **not** a spurious parse of attempt-1's stale `last.md`.
3d. Retry returns terminal status: first attempt generic error → retry returns
   `quota-exhausted` (or `timeout`/abort) → that retry status is returned
   **unchanged** (no `" (after retry)"` suffix; quota detail preserved for cooldown).
3e. Generic error on retry: both attempts exit non-zero generic `status:"error"`
   → `status:"error"` with `statusDetail` suffixed `" (after retry)"`; two spawns.
3f. Quota on exit-0 unparseable: first attempt exits 0, empty `last.md`, but
   events/stderr carry a quota banner → classified `quota-exhausted`, **no** retry
   (one spawn), reset detail preserved.
4. First attempt `status:"quota-exhausted"` / `killedByTimeout`/`killedByWatchdog`
   / `killedByAbort` (or pre-aborted `input.signal`) → **no** retry (one spawn),
   original `statusDetail` preserved unchanged.
5. Args structure: `review()` passes `--disable shell_tool` as **two** args
   (`"--disable"`, `"shell_tool"`) inserted **before** the final prompt positional
   (`src/providers/codex.ts:83-97`), and `--output-schema` / `--output-last-message`
   remain intact.
6. Retry prompt correctness: on retry, the stronger directive modifies the **final
   positional prompt only** (not appended as trailing flags, not left in an unused
   prompt file), and the retry reuses the **same run dir** (no second `mkdtempSync`).
   Note: `tests/fixtures/fake-codex.sh` may need arg-position awareness to assert
   this — extend it rather than assuming positional parsing.

Real-codex smoke test (guarded; skipped when `codex` is absent / no auth):
7. `--disable shell_tool` against a fixture plan → `last.md` parses as a review,
   event stream contains **0** `exec_command` / `function_call` events and ≥1
   `agent_message`. (Mirrors the manual verification above.)

## Acceptance

- `bunx tsc --noEmit` and `bun run lint` clean.
- `bun test` green incl. the new tests.
- Manual: a real codex review via the adapter completes with a parseable verdict
  and no shell tool-calls.
- Definition-of-Done review pipeline (Codex ×2 + Claude ×2) passes.

## Risks

- **codex feature-flag drift:** `shell_tool` could be renamed/removed in a future
  codex. Mitigation: the retry net (A) still catches the failure mode; a `doctor`
  check for the flag is a possible follow-up (out of scope here).
- **Reduced verification surface** (see B trade-off) — compensated by curated
  context and Slice 2; revisit if FP rate on code reviews rises.
