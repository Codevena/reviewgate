#!/usr/bin/env bash
# Fake `gemini -p -o json` for complete(): emits the outer envelope with a
# JUDGE-shaped JSON inside `response`, echoing the (possibly remapped)
# GEMINI_API_KEY. Toggles: RG_FAKE_FAIL=1 -> non-zero exit; RG_FAKE_EMPTY=1 ->
# envelope w/o response.
set -u
[ "${RG_FAKE_FAIL:-}" = "1" ] && { echo "boom" >&2; exit 7; }
if [ "${RG_FAKE_EMPTY:-}" = "1" ]; then
  printf '%s\n' '{"session_id":"fake"}'
  exit 0
fi
printf '{"session_id":"fake","response":"{\\"contradicts\\":false,\\"reason\\":\\"k=%s\\"}"}\n' "${GEMINI_API_KEY:-NONE}"
exit 0
