# Reviewgate — Next-Session Handoff

_Last updated: 2026-07-29 (nach S3 + S4). Supersedes all earlier content in this file._

## One-line state
**The whole arming/consent chain S1–S4 is implemented, pushed and CI-green**
(everything up to `origin/master` = `5c9dbbe`; the documentation commits AFTER it — lore + this handoff — are local only, check with `git log --oneline origin/master..master`). `reviewgate init
--user` exists, so the gate can finally fire in repos nobody initialised — which is what
made S1–S3 worth building. **Nothing of this is released:** npm `latest` is still
`0.1.0-alpha.14`, which predates S2.

## What got done this session

**S3 — worktree trust inheritance** (5 commits, pushed, CI green). A linked worktree runs
under the main checkout's approval while its own EFFECTIVE config equals it, then
materializes its own `control-plane.json` (`approved_via:"inherited-worktree"`).

**S4 — user-scoped hooks** (7 commits + 1 gate fix, pushed, CI green). `init --user`
installs Claude Code hooks into `~/.claude/settings.json` + shims into `~/.reviewgate/bin/`;
`--user --remove` takes them out. The shims stand down where a repo-local Claude hook
really fires, and fail OPEN when the binary is unresolvable.

Verified, not asserted:
- Suite **3022 pass / 12 skip / 0 fail** (3034 across 425 files) · tsc clean · biome clean
  (620 files) · **CI green** on `5c9dbbe`.
- **20 mutations killed** across the six S4 tasks, plus 6 in S3.
- Real-CLI dogfood in a TEMP home: install wrote only there, the real
  `~/.claude/settings.json` kept its exact SHA, nothing landed in the CWD, and `--remove`
  left a foreign PreToolUse hook and an unrelated setting untouched.
- The fail direction holds against a genuinely old binary: the installed
  `0.1.0-alpha.14` does not know `hooks repo-hook-active`, returns non-zero, and the shim
  correctly did NOT stand down.

## Current metrics
| | |
|---|---|
| HEAD | ahead of `origin/master` = `5c9dbbe` by the doc commits listed in `git log --oneline origin/master..master`; working tree clean |
| Suite | 3022 pass / 12 skip / **0 fail** — last full run at `5c9dbbe`; only markdown changed after it, tsc + biome re-verified since |
| Static | tsc clean · biome clean |
| CI | green (run 30476654931) |
| npm | `0.1.0-alpha.14` — **S2, S3 and S4 are all unreleased** |

## THE NEXT TASK — decide between three, they are not equal

1. **Release.** S2, S3 and S4 are all sitting unreleased, and the installed binary is old
   enough that any manual end-to-end test through `reviewgate` on PATH exercises
   pre-S2 behaviour. `bun run build` deploys to every repo via the
   `~/.local/bin/reviewgate` symlink, so decide deliberately.
2. **Dogfood `init --user` on this machine.** Deliberately NOT part of S4's end gate: a
   broken global Stop hook breaks every Claude Code session at once. Correct order is
   release (or at least `bun run build`) FIRST — otherwise the shims bake a path to the
   old binary, whose gate still writes `.reviewgate/` into unarmed repos.
3. **The lore backlog.** Three of four entries are drafts and therefore inert — only
   approved canon is injected. `worktree-gating` (new, this session) and the two older
   drafts want a promotion decision from Markus; the gate raises a canon-promotion finding
   for that. Writing more drafts before promoting these would not help.

## Traps that still hold

**New this session:**
- **`lore verify --all` WRITES.** It refreshes `verified_tree`/`verified_at` on every
  entry it checks. Running it "just to look" silently asserts re-verification you did not
  do; it rewrote two unrelated entries here and had to be reverted with `git checkout`.
  Read state with `loadLore` + `classifyEntry` instead.
- **`init` writes `.reviewgate/bin/` HOST-INDEPENDENTLY** (`init.ts`, before any host
  document). An executable gate shim therefore exists after `init --host codex` with NO
  Claude hook at all — never treat the shim's existence as evidence that a Claude hook
  fires.
- **The source fingerprint hashes the config PATH** (`global.ts` `layerSourceHash`), so it
  can never match across two checkouts. Effective-config comparison is not a preference.
- **Commit messages go through `eval`:** backticks in `git commit -m` are executed. One
  message here got Bun's help output spliced into it. Use `git commit -F <file>`.
- **A comment-only config edit is NOT effective drift** — the literal parser ignores it, so
  it is useless as a negative test input.
- **`PATH=/nonexistent` breaks the shims' shebang**, not just their binary lookup: they are
  `#!/usr/bin/env bash`, so the script exits 127 before its own logic runs. Use
  `/usr/bin:/bin` (has bash, has no reviewgate) for missing-binary cases.
- **Two mutations survived at first and forced better tests** rather than the reverse: the
  plain bare-parent case passes without the basename guard, and `isLinkedWorktree` was
  unkillable until a hand-written `.git` FILE pointing at an armed repo was added.

**Carried forward:**
- **Never hand-write a `control-plane.json` fixture** — use `tests/helpers/arm.ts`.
- **Tests must never touch the real `~/.claude/settings.json`** — always a temp home.
- **The arming branch in `gate.ts` is an ALLOWLIST on purpose.**
- **`bun run build` deploys to ALL repos**; `npm i -g reviewgate` clobbers that symlink.
- **Never `git add -A` at the repo root** (stages `.reviewgate/` runtime state) — note the
  exception used here, `git add -A .reviewgate/lore/`, which is the committed lore dir.
- **Suite flakes under load:** `sandbox-audit-fixes` and `cassette-pipeline` can fail in a
  full parallel run and pass isolated.
- **`doctor`'s codex quota cooldown was WRONG in the S2 session.** Still unverified.

## Read-first order
1. This file.
2. `docs/superpowers/specs/2026-07-29-user-scoped-hooks-s4-design.md` — the S4 design and
   the measured facts it rests on.
3. `docs/superpowers/plans/2026-07-29-user-scoped-hooks-s4.md` — especially the THREE
   plan-gate findings mappings at the end; 14 CRITICALs, and they explain why the code
   looks the way it does.
4. `src/hosts/user-hooks.ts` (`repoClaudeHookActive` is the predicate everything hangs off)
   and `bin-templates/user-gate.sh`.
