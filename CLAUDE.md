# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Reviewgate is a **code-review gate that runs inside Claude Code's agent loop**. When Claude edits files in a Reviewgate-initialised repo, a `Stop` hook spawns a heterogeneous LLM reviewer panel (Codex / Gemini / Claude / OpenRouter CLIs) as subprocesses, aggregates findings under a severity-weighted veto, and **blocks Claude from ending its turn** until every finding is fixed or rejected-with-reason. Findings are written to files (`.reviewgate/pending.md`) that the agent reads with its normal Read tool — there is no chat-stream parsing. This repo **dogfoods itself**: a `.reviewgate/` dir is present, so the gate runs on your own turns here.

## Commands

Runtime is **Bun** (Node 20+ only runs the compiled binary).

```bash
bun install
bun run dev <subcommand>      # run the CLI from source (src/cli/index.ts)
bun run build                 # compile single binary → dist/reviewgate (+ copies tree-sitter .wasm grammars)
bun run typecheck             # tsc --noEmit  (also: bunx tsc --noEmit)
bun run lint                  # biome check src tests   (FAILING lint blocks "done")
bun run format                # biome format --write
bun test                      # full suite
bun test tests/unit/foo.test.ts          # a single test FILE
bun test -t "substring of test name"     # a single test by name
bun run test:unit / test:integration     # by directory
```

Always run `bunx tsc --noEmit` **and** `bun run lint` before considering a change done — both must be clean. After editing schemas/config, run the full `bun test`.

CLI subcommands: `init` (install hooks into `.claude/settings.json`), `gate` (hook entry point — see below), `doctor` (health-check provider CLIs), `audit verify`, `brain list|show|revoke`, `review-plan <file…>` (one-shot review of a plan/spec markdown).

## How the gate runs (control flow)

The entire pipeline is driven by hooks calling `reviewgate gate --hook <trigger|stop|reset>` (`src/cli/commands/gate.ts`):

- `trigger` (PostToolUse) — just marks `.reviewgate/dirty.flag`.
- `reset` (SessionStart) — wipes per-session state.
- `stop` (Stop) — the real work: `LoopDriver.run()` → `Orchestrator.runIteration()`.

`LoopDriver` (`src/core/loop-driver.ts`) decides allow-stop vs block: no dirty flag → allow; otherwise it gates on the previous iteration's decisions (`.reviewgate/decisions/<iter>.jsonl` must address every finding id from `pending.json`), advances `iteration` toward the cap, and emits `ESCALATION.md` on max-iterations / stuck-signatures / cost-cap / high-reject-rate. It deliberately does **not** short-circuit on `stop_hook_active` (the FAIL→fix→re-review loop must run in-chain), and re-arms the budget on a clean PASS or a commit.

`Orchestrator.runIteration()` (`src/core/orchestrator.ts`) is the pipeline: **triage → cache check → research → reviewer panel → critic → aggregate → write report**.

## Architecture map

- **`src/diff/`** — `collectDiff` (in `src/utils/git.ts`) returns the diff since the **review base** (`git diff <base>` + untracked via `--no-index`), where `base` is the pre-batch HEAD captured in `dirty.flag` at the clean→dirty transition — so it covers BOTH committed (commit-per-task) and uncommitted changes since the batch started. With no base it falls back to `git diff HEAD` (working-tree only). `reviewgate.config.ts` and everything under `.reviewgate/` are excluded from the reviewed diff. `sanitizer.ts` fences the untrusted diff and appends a persona reaffirmation; `signature.ts` computes per-finding signatures for dedup/stuck-detection.
- **`src/triage/`** — `diff-facts.ts` classifies changed files (code/docs/tests/config/lockfile) and sensitivity tags; `matrix.ts` (`triageFromFacts`) maps facts → `RiskClass` + `runReview`. Doc-only / empty diffs are skipped unless `docReview` opts them back in as `riskClass:"docs"`.
- **`src/providers/`** — one adapter per reviewer CLI (`codex.ts`, `gemini.ts`, `claude.ts`, `openrouter.ts`), all implementing `adapter-base.ts`. They spawn the real CLIs via `src/utils/spawn.ts` (`spawnSafely`, which closes stdin — codex hangs otherwise). `review-output.ts` holds the shared `REVIEW_OUTPUT_SCHEMA` and parses reviewer JSON into `Finding`s.
- **`src/core/`** — `aggregator.ts` (severity-weighted verdict + dedup + consensus), `critic.ts` (demote-only adversarial pass), `report-writer.ts` (renders `pending.md`/`pending.json`; `mode:"one-shot"` writes `plan-review.*` instead), `state-store.ts` (locked, atomic `state.json`).
- **`src/research/`** — `symbol-graph.ts` (tree-sitter, TS/Python `.wasm` grammars), `conventions.ts`, `research-writer.ts` produce `research.md` injected as trusted context before the diff fence.
- **`src/core/brain/`** — M4 repo-memory ("Brain") + Curator. **Default OFF** (`phases.brain: null`). `fetcher.ts` is an SSRF-hardened `safeFetch`; the curator phase is non-blocking, timeout-bounded, and never changes the verdict.
- **`src/config/`** — `defineConfig`/`ConfigSchema` (zod). Effective config = `defaults.ts` deep-merged with the repo's `reviewgate.config.ts` (absent → defaults). The full config is hashed into the review cache key, so config changes invalidate the cache.
- **`src/schemas/`** — zod schemas are the source of truth for every persisted artifact (finding, triage, decision, pending-report, state, audit-event, research, brain). Validate against these rather than hand-rolling shapes.
- **Persistence** is plain JSON files under `.reviewgate/` (no database): `state.json`, `pending.{md,json}`, `decisions/<iter>.jsonl`, `cache/reviews/<key>.json`, `brain.{json,md}`, `audit/`.

## Non-obvious gotchas

- **Reviewer persona behavior comes from the inline `PERSONA_REAFFIRM` map + prompt preamble in `orchestrator.ts`, NOT from reading `.reviewgate/personas/*.md`** — those files are decorative in this milestone. To change how a persona reviews, edit `PERSONA_REAFFIRM` / the preamble.
- **`REVIEW_OUTPUT_SCHEMA` must be OpenAI/codex strict-mode valid:** every object node needs `additionalProperties:false` AND every property key listed in `required`; express optional fields via a nullable type (`["string","null"]`), never by omission. A violation makes every *real* codex review fail with HTTP 400 — and stub-based tests do NOT catch it (a structural test in `tests/unit/review-output-schema.test.ts` guards this).
- **Verify provider changes with a real CLI call**, not just stubs. `codex exec` must be run in the foreground with stdin closed (`</dev/null`); backgrounding or leaving stdin open makes it hang on "Reading additional input from stdin…".
- **Sandbox:** `mode:"off"` is the default. On **macOS**, `"strict"`/`"permissive"` now enforce **filesystem isolation** of reviewer subprocesses via `sandbox-exec` (Seatbelt/SBPL — wrapped in `spawnSafely`): reviewer can read its working dir/tmp/own creds but NOT secrets (`~/.ssh`, `~/.aws`, `.env`, `~/.netrc`, `~/.git-credentials`, foreign provider creds, …); writes restricted to findings + tmp + own cred dir. `strict` **fails closed** (refuses to review) when `sandbox-exec` is unavailable; `permissive` runs unisolated with a WARN. LIMITATIONS (by design, documented): **network is NOT isolated** (API reviewers need it; `sandbox-exec` can't host-allowlist); **macOS only** (Linux `bwrap` is the next increment, Windows unsupported); `sandbox-exec` is Apple-deprecated but functional; the reviewer's **own** cred dir is writable (OAuth refresh) — an accepted persistence risk; any host-side read of reviewer-written files must use `O_NOFOLLOW` (built-in adapters parse STDOUT, not the findings file). All paths are `realpath`-canonicalized before the SBPL (macOS `/tmp`→`/private/tmp`). See `docs/superpowers/specs/2026-05-29-macos-sandbox-filesystem-design.md`.
- Reviewers are OAuth-first ($0 within the user's subscription quota); OpenRouter uses an API key (`apiKeyEnv`).

## Bun conventions

- Use `bun`/`bunx`, not `npm`/`node`/`ts-node`/`npx`. `bun test`, not jest/vitest.
- Prefer Bun built-ins already used here: `Bun.Glob` for globbing, `Bun.$` for shell, `Bun.file`. Bun auto-loads `.env` (no `dotenv`).
- This project stores state as JSON files — there is no server, SQLite, or Redis despite the Bun starter template; ignore those parts of generic Bun guidance.
