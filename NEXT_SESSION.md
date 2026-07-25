# Reviewgate — Next-Session Handoff

_Last updated: 2026-07-25 (evening). Supersedes all earlier content in this file._

## One-line state
Master is green and pushed (HEAD `19e1e73`, **2951 total / 0 fail** = 2939 pass / 12 skip), the binary is built and live in every repo via the `~/.local/bin/reviewgate` symlink (`0.1.0-alpha.13`), and the next task is **tagging + releasing alpha.12/13 on npm** — the launch that was deferred once already.

## What got done in the session that produced this handoff
Slice 3 — **agent-safe pending policy candidate** — merged as `19e1e73` (6 commits, `--no-ff`).

An `approval-required` policy candidate (raised when an agent edits `reviewgate.config.ts` non-monotonically — exactly what the FP-fragmentation banner tells it to do) forced a full review on **every** stop and was converted into a block on **every** completed pass, unbounded, while `reviewgate config approve` is TTY-only. It now blocks exactly once per candidate and only annotates afterwards.

**Correction to the previous handoff's diagnosis:** the loop was *not* `acknowledgePass`-specific. `gate.ts` converted `approval-required` into a block on the `allow_stop` path unconditionally, so the recommended config (`acknowledgePass:false` + `notify.desktop:true`) looped identically; `acknowledgePass` only changed which message the agent saw. The old handoff's TRAP note was still right about the block itself being loop-safe in isolation.

Design: once-ness derives from the existing `pending.reviewed_under_lkg_at` — no new persisted state. It is already candidate-keyed via `persistPending`, so a re-edited config re-arms the notice for free, and it survives a SessionStart `reset` because `handleReset` does not touch `control-plane.json`.

Docs: `docs/superpowers/specs/2026-07-25-agent-safe-policy-candidate-design.md` (spec + plan-gate findings mapping) and `docs/superpowers/plans/2026-07-25-agent-safe-policy-candidate.md` (implementation plan) are committed.

## THE NEXT TASK — tag + release alpha.12/13
Everything the release needs is in place: the alpha.12 benchmark is authoritative (attempt-09), `docs/evidence.md` is honest about run-to-run variance and the retry protocol, master is green, and the repo version is already `0.1.0-alpha.13`. What remains is the mechanical release path — tag, the 5-package npm publish (launcher + 4 platform packages), and a post-publish smoke test that the published launcher actually spawns the platform binary.

## Traps that still hold
- **`bun run build` deploys to ALL repos** via the `~/.local/bin/reviewgate` → `dist/reviewgate` symlink. Never build while an authoritative benchmark run is in flight (it pins `runner_sha256`).
- **Never `git add -A` here** — it stages `.reviewgate/` runtime state. Stage explicit paths.
- **Never push without Markus's explicit OK.** Commits carry no `Co-Authored-By` line.
- **Codex was quota-exhausted until 2026-07-29.** The documented fallback chain worked: agy (agentic, reads the repo) and GLM-5.2 via Ollama (completion, needs everything inline). Note agy failed one round with `timeout waiting for response`, rc=1, and a 41-byte log **after** writing an empty `## FINDINGS / ## VERDICT PASS` skeleton — an errored reviewer is not a pass, always check exit code AND log size.
- **A green assertion is not a working assertion.** This slice shipped, then had to fix, a regression test whose assertions were true on both the correct and the broken code (the review cache defeats "the reviewer was not called", and one stderr string appears on both paths). The guard that works is pinned to `.reviewgate/pending.json` byte-equality — an artifact the pre-lock skip exit provably never writes.
- **Suite flakes under load:** `tests/unit/sandbox-audit-fixes.test.ts` and `tests/integration/cassette-pipeline.test.ts` can fail in a full parallel run and pass 3/3 in isolation. Not branch-related; re-run isolated before believing a failure.
- Deferred, not forgotten: **`docs/AGENTS.md` does not describe the pending-policy case** (Markus's call, deliberately out of the slice-3 branch). **Arming S2 (arming probe) / S3 (worktree inheritance)** from `docs/superpowers/specs/2026-07-17-arming-consent-design.md` remain parked behind the launch.

## Read-first order
1. This file.
2. `git log --oneline a745d37..19e1e73` for what slice 3 actually changed.
3. `docs/superpowers/specs/2026-07-25-agent-safe-policy-candidate-design.md` if you need the control-plane reasoning.
4. The npm packaging notes for the release mechanics (5-package esbuild layout; the launcher SPAWNS the binary, so `execPath` IS the binary).
