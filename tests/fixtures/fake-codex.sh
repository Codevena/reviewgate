#!/usr/bin/env bash
# Fake codex mirroring real `codex exec --json --output-schema` behavior:
# writes the review-schema shape to --output-last-message and emits
# type-keyed JSONL events (including a turn.completed with usage) on stdout.
set -u
LAST_MSG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --output-last-message) LAST_MSG="$2"; shift 2 ;;
    *) shift ;;
  esac
done
if [ -n "$LAST_MSG" ]; then
cat > "$LAST_MSG" <<'JSON'
{
  "verdict": "FAIL",
  "findings": [
    {
      "severity": "CRITICAL",
      "category": "security",
      "rule_id": "fake-rule",
      "file": "x.ts",
      "line": 1,
      "message": "fake finding",
      "details": "fake details",
      "confidence": 0.9
    }
  ]
}
JSON
fi
printf '%s\n' '{"type":"thread.started","thread_id":"t1"}'
printf '%s\n' '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":20,"cached_input_tokens":50}}'
exit 0
