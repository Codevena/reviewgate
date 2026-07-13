#!/usr/bin/env bash
# Reviewgate SessionStart hook driver for Claude Code and Codex — keep this script tiny.
# Reviewgate-managed; do not edit by hand.
set -u

# Resolve the reviewgate binary (baked path → PATH). Best-effort: a missing
# binary at session start is non-fatal (no state to clear), so never block.
RG_BIN='__REVIEWGATE_BIN__'
if [ -z "$RG_BIN" ] || [ ! -x "$RG_BIN" ]; then
  RG_BIN="$(command -v reviewgate 2>/dev/null || true)"
fi
[ -z "$RG_BIN" ] && exit 0
exec "$RG_BIN" gate --hook reset
