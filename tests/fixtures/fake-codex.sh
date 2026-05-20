#!/usr/bin/env bash
# Fake codex: read prompt+flags, write a fixed findings.md, emit minimal JSONL on stdout.
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
      "id": "F-001",
      "signature": "fakesig",
      "severity": "WARN",
      "category": "security",
      "rule_id": "fake-rule",
      "file": "x.ts",
      "line_start": 1,
      "line_end": 1,
      "message": "fake finding",
      "details": "fake",
      "reviewer": { "provider": "codex", "model": "gpt-5.4", "persona": "security" },
      "confidence": 0.5,
      "consensus": "singleton"
    }
  ]
}
JSON
fi
# Emit JSONL events on stdout for usage parsing.
printf '%s\n' '{"event":"thread.started","thread_id":"t1"}'
printf '%s\n' '{"event":"turn.completed","usage":{"input_tokens":100,"output_tokens":20,"cached_input_tokens":50}}'
exit 0
