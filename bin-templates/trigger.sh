#!/usr/bin/env bash
# Reviewgate PostToolUse hook driver — keep this script tiny.
# Reviewgate-managed; do not edit by hand.
set -u

# Resolve the reviewgate binary (baked path → PATH). Best-effort: a missing
# binary here only means dirty.flag isn't set; the Stop gate fails closed on its
# own, so never block a tool call on a missing trigger.
RG_BIN='__REVIEWGATE_BIN__'
if [ -z "$RG_BIN" ] || [ ! -x "$RG_BIN" ]; then
  RG_BIN="$(command -v reviewgate 2>/dev/null || true)"
fi
[ -z "$RG_BIN" ] && exit 0
exec "$RG_BIN" gate --hook trigger
