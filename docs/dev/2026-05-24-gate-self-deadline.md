# Gate self-deadline → fail-closed on incomplete review

**Branch:** `gate-self-deadline-fail-closed` · **Status:** DONE — tsc+lint+732
tests green; verified end-to-end on the compiled binary (slow fake `codex` +
300ms deadline → `block` "did not complete", dirty.flag kept, stale pending.*
cleared, real subprocess SIGKILLed with no orphan). DoD: Codex review PASS +
Claude review PASS (both zero CRITICAL/WARN). Committed; awaiting push approval.

**Margin note (from review):** on a timeout the driver aborts the panel then
`await`s the run to settle. A run whose verdict was already written finishes its
bounded post-verdict bookkeeping (brain curator / cache — `curatorTimeoutMs`,
default 20s) and is HONORED, not reclassified incomplete. So `runTimeoutMs` must
sit below the Stop-hook timeout by a margin that covers that drain (default 60s
margin ≫ 20s curator). A panel still mid-flight is SIGKILLed and writeReport's
guard rejects → genuinely incomplete. The curator's `complete()`/`embed()` calls
are intentionally NOT signal-wired (best-effort, `.catch`-wrapped, self-bounded).

## Problem

The Stop hook runs `reviewgate gate --hook stop` with a Claude-Code-imposed
timeout (e.g. 900s in `.claude/settings.json`). If the reviewer panel runs
longer than that timeout, Claude Code **kills the hook process**. A killed Stop
hook is **non-blocking** — Claude Code lets the turn end. The gate therefore
**fails OPEN**: the turn finishes un-reviewed, no `state.json` / `pending.*` /
audit gets written, and nobody is told. This was observed live in `shoal`: a
1310-line plan review exceeded 900s, the turn ended at ~21min with no gate
artifacts after the kill, and the agent had to be told manually to re-check the
gate.

This contradicts Reviewgate's fail-closed contract everywhere else (0 reviewers
→ ERROR-block; sandbox strict → refuse).

## Fix

Give the gate its **own deadline strictly below the hook timeout**. If the
review can't finish in time, the gate aborts the in-flight work itself and emits
a **`block`** ("review did not complete — re-run") instead of being killed
silently. That converts the fail-open into fail-closed + visible. The persistent
`dirty.flag` means the re-run re-reviews the same diff. Repeated incompletes
escalate to the human so a permanently-hanging provider can't infinite-loop.

## Design decisions (chosen)

- **`loop.runTimeoutMs`** — new config field. Default **840_000** (14min): fits
  under the default 900s hook with ~60s margin for teardown + state/audit
  writes. `0` disables the deadline (old behavior). Repos that raise the hook
  timeout raise this too (shoal: hook 1800s → set `runTimeoutMs: 1_740_000`).
- **Incomplete is NOT a review round** — it does not advance `iteration`
  (no findings were produced). Tracked by a separate state counter
  `incomplete_runs`. The `dirty.flag` is kept (not consumed) so the re-run
  re-reviews.
- **Escalate after 2 consecutive incompletes** (`reasonCode:"review-timeout"`),
  mirroring `stuckThreshold`'s default. A completed run (any verdict) resets
  `incomplete_runs` to 0.
- **No new `IterationResult` verdict.** Abort is signalled via `AbortSignal`;
  `runIteration` throws at the next checkpoint, loop-driver `.catch`es it and
  treats it as incomplete. Keeps `IterationResult` untouched.
- **Clean child-kill via `AbortSignal`** threaded `loop-driver → orchestrator
  → adapter.review() → spawnSafely`. On abort, `spawnSafely` runs its existing
  `killTree("SIGKILL")`. Prevents orphaned reviewer subprocesses AND prevents
  the aborted `runIteration` from writing `pending.*`/state after loop-driver
  already decided (state-race guard).

## Change map (TDD — test first per item)

1. `src/config/define-config.ts` + `defaults.ts` — add `loop.runTimeoutMs`
   (zod `int().nonnegative()`, default 840_000). Config hash → cache invalidates.
2. `src/schemas/state.ts` — `incomplete_runs: z.number().int().nonnegative().default(0)`;
   `EscalationReason` += `"review-timeout"`. Update `DEFAULT_STATE` + recovery.
3. `src/utils/spawn.ts` — `SpawnInput.signal?: AbortSignal`; on `signal.aborted`
   / `abort` event → `killTree("SIGKILL")` + settle as killed.
4. `src/providers/adapter-base.ts` — `ReviewInput.signal?: AbortSignal`.
5. `src/providers/{codex,gemini,claude,opencode,openrouter}.ts` — pass `signal`
   into their `spawnSafely({...})` call.
6. `src/core/orchestrator.ts` — `runIteration({runId, iter, signal?})`; pass
   `signal` to every panel `adapter.review({...})`; `if (signal?.aborted) throw`
   checkpoints before `writeReport`/effect-apply/return.
7. `src/core/loop-driver.ts` — read `config.loop.runTimeoutMs`; if `>0`,
   `AbortController` + `Promise.race(runIteration(signal), deadline)`. On
   deadline: `abort()`, `incomplete_runs++`, keep dirty.flag, then
   `incomplete_runs >= 2` → `escalateAndDecide("review-timeout", …)` else
   `block` "review did not complete within Ns — re-run". On completed run reset
   `incomplete_runs = 0`.
8. Tests:
   - `tests/unit/loop-driver.test.ts` — stub orchestrator that sleeps past a
     tiny `runTimeoutMs` → block "did not complete" + `incomplete_runs===1`;
     second incomplete → escalate `review-timeout`; a fast run resets the counter.
   - `tests/unit/spawn.test.ts` (or existing) — real `spawnSafely` with a
     `sleep 30` child + an AbortController aborted after 200ms → resolves quickly
     as killed (real subprocess, not a stub).

## DoD

`bunx tsc --noEmit` + `bun run lint` + `bun test` green → Codex review ×1
(file-prompt) → Claude review ×1 → fix → re-run → commit local → ask before push.
