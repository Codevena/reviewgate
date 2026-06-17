#!/usr/bin/env bash
# Reviewgate git pre-push driver — WARN-ONLY, never blocks the push. Keep this tiny.
# Reviewgate-managed; do not edit by hand.
set -u

# Resolve the reviewgate binary: the absolute path `init` baked in, else PATH.
RG_BIN='__REVIEWGATE_BIN__'
if [ -z "$RG_BIN" ] || [ ! -x "$RG_BIN" ]; then
  RG_BIN="$(command -v reviewgate 2>/dev/null || true)"
fi
# Warn-only contract: if the binary can't be resolved we must NOT block the push.
# Exit 0 silently (the push proceeds; the Stop-hook gate is the primary safety net).
if [ -z "$RG_BIN" ]; then
  exit 0
fi
# Forward git's pre-push stdin (the "<local ref> <local oid> <remote ref> <remote oid>"
# lines) and args. `|| true` + explicit exit 0 guarantee we never fail the push.
"$RG_BIN" pre-push "$@" || true
exit 0
