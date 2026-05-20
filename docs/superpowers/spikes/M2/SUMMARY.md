# M2 Spikes — Summary

**Date:** 2026-05-20

| Spike | Question | Status | Outcome |
|---|---|---|---|
| SM2-1 | Gemini headless review output shape? | ✅ PASS | `GEMINI_CLI_TRUST_WORKSPACE=true gemini -p "<prompt>" -m <model> -o json --approval-mode plan </dev/null` → outer `{ session_id, response:"<string>", stats:{models:{<m>:{tokens:{prompt,candidates,total,cached}}}} }`. The `response` STRING holds the model's answer; when JSON is requested it is the review-shape (sometimes ```json-fenced). `GEMINI_CLI_TRUST_WORKSPACE=true` is REQUIRED (else exit 55 "not a trusted directory"). Usage: input=`tokens.prompt`, output=`tokens.candidates`. Real run produced a correct CRITICAL timing finding. |
| SM2-2 | Claude-as-reviewer: OAuth non-bare, JSON shape, safety? | ✅ PASS | `claude -p "<prompt>" --model claude-sonnet-4-6 --output-format json --disallowedTools "Bash,Edit,Write,MultiEdit,NotebookEdit,WebFetch,WebSearch,TodoWrite,Task" --permission-mode dontAsk --no-session-persistence </dev/null` → **OAuth used** (no ANTHROPIC_API_KEY set, exit 0). Envelope keys include `type,subtype,is_error,result,usage,total_cost_usd,session_id,...`. **`result` is a STRING wrapped in ```json fences** holding the review-shape JSON → the tolerant `parseReviewOutput` (fence-strip) handles it. `usage.{input_tokens,output_tokens}` present (input may be low due to prompt caching). Real run produced a correct CRITICAL timing side-channel finding (rule_id SEC-TIMING-001). **Recursion safety:** run the reviewer in a hook-free temp CWD (no project `.claude/settings.json`) so its Stop hook cannot re-invoke Reviewgate — confirmed design; verify global-hook behavior in practice. |
| SM2-3 | OpenRouter any-model via response_format? | ◑ DESIGN-VERIFIED (real call pending user key) | OpenRouter is OpenAI-compatible: POST `https://openrouter.ai/api/v1/chat/completions` with `Authorization: Bearer $OPENROUTER_API_KEY`, `response_format:{type:"json_schema",json_schema:{name,strict,schema}}`, returns `{choices:[{message:{content:"<json string>"}}], usage:{prompt_tokens,completion_tokens}}`. Model name passed verbatim (e.g. `google/gemini-3.5-flash`). Built with mocked-`fetch` unit tests; real e2e to be run by the user with their `OPENROUTER_API_KEY`. Tolerant parser recovers content if a model ignores `response_format`. |

## Key implications for the adapters
- **One shared parse path** (`parseReviewOutput`): clean JSON, ```json fences, or JSON-in-prose all recover. Codex (strict schema), Gemini (`response` string), Claude (`result` string, fenced), OpenRouter (`choices[0].message.content`) all funnel through it.
- **Anti-sycophancy:** the Claude reviewer model is chosen by the Orchestrator from `host-model.ts` (Opus host → Sonnet reviewer), never the host tier.
- **Claude `--bare` is NOT used** (it reads only ANTHROPIC_API_KEY, never OAuth). Safety comes from temp-CWD + tool-deny + `dontAsk` instead.

## Legend
- ✅ PASS — verified with the real CLI/API
- ◑ DESIGN-VERIFIED — contract known + mock-tested; real call deferred to the user
