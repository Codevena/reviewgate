# Reviewgate — Session Handoff (2026-05-21, session 2)

**Status:** M1–M4 shipped + live-tested (6 bugs fixed). **M5 (FP reduction) STARTED:** spec written, Phase A (diff-scoping) + Phase B0 (merge-provenance) **merged**; Phase B1 (FP-ledger core) planned, not yet executed.
**master HEAD:** `e8d2052` (local). **origin/master is STALE at `051ac18` — 22 commits behind, NOTHING PUSHED.**
**Runtime:** Bun (`export PATH="$HOME/.bun/bin:$PATH"`). 338 tests pass / 11 skip / 0 fail; typecheck + lint clean. Binary: `bun run build` → `dist/reviewgate`, symlinked `~/.local/bin/reviewgate`.

## ⚠️ FIRST: unpushed commits
`git rev-list origin/master..master` = **22 commits** (session 1 docs + 6 fixes + M5 spec/plans + Phase A + B0), all local-only per "never push without OK". `origin/master` = `051ac18`. **Ask the user before pushing.** Working tree has a pre-existing `M CLAUDE.md` (not from this session — leave it).

## 🚧 M5 — FP reduction (in progress)
Spec: `docs/superpowers/specs/2026-05-21-reviewgate-m5-fp-ledger-design.md` (v4, Codex-reviewed). Two parts: **A** diff-scoping (out-of-diff findings → INFO, default on) + **B** FP-ledger (signature learning, opt-in). 6 phases: A → B0 → B1 → B2a → B2b → B3.
- **Phase A — MERGED** (`f96659d`): `scopeToDiff` aggregator stage (range-intersection demote-to-INFO), decisions-gate scoped to CRITICAL/WARN (so demote-to-INFO actually unblocks), hunk parser (`src/diff/hunks.ts`, diff-state-aware), `phases.review.scopeToDiff` (default true), report-writer advisory section, tightened preamble. DoD PASS (Codex+Claude found+fixed 2 bugs: details-cap overflow, `+++` content-line misparse).
- **Phase B0 — MERGED** (`49474dd`): `Finding.members` provenance recorded by the aggregator (each merged member's signature + trusted `reviewer.provider`) — poison-safe prerequisite for B1.
- **Phase B1 — PLANNED, NOT STARTED:** `docs/superpowers/plans/2026-05-21-reviewgate-m5-phase-b1-fp-ledger.md` — 8 TDD tasks (schema `src/schemas/fp-ledger.ts`, store `src/core/fp-ledger/store.ts` mirroring BrainStore, learn-from-decisions per member-signature, `phases.fpLedger` opt-in, reactive aggregator demote, orchestrator wiring, DoD+merge). **Next session: execute this plan** (executing-plans or subagent-driven). Storage `.reviewgate/learnings/known_fp.jsonl`.
- **Phases B2a/B2b/B3 — later:** proactive few-shot + cache-hash; CLI (`fp list/show/pin/unpin/audit`) + decay + reject-rate; brain↔ledger coupling.
- **Live e2e still owed:** Phase A in flashbuddy (restart → a FP on unchanged code lands as INFO/advisory, doesn't block).

## This session's 6 fixes (all on master, local; first 4 went through full Codex+Claude DoD)
1. **`162ea18` decisions-rearm clear** — the decisions-gate matched by `finding_id` only; on a re-arm the iteration counter resets to 0 and reuses `decisions/<iter>.jsonl`, so a stale `F-001 fixed` line satisfied the next cycle's colliding F-001. Now wipes `decisions/` at both re-arm sites (PASS + escalated-commit). *Found by T2.*
2. **`306a115` symbol-graph wasm** — `bun build --compile` didn't bundle web-tree-sitter's engine runtime (`web-tree-sitter.wasm`); `Parser.init()` aborted ENOENT in the binary → **M3 symbol graph was silently DEAD in every real review since M3** (source-mode `bun test` hid it). Build now copies it to `dist/grammars` (fail-hard); `resolveRuntimeWasm()` + `Parser.init({locateFile})`. Verified at the compiled-binary level. *Found by T5.*
3. **`a16a5cf` brain promotion** — curator never promoted ANY memory (brain.json empty after a week). 3 barriers: diff-derived quorum needed ≥6 items (unreachable w/ ≤5 reviewers + no web-fetch) → now ≥3 distinct providers; GROUP_THRESHOLD 0.85→0.78 (paraphrases cluster; DEDUP stays 0.85); evidence synthesized when a proposal has none. Anti-collusion intact. *Found by T9.*
4. **`e95d2a4` brain type-default + schema_detail** — unknown reviewer `type` labels now default to "convention" (4th barrier); curator logs `schema_detail` sub-reason in curator-decisions. *Follow-up to T9.*
5. **`b5aa220` enrich keep-citation** *(TDD only, no DoD — small)* — `enrichProposal` dropped citations whose `safeFetch` failed (egress off → ALL fail) → emptied evidence → schema reject. Now keeps the item as reviewer evidence. *Found by T9 via schema_detail.*
6. **`b862cc7` ESCALATION.md findings** *(TDD only, no DoD — small)* — report's "Final findings" was always empty (`topFindings:[]` hardcoded) + per-iter CRIT/WARN always 0. Now populated from pending.json (FindingSchema-validated). *Found by T12.*

## Test series result (T1–T13, live in flashbuddy)
T1✅ T2✅ T3✅(critic ran, demoted 2) T4✅(doc-skip, after tree cleanup) T5✅(symbol graph populated, after fix #2) T6✅(cache hit, $0/1ms) T7✅(no false undefined-symbol — full-file context) T8✅(via T3 dedup) T9⚠️(machinery fixed+verified; **live promotion not yet observed** — needs ≥2–3 reviewers to converge on the same convention, non-deterministic) T10⏭(moot, brain empty) T11✅(brain CLI list/show/revoke — note the `--id <id>` flag) T12✅(escalation + re-arm) T13⏭(opportunistic, no reviewer ever failed: 4/4 ok throughout).

## Open findings / next-session candidates
- **M5 (FP-ledger) is the clear priority.** Across T4/T7/T9 the panel repeatedly produced FALSE POSITIVES on UNCHANGED code far from the diff (one was a hallucinated line 389 in a 362-line file; a minority CRITICAL FP forced a block in T7). Findings aren't scoped to the diff. M5's FP-ledger directly targets this; also consider scoping reviewer findings to the change. See memory `project_reviewer_fp_unchanged_code`.
- **Brain live promotion** still unobserved — machinery is sound (proposals reach quorum) but promotion needs reviewer convergence (≥2–3 providers proposing the same convention). T10 read-path can't be tested until a promotion exists. See `project_brain_never_promotes`.
- **Reset wrapper trap:** `.reviewgate/bin/gate` is the STOP hook, `.reviewgate/bin/reset` is reset. The escalation message says `reviewgate gate --hook reset` — use it verbatim (Agent A used bin/gate by mistake in T12 and left the gate escalated; recovered with the correct command).
- **Triage trigger gap (by-design, minor):** a change carried across a SessionStart reset that the agent doesn't re-touch via Edit/Write isn't reviewed until the next Edit (PostToolUse trigger is tool-based, not working-tree-state-based).
- Roadmap: **M5** FP-ledger, **M6** cassette replay / weekly reports / `reviewgate stats` / native sandbox.

## flashbuddy state
Gate re-armed (T12's escalation reset properly). `brain.json` empty. Working tree: `M reviewgate.config.ts` (test config, review-excluded) + untracked `.reviewgate/brain/`. Config: 4 reviewers (codex/openrouter[deepseek-v4-pro]/gemini[gemini-3-flash-preview]/claude-code[sonnet-4-6]) + critic opencode/`default` (MiniMax) + brain enabled (embeddings baai/bge-base-en-v1.5, egressAllowlist []). flashbuddy must RESTART to pick up a freshly rebuilt binary (SessionStart reset also clears stale `.reviewgate/` state).

## Working-environment gotchas
- **Shared checkout with a PARALLEL session** (branch `feat/plan-doc-review`) — HEAD has jumped unnoticed. This session used **git worktrees** for every fix (branch from local HEAD → TDD → review → FF-merge → remove worktree → rebuild binary). origin is stale; integration was **local FF-merge only, no push**. After each merge tell the parallel session to rebase.
- **codex worked reliably this session** (contradicts session 1's "often hangs"): `codex exec "$(<file)" </dev/null` foreground. opencode not needed.
- Never commit Claude attribution (commits authored Codevena). Never push without explicit OK.
- DoD for big fixes: TDD → `bun test`/typecheck/lint → Codex+Claude review subagents (`.review/*.md`, PASS=0 CRIT/WARN) → fix → re-review → `rm -rf .review/` → commit → FF-merge → rebuild. **Small fixes: TDD only, no DoD** (user's call this session).
- Memory dir: `/Users/markus/.claude/projects/-Users-markus-Developer-reviewgate/memory/` (German-speaking senior eng, milestone/subagent workflow, insists on REAL e2e — this session's 6 bugs were all source-mode-invisible, vindicating that). New memories this session: `project_reviewer_fp_unchanged_code`, `reference_compiled_binary_wasm`, `project_brain_never_promotes`.
