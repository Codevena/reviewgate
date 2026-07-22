# Alpha.12 Benchmark v2 — Attempt 08

Status: non-authoritative.

Attempt 08 ran the preregistered retry protocol from `bench/preregistrations/alpha12-v2-attempt-08.json` on clean `master` at `b368df0f6eec11acac58164dcfeeeb89c20b77f0`.

The matrix exited with code 4:

- `aggregate panel coverage 69% < 80%`
- `reviewer claude-code coverage 35/90 (100% required)`

Coverage observed in `baseline.result.json`:

- `codex`: 90/90, authoritative
- `claude-code`: 35/90, non-authoritative
- `openrouter` critic (`deepseek/deepseek-v4-flash` via `alibaba`): 66/66 eligible, authoritative

Provider calls used: 301/450.

Interpretation: this attempt must not be used for headline precision/recall/false-positive or ablation claims. Codex and the OpenRouter critic completed their configured coverage; Claude Code degraded heavily despite `--reviewer-max-attempts 2`, consistent with an external Claude CLI/quota/provider reliability failure rather than a matrix provenance or critic failure.

