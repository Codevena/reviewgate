#!/usr/bin/env bash
# Fake `claude -p --output-format json` for complete(): emits the result
# envelope with a JUDGE-shaped JSON inside `result`, echoing the (possibly
# remapped) ANTHROPIC_API_KEY so the auth test can read what arrived.
# Toggles: RG_FAKE_FAIL=1 -> non-zero exit; RG_FAKE_EMPTY=1 -> envelope w/o result.
set -u
[ "${RG_FAKE_FAIL:-}" = "1" ] && { echo "boom" >&2; exit 7; }
if [ "${RG_FAKE_EMPTY:-}" = "1" ]; then
  printf '%s\n' '{"type":"result","subtype":"success","total_cost_usd":0}'
  exit 0
fi
printf '{"type":"result","subtype":"success","result":"{\\"contradicts\\":false,\\"reason\\":\\"k=%s\\"}","total_cost_usd":0}\n' "${ANTHROPIC_API_KEY:-NONE}"
exit 0
