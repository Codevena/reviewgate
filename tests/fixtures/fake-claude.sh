#!/usr/bin/env bash
# Fake claude -p --output-format json: emits the result envelope with the
# review-shape JSON inside `result`, plus a usage block.
set -u
cat <<'JSON'
{
  "type": "result",
  "subtype": "success",
  "result": "{\"verdict\":\"FAIL\",\"findings\":[{\"severity\":\"CRITICAL\",\"category\":\"correctness\",\"rule_id\":\"cl-rule\",\"file\":\"x.ts\",\"line\":1,\"message\":\"claude finding\",\"details\":\"d\",\"confidence\":0.92}]}",
  "total_cost_usd": 0,
  "usage": { "input_tokens": 300, "output_tokens": 40 },
  "session_id": "fake"
}
JSON
exit 0
