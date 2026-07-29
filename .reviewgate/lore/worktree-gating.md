---
schema: reviewgate.lore.v1
id: worktree-gating
status: canon
anchors:
  - "src/config/control-plane.ts"
  - "src/hosts/user-hooks.ts"
  - "src/cli/commands/init.ts"
  - "bin-templates/user-gate.sh"
verified_at: 2026-07-29
verified_tree: "4fc71c6e5d8c7fce6108bdbbfdeac32ef6864821c6d868858a1bc9c28bf1931c"
tags: []
---
Why worktree gating is two independent problems, and why reviewers should not
"simplify" either half. Arming (may this checkout run the gate?) and hooks (does
anything fire here at all?) are separate, and each was closed by its own slice.

Trust: a linked worktree inherits the main checkout's approval when its own
EFFECTIVE config (defaults <- global <- project) equals that approval, then
materializes its own control-plane.json. The comparison must be over the effective
merged config, never a hash of the committed project file: the global layer is
per-machine and uncommitted, so a project-file rule would let a global-config edit
silently change policy in every inheriting worktree. It also cannot use the SOURCE
fingerprint, which hashes the config PATH and therefore never matches across two
checkouts by construction.

Hooks: `.reviewgate/bin/` shims are written host-INDEPENDENTLY by init, before any
host document, so an executable gate shim also exists after `init --host codex`
where no Claude hook exists at all. The user-scoped shim must therefore never key
its stand-down on the shim's existence — that silences it in exactly the repos
where nothing else fires. It asks `reviewgate hooks repo-hook-active --event <E>`,
a structural check requiring the event's EXACT installer-emitted command plus a
runnable shim, and treats every non-zero answer (including an older binary that
does not know the subcommand) as "run". Standing down when nothing else runs ends
the turn un-reviewed; running twice only costs a lock wait.

The two shims also fail in opposite directions on purpose: repo-local fails CLOSED
on an unresolvable binary, user-scoped fails OPEN with a stderr warning, because a
globally installed hook that blocked every turn in every repo would be
uninstallable.
