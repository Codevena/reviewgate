# Reviewgate — Next-Session Handoff

_Last updated: 2026-07-29, nach dem alpha.15-Release. Supersedes all earlier content._

## One-line state
**The whole arming/consent chain S1–S4 is implemented, pushed AND released.** `origin/master`
carries the release commit `c6c5f39`, tag `v0.1.0-alpha.15` is published and npm `latest` =
`0.1.0-alpha.15`. The one thing still on the old version is the **local** binary. (This file's
own commit may be unpushed — check `git status -sb`, don't assume either way.)

## What got done this session

**Released `v0.1.0-alpha.15`** — one commit (`c6c5f39`: version + four version-pinned install
examples), tag pushed, CI did the rest via OIDC.

Verified, not asserted:
- Before the tag: suite **3022 pass / 12 skip / 0 fail** · `tsc --noEmit` clean · biome clean
  (620 files) · `build:npm` + `verify:npm` clean.
- Release run **30488650056: all four jobs green** (release · publish-npm · native smoke
  macos-15 · native smoke ubuntu-latest); master CI 30488646036 green.
- **Against the real registry, not just CI-green:** `dist-tags.latest` = `0.1.0-alpha.15`,
  platform package likewise. Installed into a `mktemp` prefix: `added 2 packages` (no
  propagation gap), `--version` = alpha.15 — which is what proves the launcher resolved and
  spawned the platform binary — `hooks repo-hook-active` present, `init --help` documents
  `--user`/`--remove`, and the tree-sitter grammar path points **inside** the installed
  platform package (the `bun --compile` wasm trap that `bun test` structurally cannot catch).

**Two corrections to the previous handoff** (both worth knowing, because both cost time):
- Its "the doc commits are local only" was **false** — `git ls-remote` already showed
  `origin/master` at `1e9b8c7`. Same failure type as the 26.07. session. The claim was true
  when written and was overtaken by its own final push.
- **The version number was useless as a discriminator:** `package.json` and the installed
  binary both said `alpha.14`. What actually proved the binary was stale was its build mtime
  (25.07. vs S4 on 29.07.) and the missing `hooks` entry in its usage line.

## Current metrics
| | |
|---|---|
| commits | release commit = `c6c5f39` (pushed, tagged). For the LIVE head/push state read `git status -sb` + `git rev-parse HEAD @{u} \| uniq -c` (one line/count 2 = in sync) — do not trust a head hash written here, this file's own commit overtakes it |
| Suite | 3022 pass / 12 skip / **0 fail** (3034 across 425 files), run at this commit's content |
| Static | tsc clean · biome clean |
| CI | green — release 30488650056, master 30488646036 |
| npm | **`0.1.0-alpha.15` = `latest`** — S2, S3 and S4 are all released |
| local binary | ⚠️ **still alpha.14** (`dist/reviewgate`, built 25.07.) — see next task |

## THE NEXT TASK — `bun run build`, then `init --user`

`bun run build` is no longer a side step; it is the entry point, and the ordering is the whole
point:

1. **`bun run build`.** `dist/reviewgate` is still the 25.07. build reporting `alpha.14`, and
   `~/.local/bin/reviewgate` is a symlink to it that **every** repo on this machine resolves
   through. So despite the release, every local gate run and every manual `reviewgate` call
   still exercises pre-S2 behaviour. Publishing to npm did not change this.
2. **`reviewgate init --user`** (`src/hosts/user-hooks.ts:installUserHooks`). This is the
   deliberate dogfood step S4 left out of its end gate, for a real reason: a broken global
   Stop hook breaks every Claude Code session on the machine at once. It must come **after**
   the build, because the shims **bake the binary path in at install time** — run before the
   build and they pin the old binary, whose gate still writes `.reviewgate/` into unarmed
   repos. That is precisely the bug S2 fixed, reintroduced through the back door.

Then, separately: **the lore backlog.** Three of four entries are `status: draft` and
therefore inert — only approved canon is injected. Only `review-output-schema-strict` is canon
*and* has its `approvals.jsonl` line. `worktree-gating`, `snapshot-verified-not-live` and
`codex-sandbox-readonly-by-design` want a promotion decision from Markus; the gate raises a
canon-promotion finding for it. **Never self-promote** and never hand-write an approvals line.

## Traps that still hold

**New this session:**
- **A version string cannot tell you whether your binary is current.** `package.json` and the
  built binary carry the same number, so both say `alpha.14` while one predates four slices.
  Use the build mtime, or probe for a subcommand only the new binary has.
- **Never `npm i -g reviewgate` on this machine.** npm's global prefix here is `~/.local`, so
  a global install overwrites `~/.local/bin/reviewgate` — the symlink into this repo's `dist/`.
  Smoke-test in a `mktemp` prefix instead (the runbook says this; it is easy to skip).
- **`build:npm` is safe, `build` is not.** `scripts/build-npm-packages.ts` writes only into
  `npm-dist/` (explicit comment at :115). Plain `bun run build` deploys everywhere via symlink.
- **CI green ≠ a usable artifact.** The propagation lag makes optional deps fail *silently*
  (`added 1 package` + "unsupported platform"), which looks like a broken release and isn't.
  Check `added 2 packages` and `--version`.
- **`doctor` reports a codex quota cooldown until 2026-08-05T11:24Z** — a week out, with no
  plausible cause. Same suspicion as the S2 session, still unverified. A too-long cooldown
  silently drops the strongest reviewer from the panel; worth its own small investigation.

**Carried forward:**
- **`lore verify --all` WRITES** — it refreshes `verified_tree`/`verified_at`, i.e. asserts a
  re-verification you did not perform. To *read* state use `loadLore` + `classifyEntry`.
- **`init` writes `.reviewgate/bin/` HOST-INDEPENDENTLY**, so an executable gate shim exists
  after `init --host codex` with no Claude hook at all — never read the shim's existence as
  evidence that a Claude hook fires. This is why `repoClaudeHookActive` is structural.
- **The source fingerprint hashes the config PATH** (`global.ts` `layerSourceHash`), so it can
  never match across two checkouts. Effective-config comparison is not a preference.
- **Backticks in `git commit -m` are executed** (the tool wraps commands in `eval`). Use
  `git commit -F <file>`.
- **A comment-only config edit is NOT effective drift** — the literal parser ignores it, so it
  is useless as a negative test input.
- **`PATH=/nonexistent` breaks the shims' shebang** (`#!/usr/bin/env bash` → exit 127 before
  their own logic). Use `/usr/bin:/bin` for missing-binary cases.
- **Never hand-write a `control-plane.json` fixture** — use `tests/helpers/arm.ts`.
- **Tests must never touch the real `~/.claude/settings.json`** — always a temp home.
- **The arming branch in `gate.ts` is an ALLOWLIST on purpose.**
- **Never `git add -A` at the repo root** (stages `.reviewgate/` runtime state); the one
  exception is `git add -A .reviewgate/lore/`, the committed lore dir.
- **Suite flakes under load:** `sandbox-audit-fixes` and `cassette-pipeline` can fail in a full
  parallel run and pass isolated.
- **The pre-push hook is warn-only** (`exit 0` unconditionally) — its "not the last reviewed
  HEAD" warning is expected when you push a commit the gate has not reviewed yet, and it does
  not block.

## Read-first order
1. This file.
2. `docs/dev/2026-06-23-npm-publish-runbook.md` — the release path, incl. the isolated-prefix
   smoke test and the propagation-lag behaviour.
3. `docs/superpowers/specs/2026-07-29-user-scoped-hooks-s4-design.md` §3.1–3.2 — what
   `init --user` writes and the two deliberate shim differences, before activating it here.
4. `src/hosts/user-hooks.ts` (`repoClaudeHookActive` is the predicate everything hangs off)
   and `bin-templates/user-gate.sh`.
