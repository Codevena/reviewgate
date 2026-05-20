# M1 Spikes — Summary

**Date:** 2026-05-20
**Context:** Compiled during the M1 implementation session. Several spikes were
resolved empirically while building; the three that require a fresh interactive
Claude Code session (S1–S3) are blocked on the user and are documented here as
pending, with the implementation's fallback behavior noted.

| Spike | Question | Status | Outcome |
|---|---|---|---|
| S1 | Does Stop-hook `decision:"block"` actually force Claude to keep working? | ✅ PASS (2026-05-20) | Verified in a fresh Claude Code session in `/tmp/reviewgate-spike-s1`. A Stop hook returning `{"decision":"block","reason":"…read marker.txt…"}` blocked the turn; Claude read `marker.txt` on its own and reported the verbatim contents (`GEHEIMES-WORT-S1-OK`) before being allowed to stop. ~3 Stop-hook invocations fired, then a single-block guard (flag file) allowed termination — no infinite loop. Confirms the core gate mechanism: `decision:"block"` + `reason` forces continued work and Claude follows the reason text. |
| S2 | Is `hookSpecificOutput.additionalContext` honored on Stop? | ⏳ PENDING (user-driven) | M1 does NOT depend on it — findings always live on disk (`pending.md`/`pending.json`). If S2 later confirms support, it's an optional optimization (inline top-3 findings) for a later milestone. |
| S3 | Which env/stdin field carries the host model? | ⏳ PENDING (user-driven) | `src/utils/host-model.ts` implements the full fallback chain (`REVIEWGATE_HOST_MODEL` → `CLAUDE_MODEL` → hook-stdin `session.model` → assume-opus). The assume-opus fallback is fail-safe by construction, so M1 is correct regardless of S3's outcome. `reviewgate doctor` reports which source is active (currently `fallback:assume-opus` on this machine — warns the user to set `REVIEWGATE_HOST_MODEL`). |
| S4 | Is Codex `--output-schema` + `--output-last-message` reliable (≥9/10)? | ◑ DEFERRED (graceful fallback shipped) | Not run as a 10-trial empirical test (would spend real Codex tokens). `CodexAdapter.extractFindings` parses `last.md` as JSON and, on parse failure or non-array `findings`, returns zero findings rather than crashing — the exact fallback the spike's "if flaky" branch prescribes. Codex CLI 0.130.0 is installed and the adapter passes `--output-schema` through when a schema path is supplied. |
| S5 | Does `@anthropic-ai/sandbox-runtime` deny `~/.ssh` on macOS + Linux? | ◑ RESOLVED w/ caveat | `@anthropic-ai/sandbox-runtime@^1.0.0` is **not published** (npm only has ≤0.0.52). It was dropped from `package.json`. `reviewgate doctor` confirms the OS primitive is functional (`sandbox-exec functional` on darwin here). `SandboxManager` is fail-closed: `mode='strict'\|'permissive'` throws `SandboxUnavailableError` (the package isn't importable), and only `mode='off'` runs an unisolated plain spawn. Re-add the package and wire `runInside` when v1 ships. |
| S6 | Does Codex's inner `--sandbox read-only` conflict with our outer sandbox? | ◯ N/A for M1 | Moot while sandbox-runtime is absent. Codex's own `--sandbox read-only` flag is still passed by the adapter. Revisit alongside S5 when the outer sandbox is wired. |
| S7 | Do Claude CLI `--tools` / `--disallowedTools` actually restrict? | ◯ INFORMATIONAL (M2) | M1 ships no Claude reviewer (Codex only), so this does not gate M1. To be confirmed when the M2 Claude-as-reviewer adapter lands. |

## Legend
- ⏳ PENDING — needs a user-driven interactive Claude Code session
- ◑ RESOLVED/DEFERRED — handled in M1 with a documented fallback
- ◯ INFORMATIONAL / N/A — out of M1 scope (M2+) or not applicable under current M1 constraints

## Net effect on M1
- **S1 (the one true external dependency) is confirmed PASS** — the Stop-hook
  block mechanism that the entire gate relies on works in the installed Claude
  Code version. S4 is also empirically confirmed (codex honors `--output-schema`
  reliably; see [[S4]] notes and the real-Codex e2e).
- S2/S3 remain optional/informational — both have correct, conservative
  fallbacks already in code and do not gate M1.
- S5/S6 are blocked only by the unpublished `@anthropic-ai/sandbox-runtime`;
  M1 fails closed for sandboxed modes and ships `mode:'off'` by default.

## How to run the remaining optional spikes (S2, S3)
See the **Pre-flight: Spikes** section of
`docs/superpowers/plans/2026-05-20-reviewgate-m1-minimum-viable-loop.md` for the
exact bash. Each writes its result to `docs/superpowers/spikes/M1/SX-*.md`.
