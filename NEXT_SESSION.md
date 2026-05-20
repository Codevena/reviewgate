# Reviewgate — Session Handoff (Implementation Start)

**Date:** 2026-05-20
**Status:** Design phase complete, ready for implementation
**Previous session:** Opus 4.7, ~1.5 hours, brainstorming → spec → multi-reviewer audit → M1 plan

---

## 0. TL;DR for the next session

```
You are starting fresh in /Users/markus/Developer/reviewgate.
The brainstorming, design spec, and M1 implementation plan
are already done and committed locally (no remote).

Read this file. Then:

  1. Read  docs/superpowers/specs/2026-05-20-reviewgate-design.md   (spec)
  2. Read  docs/superpowers/plans/2026-05-20-reviewgate-m1-minimum-viable-loop.md  (plan)
  3. Invoke the skill: superpowers:subagent-driven-development
  4. Start dispatching task implementers per the plan

User-driven spikes S1/S2/S3 require fresh Claude Code sessions
and are blocked on the user. Tell the user when you hit them.
All other spikes (S4–S7) and Tasks 1–13 are subagent-executable
without any spike output, so start there.
```

---

## 1. What's already done

| Artifact | Path | Status |
|---|---|---|
| Design spec (1641 lines) | `docs/superpowers/specs/2026-05-20-reviewgate-design.md` | ✅ Codex r3 PASS + Claude r2 PASS |
| M1 implementation plan (5345 lines, 28 tasks + 7 spikes) | `docs/superpowers/plans/2026-05-20-reviewgate-m1-minimum-viable-loop.md` | ✅ Written, self-reviewed, no placeholders |
| Audit trail of all reviews | `.review/*.md` | ✅ Codex r1/r2/r3 + Claude r1/r2 findings |
| Git history | 5 local commits, no remote | ✅ Clean |

```
git log --oneline:
  6e93404 docs: M1 implementation plan — 7 spikes + 28 tasks across 11 phases
  1e323fd docs: address Claude-r2 nit + 2 INFO clarifications
  3d81159 docs: address Claude-reviewer findings (4 CRITICAL + 8 WARN)
  168f209 docs: revise Reviewgate design spec per Codex review
  ccf1a2f docs: add Reviewgate v1 design spec
```

---

## 2. What Reviewgate is (1 paragraph context)

Reviewgate is a multi-agent code-review tool that auto-invokes from inside Claude
Code's agent loop. When Claude Code edits files in a Reviewgate-initialised repo,
Reviewgate spawns one or more heterogeneous LLM reviewers (Codex, Gemini, Claude
as fresh subprocess — never the host session) as isolated sandboxed subprocesses,
aggregates findings under a severity-weighted veto rule, and blocks Claude's
turn-end via the Stop hook until each finding is either fixed or
rejected-with-reason in `.reviewgate/decisions/<iter>.jsonl`. Reviewgate maintains
a curated per-repo learning "brain" (M4+). Users on Claude Pro/Max + ChatGPT
Plus/Pro + Gemini Advanced pay **$0** per review within their subscription quotas
(OAuth-first auth model).

**v1 = M1 + M2 + M3 + M4 + M5 + M6.** This plan covers **M1 only** (Minimum
Viable Loop). M1 ships one reviewer (Codex), single phase pair (Static + Review),
no critic, no brain, no FP-ledger, no triage adaptive logic. Those are M2–M6.

---

## 3. Critical design rules that must hold

These are non-negotiable. If implementation drifts from them, escalate to the
user before fixing.

1. **Author ≠ Reviewer.** Host Claude Code session must never review its own
   work. Anti-sycophancy hard rule. See spec §5.4 rule 1 (host-model detection
   chain).
2. **All reviewer subprocesses are sandboxed.** Seatbelt on macOS, bubblewrap on
   Linux. Windows = fail-closed (use WSL2). See spec §5.4 + §8.
3. **Findings live in files, never in stdout.** `pending.md` for Claude (Read
   tool) + `pending.json` for machines. Stop-hook response uses ONLY
   `decision: "block"` + `reason` (no `additionalContext` in v1; pending spike S2).
4. **Audit chain uses sha256, hash-chained per event.** No SHA-1 anywhere. See
   §5.5 (signature) + §5.7 (audit).
5. **Prompt sanitisation has 6 layers** (NFKC normalise → injection-marker
   neutralise → comment containment → fenced wrap → entropy redaction → persona
   reaffirmation). See §8.3.
6. **Cost cap applies ONLY in apikey/openrouter mode.** OAuth mode is free
   within subscription quotas. See §9.
7. **Foreground always.** `codex exec` and similar must run in foreground (the
   well-known 0-byte-output bug when wrapped in eval). Plan's spawn helper
   handles this. See spec §5.4 pitfalls table.

---

## 4. How to start the next session

### Step 4.1 — Open a fresh Claude Code session in this repo

```bash
cd /Users/markus/Developer/reviewgate
claude
```

You'll get a fresh context. Don't try to recover the previous session.

### Step 4.2 — Tell the new session what to do

Paste exactly this into the first prompt:

> Read `NEXT_SESSION.md` first, then the spec at
> `docs/superpowers/specs/2026-05-20-reviewgate-design.md`, then the M1 plan at
> `docs/superpowers/plans/2026-05-20-reviewgate-m1-minimum-viable-loop.md`.
> Then invoke `superpowers:subagent-driven-development` and start executing
> the M1 plan from Task 1 onwards. Stop only for user-driven spikes (S1–S3) or
> genuine blockers. Continuous execution otherwise.

### Step 4.3 — Be ready for the user-driven spikes

Spikes **S1, S2, S3** require **you** (the user) to open fresh throwaway Claude
Code sessions in `/tmp/reviewgate-spike-s1` and observe Stop-hook behavior. The
plan has the exact bash commands. The new session will tell you when it hits
those — you can run them in parallel while implementation rolls.

If you want to do the spikes first (cleaner): run S1, S2, S3 yourself in the
order they appear in the plan's Pre-flight section, write their summaries to
`docs/superpowers/spikes/M1/SX-*.md`, commit, then start the implementation
session. The implementation session's spike-dependent tasks (Tasks 14, 21, 22)
will then have the data they need.

---

## 5. Known open items / decisions deferred to implementation

These were intentionally left for the implementation session because they
depend on spike outcomes:

| Item | Plan location | Resolution mechanism |
|---|---|---|
| Stop-hook `additionalContext` support | Spike S2 / §5.2 | If supported, optional optimisation in Task 19 |
| Host-model detection actual surface | Spike S3 / §5.4 rule 1 / Task 8 | Fallback chain documented; spike confirms which sources work |
| Codex `--output-schema` reliability | Spike S4 / §5.4 / Task 16 | If <90 % schema-conform, fall back to Markdown findings-file regex parse |
| Sandbox-runtime API exact shape | Spike S5 / Task 14 | Confirm `runInSandbox` signature; adjust import in `src/sandbox/manager.ts` |
| Codex double-sandbox interaction | Spike S6 / Task 14+16 | If conflict, drop our outer sandbox for Codex only |
| Claude `--tools` actual restriction | Spike S7 / §5.4 | M2-only concern; M1 has no Claude reviewer |

---

## 6. Subagent dispatch strategy (refresher)

The `subagent-driven-development` skill says:

- Dispatch fresh subagent per task (no context sharing with controller).
- Two-stage review: spec compliance reviewer first, then code quality reviewer.
- Continuous execution: don't pause to check in between tasks.
- Stop only on BLOCKED, ambiguity, or all-tasks-complete.

Model selection per task:
- Tasks 1–7 (bootstrap + schemas): mechanical → cheap model (Haiku-class or Sonnet)
- Tasks 8–13 (utilities + state + audit + diff): cheap–standard
- Tasks 14–16 (sandbox + provider): standard (Sonnet)
- Tasks 17–20 (aggregator + orchestrator + loop FSM): standard
- Tasks 21–22 (hooks + init): standard
- Tasks 23–25 (CLI): cheap–standard
- Tasks 26–28 (integration + dogfood): standard

Reviewer subagents (spec + quality): standard model.

---

## 7. CLAUDE.md operating rules (carry forward)

From `~/.claude/CLAUDE.md` — the user's global rules:

- Never push to remote without explicit permission.
- Never amend commits, always create new commits.
- Use `console.warn`/`console.error` in JS files, no custom logger.
- Prisma 6.x (not 7.x) — irrelevant here since we use zod, but note for future.
- After code changes, ALWAYS run `pnpm build` / `tsc --noEmit` before committing.
  In Reviewgate's case: `bun run typecheck` + `bun run lint` + `bun test`.

The plan's per-task structure already includes typecheck/test/commit as
explicit steps. Trust the plan.

---

## 8. If something goes wrong

- **Implementation session gets confused / drifts:** stop, ask user. Don't
  paper over with hacks.
- **Subagent reports BLOCKED:** read its reason; if it's a missing context
  problem, provide it; if it's a plan problem, escalate to user; if it's a
  capability problem, re-dispatch with a more capable model.
- **A spike outcome contradicts the plan:** update the relevant Task in the
  plan BEFORE the implementer touches that task. Commit the plan change.
  Then dispatch.
- **Codex hangs at 0 % CPU:** the foreground / prompt-file rules in §5.4 of
  the spec exist exactly for this. Check that `spawnSafely` (Task 16) uses
  `child_process.spawn` not `exec`, prompts come from a file, and run is
  foreground.

---

## 9. Final commit before the session handoff

This file (`NEXT_SESSION.md`) is being committed alongside this handoff so the
git log marks the clean break between design phase and implementation phase.

```
6e93404 docs: M1 implementation plan — 7 spikes + 28 tasks across 11 phases
1e323fd docs: address Claude-r2 nit + 2 INFO clarifications
3d81159 docs: address Claude-reviewer findings (4 CRITICAL + 8 WARN)
168f209 docs: revise Reviewgate design spec per Codex review
ccf1a2f docs: add Reviewgate v1 design spec
[next]  docs: NEXT_SESSION.md handoff for implementation phase
```

Good luck. Build it well. 🚀
