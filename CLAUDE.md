# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Reviewgate is a **code-review gate that runs inside Claude Code and Codex agent loops**. When either host edits files in a Reviewgate-initialised repo, a native `Stop` hook runs a heterogeneous LLM reviewer panel (Codex / Gemini / Claude / OpenCode CLIs plus OpenRouter/Ollama HTTP adapters), aggregates findings under a severity-weighted veto, and blocks unresolved blocking findings. WARN-only policy, bounded infrastructure deferral and human escalation are explicit non-PASS exits. Findings are written to files (`.reviewgate/pending.md`) that the agent reads with its normal Read tool — there is no chat-stream parsing. This repo **dogfoods itself**: a `.reviewgate/` dir is present, so the gate runs on your own turns here.

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

CLI subcommands: `init` (complete first-run wizard: config + `--host claude|codex|both` + native hooks + LKG + doctor; `--hooks-only` repairs without reconfiguration), `gate` (hook entry point — see below), `reset` (user-facing re-arm: clears this session's review state; same effect as the SessionStart hook), `doctor` (health-check provider CLIs), `audit verify`, `brain list|show|revoke`, `review-plan <file…>` (one-shot review of a plan/spec markdown).

## How the gate runs (control flow)

The entire pipeline is driven by hooks calling `reviewgate gate --hook <trigger|stop|reset>` (`src/cli/commands/gate.ts`):

- `trigger` (PostToolUse) — marks `.reviewgate/dirty.flag`, except when the edit's fully-understood single path is reviewgate-managed/excluded (S3a). `reviewgate.config.ts` is the exception: it arms `.reviewgate/control-plane.flag`, never the normal source diff.
- `reset` (SessionStart) — wipes per-session state.
- `stop` (Stop) — a three-valued probe (`review` / `skip-clean` / `skip-escalated`, S1) first compares HEAD plus a content-true working-tree fingerprint against the reviewed-through markers, so uncommitted Bash-tool edits that never touched `trigger` are still caught; only `review` proceeds to the real work: `LoopDriver.run()` → `Orchestrator.runIteration()`.

`LoopDriver` (`src/core/loop-driver.ts`) decides allow-stop vs block: `skip-clean` allows; otherwise it gates on the previous iteration's decisions (`.reviewgate/decisions/<iter>.jsonl` must address every finding id from `pending.json`), advances `iteration` toward the cap, and emits `ESCALATION.md` on max-iterations / stuck-signatures / cost-cap / high-reject-rate. A non-empty stop diff always persists a dirty flag or fail-closes (belt), so a real change can never fall through un-flagged. Once escalated, the gate stands down LOUDLY — `skip-escalated` prints a 🟠 message pointing at `ESCALATION.md` instead of the green one — and recovery requires a commit made AFTER the announce (S3b), not merely one that predates it. An all-quota outage defers a bounded number of turns, then escalates once and keeps the change flagged until a reviewer actually completes (S4a). It deliberately does **not** short-circuit on `stop_hook_active` (the FAIL→fix→re-review loop must run in-chain), and re-arms the budget on a clean PASS or a commit.

`Orchestrator.runIteration()` (`src/core/orchestrator.ts`) is the pipeline: **triage → cache check → research → reviewer panel → critic → aggregate → write report**.

## Architecture map

- **`src/diff/`** — `collectDiff` (in `src/utils/git.ts`) returns the diff since the **review base** (`git diff <base>` + untracked via `--no-index`), covering committed and uncommitted work since the batch started. `reviewgate.config.ts` is intentionally excluded from the normal reviewer prompt but monitored through the separate control-plane fingerprint; `.reviewgate/` runtime files are excluded. `sanitizer.ts` fences the untrusted diff and appends a persona reaffirmation; `signature.ts` computes per-finding signatures for dedup/stuck-detection.
- **`src/triage/`** — `diff-facts.ts` classifies changed files (code/docs/tests/config/lockfile) and sensitivity tags; `matrix.ts` (`triageFromFacts`) maps facts → `RiskClass` + `runReview`. Doc-only / empty diffs are skipped unless `docReview` opts them back in as `riskClass:"docs"`.
- **`src/providers/`** — one adapter per reviewer CLI (`codex.ts`, `gemini.ts`, `claude.ts`, `openrouter.ts`, `ollama.ts`), all implementing `adapter-base.ts`. Most spawn the real CLIs via `src/utils/spawn.ts` (`spawnSafely`, which closes stdin — codex hangs otherwise); `openrouter.ts` and `ollama.ts` are subprocess-free HTTP adapters instead (`SUBPROCESSLESS_PROVIDERS` in `registry.ts`) — `ollama` targets an OpenAI-compat `/v1` endpoint (Ollama Cloud by default, or a local `ollama serve`). `review-output.ts` holds the shared `REVIEW_OUTPUT_SCHEMA` and parses reviewer JSON into `Finding`s.
- **`src/core/`** — `aggregator.ts` (severity-weighted verdict + dedup + consensus), `critic.ts` (demote-only adversarial pass), `report-writer.ts` (renders `pending.md`/`pending.json`; `mode:"one-shot"` writes `plan-review.*` instead), `state-store.ts` (locked, atomic `state.json`).
- **`src/research/`** — `symbol-graph.ts` (tree-sitter, TS/Python `.wasm` grammars), `conventions.ts`, `research-writer.ts` produce `research.md` injected as trusted context before the diff fence.
- **`src/core/brain/`** — M4 repo-memory ("Brain") + Curator. **Default OFF** (`phases.brain: null`). `fetcher.ts` is an SSRF-hardened `safeFetch`; the curator phase is non-blocking, timeout-bounded, and never changes the verdict.
- **`src/core/lore/`** — Lore v1 (`phases.lore`, **default OFF** = `null`). Committed per-repo `.reviewgate/lore/*.md` project-knowledge entries (draft→canon): `store.ts` (hand-rolled frontmatter parse + fail-safe `loadLore` — never throws), `staleness.ts` (`Bun.Glob` anchor resolution + SHA-256 `verified_tree` over raw bytes; `classifyEntry` → ok/stale/broad/zero-match), `render.ts` (`selectForDiff` + total budget order + defanged injection block), `approvals.ts`/`guard.ts` (committed `approvals.jsonl` + raw-text draft→canon detection). Only approved canon whose anchors intersect the diff is injected; the two lore finding types are INFO/verdict-neutral. Orchestrator wires injection + finding emission; loop-driver does forcing/cap/cooldown/approval writes.
- **`src/config/`** — `defineConfig`/`ConfigSchema` (zod). `reviewgate.config.ts` is data-parsed as a literal default-export object; it is never imported/executed. Effective config = defaults <- global <- project. `control-plane.ts` stores a separate last-known-good effective snapshot in `.reviewgate/control-plane.json`: config candidates force a special gate path, code remains reviewed under the approved policy, monotonic strengthenings auto-adopt only after that pass, and weakening/non-monotonic changes need TTY-only `reviewgate config approve`. A present invalid config blocks and never degrades to defaults.
- **`src/schemas/`** — zod schemas are the source of truth for every persisted artifact (finding, triage, decision, pending-report, state, audit-event, research, brain). Validate against these rather than hand-rolling shapes.
- **Persistence** is plain JSON files under `.reviewgate/` (no database): `state.json`, `pending.{md,json}`, `decisions/<iter>.jsonl`, `cache/reviews/<key>.json`, `brain.{json,md}`, `audit/`.

## Non-obvious gotchas

- **Reviewer persona behavior comes from the inline `PERSONA_REAFFIRM` map + prompt preamble in `orchestrator.ts`, NOT from reading `.reviewgate/personas/*.md`** — those files are decorative in this milestone. To change how a persona reviews, edit `PERSONA_REAFFIRM` / the preamble.
- **`REVIEW_OUTPUT_SCHEMA` must be OpenAI/codex strict-mode valid:** every object node needs `additionalProperties:false` AND every property key listed in `required`; express optional fields via a nullable type (`["string","null"]`), never by omission. A violation makes every *real* codex review fail with HTTP 400 — and stub-based tests do NOT catch it (a structural test in `tests/unit/review-output-schema.test.ts` guards this).
- **Verify provider changes with a real CLI call**, not just stubs. `codex exec` must be run in the foreground with stdin closed (`</dev/null`); backgrounding or leaving stdin open makes it hang on "Reading additional input from stdin…".
- **Sandbox:** `mode:"off"` is the default. `strict`/`permissive` are a **denylist read model plus write isolation**, not a read allowlist. macOS Seatbelt starts `(allow default)`, denies writes except exact findings/run-temp/own-credential targets, and denies known secret paths/globs. Linux bubblewrap exposes `/` read-only, bind-mounts only those exact targets writable, and masks known secret paths. Other non-denied host files may remain readable. `strict` fails closed when the OS sandbox is unavailable; `permissive` runs unisolated with a WARN. Network is never isolated; Linux cannot enforce glob denies (`*.pem`, `.env*`); the reviewer's own cred dir is writable for OAuth refresh; Windows is unsupported. Gemini/agy and OpenCode are coding-agent CLIs invoked with `--dangerously-skip-permissions`, so strict sandboxing matters especially for them. Codex is configured read-only; Claude review tools are restricted; OpenRouter/Ollama are subprocessless HTTP adapters. See `SECURITY.md`.
- Reviewers are OAuth-first ($0 within the user's subscription quota); OpenRouter uses an API key (`apiKeyEnv`).
- **Deadline-aware budgets:** `runIteration` receives `deadlineAt` from the loop; reviewer spawns clamp to the remaining budget minus `PANEL_TAIL_RESERVE_MS` and are skipped below `MIN_REVIEWER_BUDGET_MS` (budgets.ts); the critic clamps likewise and is skipped below its floor (`critic.status:"skipped-budget"` in pending.json). A budget-clamped/abort-killed timeout is never cooldown-penalized, but a reviewer that hit its OWN `timeoutMs` pre-abort now IS (per-settle attribution) — that pairing is what breaks the repeated-timeout treadmill. Defaults: `loop.runTimeoutMs` 1800s, init-written Stop-hook timeout 2400s (invariant: 120s setup + runTimeoutMs + 30s settle < hook timeout; `doctor` has a panel-budget sizing check).
- **Worktrees are NOT gated by default (coverage blind spot).** Reviewgate arms per-checkout: `init` writes `.reviewgate/bin/` + the `Stop`/`PostToolUse`/`SessionStart` hooks into THAT checkout's `.claude/settings.json` and/or `.codex/hooks.json`. A `git worktree` shares only `.git` — it has none of those repo-local hook/state files, so the Stop gate **never fires inside an uninitialized worktree** and that work ends un-reviewed (fail-open). The main checkout's hooks do NOT propagate. To gate a worktree, run `reviewgate init` **inside it** (per-worktree state dir; the git pre-push hook is auto-skipped there since `.git` is a file), or do the work in / merge it back to the gated main checkout. `reviewgate doctor` **FAILs** inside an un-gated linked worktree.
- **Lore (`phases.lore`, default OFF).** Committed `.reviewgate/lore/*.md` entries carry the *why* (invariants/adjudicated intent/incident lessons), anchored to files via globs. Only `status: canon` entries **with a matching `.reviewgate/lore/approvals.jsonl` line** are injected as trusted reviewer context — an unapproved canon behaves as a draft (the TRUST boundary fails CLOSED; context features fail OPEN to "review without lore"). Anchors matching **0 files are invalid**; **>200 files are inert** (neither hashed nor injected — a never-stale bypass guard); both surface a `pending.md` banner + `doctor` WARN. Two finding types — a stale-canon **reminder** (capped 1/repo/local-day, suppressed in CRITICAL rounds, rejection-cooldown'd) and a draft→canon **canon-promotion** guard — are severity **INFO but decision-required** (verdict-neutral: a PASS stays PASS; they cost one turn via the decision requirement, extending G0's forcing in `loop-driver.ts`'s `previousFindingIds`). A canon-promotion's `fixed` decision writes the approvals line; a reminder's `fixed` refreshes `verified_tree`/`verified_at` (re-verified next run — a still-stale claim bypasses the cap). The lore text is hashed into the review cache key (+ a `lorePromotions` segment so an unapproved promotion can't be swallowed by a cached PASS). Dogfooded here; **deliberately NOT in the init scaffold yet** (calibrating the reminder feel first).

## Bun conventions

- Use `bun`/`bunx`, not `npm`/`node`/`ts-node`/`npx`. `bun test`, not jest/vitest.
- Prefer Bun built-ins already used here: `Bun.Glob` for globbing, `Bun.$` for shell, `Bun.file`. Bun auto-loads `.env` (no `dotenv`).
- This project stores state as JSON files — there is no server, SQLite, or Redis despite the Bun starter template; ignore those parts of generic Bun guidance.
