#!/usr/bin/env bash
# Reviewgate Stop hook driver — keep this script tiny.
# Reviewgate-managed; do not edit by hand.
set -u

# Resolve the reviewgate binary: the absolute path `init` baked in (the binary
# that ran init), else PATH. If NEITHER resolves, FAIL CLOSED — emit a block
# decision rather than exiting 127 with empty stdout, which an agent host can
# treat as a successful hook, silently turning the Stop gate into a no-op.
RG_BIN='__REVIEWGATE_BIN__'
if [ -z "$RG_BIN" ] || [ ! -x "$RG_BIN" ]; then
  RG_BIN="$(command -v reviewgate 2>/dev/null || true)"
fi
if [ -z "$RG_BIN" ]; then
  printf '%s\n' '{"decision":"block","reason":"Reviewgate could not run the Stop gate: the reviewgate binary is not on PATH and no baked path resolved. Failing CLOSED so unreviewed changes are not silently allowed. Fix: put the reviewgate binary on PATH (or re-run `reviewgate init` with it installed), then run `reviewgate doctor`."}'
  exit 0
fi
# Run the gate (NOT `exec`): if RG_BIN resolves to a file that can't actually run on
# this host (wrong arch → ENOEXEC → exit 126, bad interpreter, or vanished → 127),
# `exec` would replace bash and die with EMPTY stdout — which an agent host may
# treat as successful, a silent fail-OPEN. Running it as a child lets us catch 126/127 and
# emit a fail-CLOSED block instead. Normal runs pass the gate's stdout + exit code through.
"$RG_BIN" gate --hook stop
rc=$?
if [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ]; then
  printf '%s\n' '{"decision":"block","reason":"Reviewgate resolved a binary but could not run it on this host (wrong architecture / bad interpreter / not executable). Failing CLOSED so unreviewed changes are not silently allowed. Re-run `reviewgate init` with the correct binary for this machine, then `reviewgate doctor`."}'
  exit 0
fi
exit "$rc"
