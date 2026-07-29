#!/usr/bin/env bash
# Reviewgate USER-SCOPED Stop hook driver — keep this script tiny.
# Reviewgate-managed; do not edit by hand.
#
# Two deliberate differences from the repo-local shim (bin-templates/gate.sh):
#
#   1. It STANDS DOWN when this repo has a repo-local CLAUDE Stop hook that will fire
#      for the same event. User and project hooks MERGE and both run, and they only
#      dedup on an identical command string, so without this the same checkout would
#      run two gates: duplicate gate.lock contention and duplicate reviewer quota. It
#      is a COST guard, not a safety one — a Stop hook cannot express "allow", so a
#      silent exit can never weaken the repo-local verdict.
#
#      The evidence must be POSITIVE and it must be about CLAUDE. `.reviewgate/bin/`
#      shims are written host-independently by `init`, so an executable gate shim also
#      exists after `init --host codex`, where no Claude hook exists at all. The check
#      is therefore STRUCTURAL and lives in TypeScript: `hooks repo-hook-active
#      --event Stop` exits 0 only when the Stop event carries this repo's EXACT managed
#      gate command AND that shim is a runnable regular file. Any non-zero answer —
#      including an unsupported event or a missing binary — means RUN.
#
#   2. It fails OPEN. A user-scoped hook fires in EVERY repo the user opens; blocking
#      every turn everywhere because a binary is missing would make the feature
#      uninstallable. The repo-local shim fails CLOSED on purpose.
#
# stdout is the decision channel: nothing but the gate's own output may go there.
set -u

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD")"

RG_BIN='__REVIEWGATE_BIN__'
if [ -z "$RG_BIN" ] || [ ! -x "$RG_BIN" ]; then
  RG_BIN="$(command -v reviewgate 2>/dev/null || true)"
fi
if [ -z "$RG_BIN" ]; then
  printf '%s\n' 'Reviewgate: user-scoped gate SKIPPED — the reviewgate binary is not on PATH and no baked path resolved, so this turn was NOT reviewed. Fix: reinstall the binary, run `reviewgate init --user`, then `reviewgate doctor`.' >&2
  exit 0
fi

# cd BEFORE the query: it answers for the process working directory, so asking from a
# subdirectory would miss a real repo-local hook and run a duplicate gate.
cd "$ROOT" || exit 0

if "$RG_BIN" hooks repo-hook-active --event Stop >/dev/null 2>&1; then
  exit 0
fi

"$RG_BIN" gate --hook stop
rc=$?
if [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ]; then
  printf '%s\n' 'Reviewgate: user-scoped gate SKIPPED — resolved a binary but could not run it on this host (wrong architecture / bad interpreter), so this turn was NOT reviewed. Re-run `reviewgate init --user`, then `reviewgate doctor`.' >&2
  exit 0
fi
exit "$rc"
