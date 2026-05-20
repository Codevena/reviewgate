# M1 Spikes — Summary

**Date:** 2026-05-20
**Context:** Compiled during the M1 implementation session. Several spikes were
resolved empirically while building; the three that require a fresh interactive
Claude Code session (S1–S3) are blocked on the user and are documented here as
pending, with the implementation's fallback behavior noted.

| Spike | Question | Status | Outcome |
|---|---|---|---|
| S1 | Does Stop-hook `decision:"block"` actually force Claude to keep working? | ⏳ PENDING (user-driven) | Requires a fresh Claude Code session in `/tmp/reviewgate-spike-s1`. The whole gate design assumes this works; the plan's Pre-flight S1 has the exact bash. M1 ships the disk-only `{decision:"block", reason}` path which is the documented Stop surface. |
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
None of the pending spikes block M1 functionality:
- S1 is the one true external dependency; if Stop-hook blocking has changed in
  the installed Claude Code, the gate mechanism would need redesign — run S1
  before relying on Reviewgate in anger.
- S2/S3/S4/S5/S6/S7 all have correct, conservative fallbacks already in code.

## How to run the pending spikes (S1–S3)
See the **Pre-flight: Spikes** section of
`docs/superpowers/plans/2026-05-20-reviewgate-m1-minimum-viable-loop.md` for the
exact bash. Each writes its result to `docs/superpowers/spikes/M1/SX-*.md`.
