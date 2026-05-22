#!/usr/bin/env bash
# Fake `codex exec` for complete(): MUST NOT receive --output-schema (a judge
# needs free-form) and MUST receive --skip-git-repo-check (the judge runs in a
# fresh non-git temp dir; real codex refuses it otherwise). Writes a JUDGE-shaped
# JSON (echoing OPENAI_API_KEY) to the --output-last-message file. Toggles:
# RG_FAKE_FAIL=1 -> exit 7; RG_FAKE_EMPTY=1 -> empty last-message file.
set -u
LAST_MSG=""
SAW_SKIP_GIT=0
while [ $# -gt 0 ]; do
  case "$1" in
    --output-schema) echo "schema flag must not reach complete()" >&2; exit 3 ;;
    --skip-git-repo-check) SAW_SKIP_GIT=1; shift ;;
    --output-last-message) LAST_MSG="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ "$SAW_SKIP_GIT" = "1" ] || {
  echo "complete() must pass --skip-git-repo-check (codex refuses non-git temp dirs)" >&2
  exit 4
}
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
