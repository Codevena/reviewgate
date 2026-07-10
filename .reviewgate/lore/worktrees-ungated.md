---
schema: reviewgate.lore.v1
id: worktrees-ungated
status: draft
anchors:
  - "src/cli/commands/init.ts"
  - "src/utils/git.ts"
verified_at: 2026-07-10
verified_tree: "4249636f1e8895a3494d3fbf6d81d6d604c558f5facb976e44e921829272f335"
tags: []
---
Why a linked git worktree is a coverage blind spot: Reviewgate arms per-checkout.
`init` writes `.reviewgate/bin/` and the Stop/PostToolUse/SessionStart hooks into
THAT checkout's `.claude/settings.json`. A `git worktree` shares only `.git` — it
has its own working dir with no `.reviewgate/` and no `.claude/settings.json`, and
Claude Code loads hooks from the worktree's own dir. So the Stop gate never fires
inside a worktree and that work ends un-reviewed — a fail-OPEN, the opposite of
the gate's usual fail-closed posture.

The main checkout's hooks do NOT propagate. To gate a worktree you must run
`reviewgate init` inside it (the pre-push hook auto-skips there since `.git` is a
file), or do the work in / merge to the gated main checkout. `doctor` FAILs when
run inside an un-gated linked worktree so the blind spot is at least loud.
