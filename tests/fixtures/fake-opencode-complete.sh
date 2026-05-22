#!/usr/bin/env bash
# Fake `opencode run --format default` for complete(): prints a JUDGE-shaped
# JSON to stdout. Toggles: RG_FAKE_FAIL=1 -> exit 7; RG_FAKE_EMPTY=1 -> no stdout.
set -u
[ "${RG_FAKE_FAIL:-}" = "1" ] && { echo "boom" >&2; exit 7; }
[ "${RG_FAKE_EMPTY:-}" = "1" ] && exit 0
printf '%s\n' '{"contradicts":false,"reason":"opencode-judge"}'
exit 0
