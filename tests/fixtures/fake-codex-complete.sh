#!/usr/bin/env bash
# Fake `codex exec` for complete(): MUST NOT receive --output-schema (a judge
# needs free-form). Writes a JUDGE-shaped JSON (echoing OPENAI_API_KEY) to the
# --output-last-message file. Toggles: RG_FAKE_FAIL=1 -> exit 7;
# RG_FAKE_EMPTY=1 -> empty last-message file.
set -u
LAST_MSG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output-schema) echo "schema flag must not reach complete()" >&2; exit 3 ;;
    --output-last-message) LAST_MSG="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ "${RG_FAKE_FAIL:-}" = "1" ] && { echo "boom" >&2; exit 7; }
if [ -n "$LAST_MSG" ]; then
  if [ "${RG_FAKE_EMPTY:-}" = "1" ]; then
    : > "$LAST_MSG"
  else
    printf '{"contradicts":false,"reason":"k=%s"}\n' "${OPENAI_API_KEY:-NONE}" > "$LAST_MSG"
  fi
fi
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
exit 0
