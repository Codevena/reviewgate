#!/usr/bin/env bash
# Fake gemini: emits the real outer JSON envelope with a `response` string
# containing the review-shape JSON, and a stats.models.tokens block.
set -u
cat <<'JSON'
{
  "session_id": "fake",
  "response": "{\"verdict\":\"FAIL\",\"findings\":[{\"severity\":\"WARN\",\"category\":\"security\",\"rule_id\":\"gem-rule\",\"file\":\"x.ts\",\"line\":1,\"message\":\"gemini finding\",\"details\":\"d\",\"confidence\":0.8}]}",
  "stats": { "models": { "gemini-3-pro": { "tokens": { "prompt": 200, "candidates": 30, "total": 230, "cached": 0 } } } }
}
JSON
exit 0
