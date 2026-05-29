# Reviewgate — Next-Session Handoff

_Last updated: 2026-05-30. Read this first, then delete/ignore once you're oriented._

## What Reviewgate is
A code-review gate that runs **inside Claude Code's Stop hook**: on turn-end it spawns a
heterogeneous LLM reviewer panel (codex/gemini/claude/opencode/openrouter CLIs) as subprocesses,
aggregates findings under a severity-weighted veto, and **blocks the turn** until every finding is
fixed or rejected-with-reason. File-based (no chat parsing). Runtime is **Bun**. **It dogfoods
itself** — a `.reviewgate/` dir is present, so the gate runs on your own turns here.

## Current state (master is green)
`bun test` → ~1175 pass / 0 fail · `bunx tsc --noEmit` clean · `bun run lint` clean · `bun run build` OK.

This session landed **8 PRs (#37–#44)**, all through a 2-reviewer DoD panel:
- **#37/#38** — the full multi-agent audit: **60 confirmed findings** fixed (12 HIGH + 20 medium + 27 low), TDD each.
- **#39** — `reviewgate setup` now offers to arm the gate (install hooks) at the end.
- **#40** — **fail-closed JSON boundary** (`src/utils/safe-json.ts`): all untrusted reviewer/LLM output parses through `safeJsonParse`/`parseUntrusted`; a structural guard test forbids raw `JSON.parse` in providers/critic.
- **#41** — **brain promotion funnel instrumentation**: `reviewgate learn status` now shows quorum-fail provider distribution (why nothing promotes).
- **#42** — **property-based tests** (fast-check) for fp-ledger + reputation invariants.
- **#43** — flake fix (cross-file `OPENROUTER_API_KEY` env leak).
- **#44** — **macOS filesystem sandbox** (weakness #3, increment 1): strict/permissive now REALLY isolate the reviewer's filesystem via `sandbox-exec`, proven by a real e2e.

The four "honest weaknesses" from the architecture review are all addressed:
1. fail-open edges → closed (#40) · 2. complexity/invariants → property tests (#42) ·
3. isolation "off" → macOS enforcement real (#44) · 4. brain never promotes → instrumented (#41).

## Top candidate for next session: Sandbox Increment 2 — Linux `bwrap`
Plan + design already written:
- Spec: `docs/superpowers/specs/2026-05-29-macos-sandbox-filesystem-design.md`
- Plan: `docs/superpowers/plans/2026-05-29-macos-sandbox-filesystem.md` — **see the "Increment 2 (NEXT): Linux bubblewrap" section at the bottom** for the task breakdown.

Key: the profile + wiring are platform-agnostic; only a `src/sandbox/bwrap.ts` translator + a
`spawnSafely` Linux branch + a Linux e2e are new. bwrap is a MOUNT-namespace model (inverse of
Seatbelt's allow-default) — you build the view with `--ro-bind`/`--bind`/`--tmpfs`. **Open decision:**
glob denies (`*.pem`) can't be mount-expressed on Linux — decide document-as-not-enforced vs
tmpfs-mask-matches in that increment's brainstorm. **You're on macOS** — Linux work needs a Linux
host/CI to run the real e2e; if none, do the design + pure unit tests and gate the e2e on availability.

Smaller follow-ups (INFO, optional): the #44 production-e2e's 2nd `describe` should be `describe.skip`
on non-darwin (currently in-`it` early-return); `readAllow` is metadata-only in the SBPL model (dead — could drop).
Deferred by design: **network isolation** (API reviewers need network; documented in CLAUDE.md).

## Workflow conventions (what worked this session — follow them)
- **DoD panel before every merge:** an **Opus `code-reviewer` agent** (background) + **Gemini via `agy`**.
  agy is flaky in **file-output mode and when backgrounded** — run it in the **FOREGROUND** and have it
  print the review to **STDOUT** (read it from the Bash result), not write a findings file. Probe it first
  with a trivial `agy -p "Reply OK" --dangerously-skip-permissions --add-dir .`.
- **`rm -rf .review/` (or clear the findings file) BEFORE each new review round** — I once read a STALE
  findings file from the prior round and mistook a PASS for a FAIL. Clear it first.
- **The DoD panel earns its keep:** it caught real CRITICALs that unit tests with synthetic fixtures
  masked (e.g. the sandbox `BROAD_DENY` conflict made the feature throw before every spawn). **Prefer
  real end-to-end verification over stubs** — and when a reviewer claims a bug, *reproduce its exact
  probe yourself* before accepting or dismissing it.
- **codex/agy run in the FOREGROUND with stdin closed** (`</dev/null` for codex). Backgrounding → 0-byte hang.
- **Branch per change; never push to origin without explicit user permission.** This session the user
  approved each push/merge. Commit messages: no "Co-Authored-By"/"powered by" lines (user's CLAUDE.md).
- **`console.warn`/`console.error`, not a custom logger** (pre-commit hook). Bun built-ins (`Bun.Glob`, `Bun.$`).
- The repo's own gate (`.reviewgate/`) reviews YOUR turns — fix or reject-with-reason its findings.

## Suggested opening prompt for the next session
> "Read NEXT_SESSION.md. Then let's do Sandbox Increment 2 (Linux bwrap) — brainstorm the glob-deny
> decision first, then implement per the plan's Increment-2 section via subagent-driven TDD, with the
> DoD panel (Opus + Gemini/agy-stdout) before merge. I'm on macOS, so gate the real bwrap e2e on
> availability. Branch, and ask before pushing."
