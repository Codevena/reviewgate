## FINAL DELTA REVIEW

### Remaining from prior pass
- [C1 Claude --tools] RESOLVED — §5.4 now states `--allowedTools` is only pre-approval, adds a positive `--tools "Read,Grep,Glob"` restriction when supported, keeps deny-list + `dontAsk`, and documents the fallback layers.
- [C3 §5.1 Windows desc] RESOLVED — §5.1 and §5.4 consistently say Windows is fail-closed in v1 unless `sandbox.mode='off'` is explicit; WSL2 is the workaround and native Windows is v2.
- [W1 §5.1 phases 0-5] RESOLVED — components now reference phases 0-4, §5.3 defines phases 0-4, and the auto-fix/suggestion phase is explicitly future v2.
- [W3 Gemini parse contract] RESOLVED — §5.4 now defines Gemini findings as Markdown written to `findingsPath`; JSON output is only for usage stats and exit status.
- [W4 OpenCode parse contract] RESOLVED — §5.4 now defines OpenCode findings as Markdown written to `findingsPath`; JSON/event output is only for usage/cost extraction.
- [W5 Codex OpenRouter] PARTIAL — the auth matrix now marks Codex OpenRouter as `not in v1` and routes OpenRouter through OpenCode, but §11 still says v1 includes "OAuth + API-key + OpenRouter auth per provider", which is broader than the corrected matrix.
- [W11 §5.8 unsandboxed] RESOLVED — §5.8 now fails closed by default and permits unsandboxed runs only via explicit `sandbox.mode='off'`, with audit tagging and a `pending.md` banner.
- [W12 §9 OAuth headers] RESOLVED — §9 and §12 Q8 now treat quota telemetry as best-effort, set `quota_used_pct` to `null` when absent, and gate the 80% warning on parseable quota data.
- [I1 §3.2 decisions indexing] RESOLVED — §3.2 now uses `decisions/1.jsonl` for iteration 1 and `decisions/2.jsonl` only after iteration 2 fails.
- [NEW1 §3.2 additionalContext] RESOLVED — §3.2 step 7 no longer mentions `additionalContext`; §5.2 explicitly avoids relying on it for Stop hooks and uses `reason` plus on-disk reports.
- [NEW2 Gemini --approval-mode plan] PARTIAL — the concrete Gemini command no longer passes `--approval-mode plan` by default and gates it on doctor confirmation, but §12 Q5 still says the resolution is "bubblewrap + plan mode together", which conflicts with §5.4.

### Any new issues
- None.

## VERDICT
PASS
