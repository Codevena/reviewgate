# Reviewgate — Session Handoff (2026-05-21)

**Status:** M1–M4 shipped & merged to `master`. Live in the real project **flashbuddy**.
**master HEAD:** `051ac18` (origin/master in sync). Repo: github.com/Codevena/reviewgate.
**Runtime:** Bun (`~/.bun/bin` — prepend to PATH: `export PATH="$HOME/.bun/bin:$PATH"`). 300 tests pass / 9 skip / 0 fail; `bun run typecheck` + `bun run lint` clean. Binary: `bun run build` → `dist/reviewgate`, symlinked at `~/.local/bin/reviewgate`.

## What Reviewgate is (1 line)
A code-review gate inside Claude Code's Stop hook: a heterogeneous LLM reviewer panel reviews the working-tree diff, a severity-weighted veto + critic + non-blocking Curator (brain) aggregate findings, and the gate blocks turn-end until each finding is fixed or rejected-with-reason. See `docs/superpowers/specs/2026-05-20-reviewgate-design.md` + CLAUDE.md.

## Milestones (all shipped)
- **M1** loop FSM + decisions protocol + hash-chained audit.
- **M2** multi-reviewer panel (codex/gemini/claude/openrouter[/opencode]) + critic (demote-only) + severity-weighted aggregation.
- **M3** adaptive triage (doc-only skip) + research.md (tree-sitter symbol graph) + content-addressed cache + symbol-relative signatures.
- **M4** Brain + Curator: committed per-repo memory; read-path injection (per-run snapshot), `memory_proposals` write-path, non-blocking timeout-bounded Curator with 7 rules incl. cross-provider quorum via embedding grouping (anti-collusion), OpenRouter embeddings, SSRF-resistant web-fetch, lifecycle, `reviewgate brain list/show/revoke`. **Off by default** (`phases.brain` absent → null).

## This session's merged work (PRs #1–#9 on master)
- **Gate loop fixes:** in-chain re-review (removed the blanket `stop_hook_active` short-circuit); re-arm budget on PASS/commit; visible gate states 🟢 GATE OPEN / 🔴 GATE CLOSED / 🟠 GATE ESCALATED; escalation block-once.
- **Review-reliability cluster (PR #2):** full changed-file content given to reviewers (kills false-positive "undefined symbol" findings; SSRF-safe — no symlink follow, size-bounded); REVIEW_OUTPUT_SCHEMA strict-mode valid (fixed codex `--output-schema` 400s); reviewer `status_detail` persisted in pending.json; curator proposal normalization (tolerant of overlong title/body).
- **Reviewer-timeout fix (PR #4):** `phases.review.fileContextBudgetBytes` configurable (default 32K, was 60K) → smaller prompts → fewer reviewer timeouts.
- **Dedup (PR #5 + #9):** merge near-identically-worded findings across reviewers (conservative Jaccard ≥0.6, deterministic clustering); region dedup key drops category (same-line findings reviewers categorized differently now merge); multi-category merges surface a `⚠ merges concerns categorized as…` note in details (masking guard); never over-merges distinct issues, representative keeps highest severity.
- **Critic observability (PR #6):** `pending.json.critic = { provider, status: ran|empty|error|misconfigured, verdicts, demoted }` — a configured-but-silent critic is now diagnosable.
- **OpenCode adapter (PR #7 + #8):** 5th provider — runs `opencode run --dangerously-skip-permissions --format default [-m provider/model] <prompt>`. Model `"default"` (or empty) → omits `-m` → uses opencode's OWN configured default (e.g. the MiniMax Token Plan). A real `provider/model` id forces it via `-m`. **Do NOT use `opencode/minimax-m2.7`** — that's the hosted, payment-gated model ("No payment method"). Verified: real opencode emits clean JSON that parseReviewOutput extracts.
- **Defaults:** gemini → `gemini-3-flash-preview` (the others ModelNotFound/quota). Removed the broken `reviewgate-self.yml` CI workflow (invalid YAML → failure emails). gemini reviewer+critic run via OAuth; only brain embeddings use OpenRouter.

## flashbuddy config (`/Users/markus/Developer/flashbuddy/reviewgate.config.ts`)
Plain object (NO `import` line). 4 reviewers (codex/security, openrouter[deepseek-v4-pro, 600s timeout]/security, gemini[gemini-3-flash-preview]/architecture, claude-code[sonnet-4-6]/adversarial). **critic = opencode/`default`/adversarial** (MiniMax Token Plan, genuine non-reviewer). brain enabled (embeddings `baai/bge-base-en-v1.5` via openrouter, egressAllowlist `[]`, no curator-LLM). loop.acknowledgePass true, notify.desktop true. opencode provider added (auth oauth, model `default`). OPENROUTER_API_KEY is set in flashbuddy's env (used by deepseek reviewer + brain embeddings).

## PENDING — the immediate next task: run the FULL test series in flashbuddy
The complete, systematic series is in **`TEST_PLAN.md`** (Layer 1 automated → Layer 2 gated real e2e → Layer 3 flashbuddy end-to-end T1–T13). The binary is rebuilt; **restart Claude Code in flashbuddy** first (loads latest config + binary + resets state).

Already validated in prior runs: T1 (M1 loop, audit chain), T2 (M2 panel/confirmed_by). NOT yet run with the latest fixes: **T3** (OpenCode/MiniMax critic via `default` — should now be `status:"ran"` instead of the earlier `"empty"` billing failure), **T4–T13**. Each Layer-3 test: tell the flashbuddy agent the Prompt from TEST_PLAN.md, have it `cp .reviewgate/pending.json /tmp/<id>.json` on the block before resolving, then inspect the snapshot here.

## Roadmap not yet built
- **M5** FP-Ledger (false-positive learning loop). **M6** cassette replay, weekly reports, `reviewgate stats`, live persona-bias detector, native sandbox (blocked on `@anthropic-ai/sandbox-runtime`).
- Possible follow-ups surfaced this session: critic "empty" finer status (parseable-but-empty vs unparseable); audit log doesn't record per-reviewer events (only gate.decision/escalation) — the iter-1 reviewer details are lost when iter-2 PASS overwrites pending.json.

## CRITICAL working-environment gotchas (read before touching git)
- **Shared working directory with a PARALLEL agent session.** Another session (Markus's "plan-doc-review" feature on branch `feat/plan-doc-review`) shares this checkout; the git HEAD has jumped between branches unnoticed, and a commit of mine once got orphaned onto the wrong branch. **Do NOT touch `feat/plan-doc-review`.** Coordinate before force/reset. Prefer: branch → PR → merge → delete (the established flow). Each merge moves master → tell the parallel session to rebase on the latest.
- **codex CLI and `opencode run` HANG / are flaky in this nested companion context** (0% CPU, no output). Don't rely on them from Bash here; real verification happens in the flashbuddy session. `codex exec` for reviews mostly worked but sometimes hung.
- **Workflow:** TDD → `bun test`/`typecheck`/`lint` → Codex+Claude review subagents (write findings to `.review/*.md`, FINDINGS/VERDICT format, PASS = 0 CRITICAL/WARN) → fix → re-review → `rm -rf .review/` → commit → PR → merge → `bun run build` → delete branch. Never commit Claude attribution. Never push without explicit OK (granted per-action this session).
- Memory: `/Users/markus/.claude/projects/-Users-markus-Developer-reviewgate/memory/` (user is German-speaking senior eng, milestone/subagent workflow, insists on REAL end-to-end verification — fakes hid bugs).
