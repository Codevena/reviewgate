#!/usr/bin/env bash
# Reviewgate USER-SCOPED SessionStart driver. Reviewgate-managed; do not edit by hand.
#
# Silent by design: this fires on every matching event in every repo the user opens, so
# a warning here would be noise. The Stop shim is where a missing binary is reported.
# Same structural stand-down rule as the gate shim, scoped to THIS event's command; any
# non-zero answer from the query means RUN.
set -u

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PWD")"

RG_BIN='__REVIEWGATE_BIN__'
if [ -z "$RG_BIN" ] || [ ! -x "$RG_BIN" ]; then
  RG_BIN="$(command -v reviewgate 2>/dev/null || true)"
fi
[ -n "$RG_BIN" ] || exit 0

cd "$ROOT" || exit 0

if "$RG_BIN" hooks repo-hook-active --event SessionStart >/dev/null 2>&1; then
  exit 0
fi

"$RG_BIN" gate --hook reset
exit 0
