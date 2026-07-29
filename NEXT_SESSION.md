# Reviewgate — Next-Session Handoff

_Last updated: 2026-07-30, nach der Rig-Session (Tasks 1–3). Supersedes all earlier content._

## One-line state

The local toolchain is finally current (alpha.15 binary built, user-scoped hooks active) and
**Phase 1 — the longitudinal effectiveness rig — is three tasks in**: turn-script schema,
12-turn pilot script, and a driver that snapshots each turn. **Everything since `3eb8507` is UNPUSHED.**

## What got done — and how it was verified

**The local binary was the blocker and is fixed.** `bun run build` — verified by probe, not
by version string: `hooks` now appears in the usage line (the version alone cannot tell you,
`package.json` and a stale build say the same thing). `~/.local/bin/reviewgate` resolves to it.

**`reviewgate init --user` is active here.** Verified live, all four cases: merge into
`~/.claude/settings.json` left `brain-reminder.sh` and PreToolUse untouched; in this (armed)
repo the shim stands down instantly with no output; in an unarmed repo it wrote **nothing**
(no `.reviewgate/`); with an unapproved config present it printed the loud 🟠 notice and still
wrote nothing. `doctor` reports `✓ user-scoped hooks … with a runnable Stop gate`.

**The codex cooldown was never a bug.** Live probe: `ERROR: You've hit your usage limit …
try again at Aug 5th, 2026 1:24 PM` — to the minute the stored `reset_at`, with
`source: "parsed"`. Two sessions of suspicion refuted. What was actually wrong was the
*display*: `doctor` showed the time but not its provenance, so a provider-reported cap and
our own backoff guess looked identical. Fixed, reusing the existing `cooldownReasonLabel`.

**Phase-1 plan is plan-gated** (agy round 1 FAIL with 2 CRITICAL → fixed → round 2 PASS) and
**Tasks 1–3 are built**: the feasibility spike (hooks DO fire under `claude -p`, and the
FAIL → decision → re-review loop runs in-chain in ONE invocation), the turn-script schema +
`rig/scripts/pilot-01.json`, and `src/rig/driver.ts` + `reviewgate rig run`.

## Current metrics

| | |
|---|---|
| HEAD | last CODE commit is `3e24fdb`; this handoff's own commit sits on top of it. Working tree clean |
| Push state | **NOT pushed.** `origin/master` is `3eb8507`; everything after it is local. Read the LIVE count with `git rev-parse HEAD @{u} \| uniq -c` — one line/count 2 = in sync — because this file's own commit changes the number the moment it is written |
| Suite | **3054 pass / 12 skip / 0 fail** (3066 across 428 files), run on exactly this content |
| Static | `bunx tsc --noEmit` clean · biome clean (627 files) |
| Gate | ran on HEAD and returned **PASS** (0 CRITICAL, 0 WARN, 4 INFO) |
| Local binary | `0.1.0-alpha.15`, current (built 29.07. 22:40) |

## THE NEXT TASK — Task 4, the harvester

`docs/superpowers/plans/2026-07-29-longitudinal-effectiveness-rig.md`, Task 4. It is next
because everything before it only *collects*; Task 4 is where snapshots become numbers, and
until it exists there is no baseline — which is the whole reason Phase 1 comes before the
aggregator refactor (a behaviour-neutral refactor you cannot measure is a refactor you can
only hope about).

Entry points: create `src/rig/harvest.ts` and `src/schemas/rig-result.ts`. **Reuse, do not
rebuild:** `loadAuditWindow` (`src/stats/load.ts`) already parses the audit tree into
`{ runs: {ts, run_id, iter, summary}[], decisions, escalationCount }` through
`RunSummarySchema`/`DecisionOutcomeSchema`, including a −1-day partition guard for processes
crossing UTC midnight. `makeMetric(num, den)` (`src/bench/metrics.ts`) returns every rate with
a Wilson CI and `value: null` when `den === 0`.

## Traps that still hold

**New, and the two that would have made the rig lie:**

- **A clean-PASS re-arm WIPES `state.json` and `decisions/`.** After a turn ends green the
  state reads `iteration: 0`, empty stats, no decisions dir. Harvesting those would silently
  report zero for exactly the turns that worked. The durable record is the hash-chained
  `.reviewgate/audit/<Y>/<M>/<D>/*.jsonl` — several files per turn, one per gate process.
- **The finding signature is SHA-256** over `[file, ruleId, category, symbol, offset]`, so the
  rule id is NOT recoverable from it, and the audit log carries no finding text. That is why
  `src/rig/driver.ts` archives every `pending.{json,md}` version that appears *during* a turn
  into `<turn>/reports/`. **Do not remove that archiver as redundant** — without it recall
  (M3) cannot be computed at all.
- **`Bun.spawn` does NOT deadlock on undrained pipes.** Measured: 128MB in 1.1s. Two reviewers
  reported the opposite as CRITICAL at confidence 0.97, reasoning from Node `child_process`.
  The driver writes to an fd for two *different* reasons (per-turn transcript; keeping
  multi-MB turns out of parent memory). Do not re-add a deadlock rationale — it is false.
  Draft lore entry: `.reviewgate/lore/bun-spawn-pipes-do-not-deadlock.md`.
- **Never run the full suite concurrently with an agentic CLI.** Four load incidents in one
  night, once **72** "failures" — all exactly 5000ms timeouts, all green in isolation. Twice
  the load came from other projects entirely (`playwright install`, `next-server` at 178% CPU).
  Check `uptime` before trusting a red suite.
- **`agy` needs an ABSOLUTE findings path.** With a relative one it writes to
  `~/.gemini/antigravity-cli/scratch/<path>` — or claims success and writes nothing at all
  (seen once). Also feed the prompt INLINE; otherwise agy enters its agentic ReadFile crawl
  and times out.
- **`init --user` turned this repo's own suite red** — `worktree-gating.test.ts` read the real
  `~/.claude/settings.json`. Fixed with a temp home. If a doctor check takes a `home`
  argument, tests must pass one.

**Carried forward:**

- **`lore verify --all` WRITES** (refreshes `verified_tree`/`verified_at`, i.e. asserts a
  re-verification you did not perform). To read state use `reviewgate lore status`.
- **Backticks in `git commit -m` are executed** — always `git commit -F <file>`.
- **Never `git add -A` at the repo root** (stages `.reviewgate/` runtime state); the one
  exception is `git add -A .reviewgate/lore/`.
- **Never `npm i -g reviewgate` on this machine** — npm's global prefix is `~/.local`, which
  would overwrite the symlink into `dist/`. Smoke-test in a `mktemp` prefix.
- **`bun run build` deploys everywhere** via that symlink. `build:npm` is the safe one.
- **codex is genuinely out of quota until `2026-08-05T11:24Z`.** Not a bug — do not
  re-investigate. Use `agy` as the external reviewer until then.
- **Tests must never touch the real `~/.claude/settings.json`** — always a temp home.
- **The pre-push hook is warn-only** (`exit 0` unconditionally).

## Open decisions for Markus

1. **Push?** Everything since `3eb8507` — all gate-passed and green.
2. **Canon promotion** for `bun-spawn-pipes-do-not-deadlock` (draft). Never self-promoted.
3. **Small fix, not yet done:** the gate's block message does not name its state directory.
   Observed in dealbarg, which has two `.reviewgate/` dirs in one git repo (the subdir was
   separately `init`ed on 16.07.) — the agent read the wrong report and nearly reported a
   contradiction that did not exist. Same class as the `doctor` provenance fix.

## Read-first order

1. This file.
2. `docs/superpowers/plans/2026-07-29-longitudinal-effectiveness-rig.md` — Task 4, plus the
   "Revision after Task 1 execution" table at the end (8 findings that changed the plan).
3. `docs/dev/2026-07-29-headless-gate-spike.md` — what a real turn actually produces.
4. `src/rig/driver.ts` (`startReportArchiver`, `awaitQuiescent`) and `src/stats/load.ts`
   (`loadAuditWindow`) before writing the harvester.
