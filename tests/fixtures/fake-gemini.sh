#!/usr/bin/env bash
# Fake `agy -p` for the gemini-id reviewer adapter. agy prints the model
# response verbatim on stdout (no {response,stats} envelope, no token stats).
# When RG_ARGS_OUT is set, dump the received argv (one per line) for assertions.
set -u
[ -n "${RG_ARGS_OUT:-}" ] && printf '%s\n' "$@" > "$RG_ARGS_OUT"
cat <<'JSON'
{"verdict":"FAIL","findings":[{"severity":"WARN","category":"security","rule_id":"gem-rule","file":"x.ts","line":1,"message":"gemini finding","details":"d","confidence":0.8}]}
JSON
exit 0
