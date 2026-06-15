#!/usr/bin/env bash
# Reviewgate Stop hook driver — keep this script tiny.
# Reviewgate-managed; do not edit by hand.
set -u

# Resolve the reviewgate binary: the absolute path `init` baked in (the binary
# that ran init), else PATH. If NEITHER resolves, FAIL CLOSED — emit a block
# decision rather than exiting 127 with empty stdout, which Claude Code reads as
# "allow stop", silently turning the Stop gate into a no-op on every turn.
RG_BIN="__REVIEWGATE_BIN__"
if [ -z "$RG_BIN" ] || [ ! -x "$RG_BIN" ]; then
  RG_BIN="$(command -v reviewgate 2>/dev/null || true)"
fi
if [ -z "$RG_BIN" ]; then
  printf '%s\n' '{"decision":"block","reason":"Reviewgate could not run the Stop gate: the reviewgate binary is not on PATH and no baked path resolved. Failing CLOSED so unreviewed changes are not silently allowed. Fix: put the reviewgate binary on PATH (or re-run `reviewgate init` with it installed), then run `reviewgate doctor`."}'
  exit 0
fi
exec "$RG_BIN" gate --hook stop
