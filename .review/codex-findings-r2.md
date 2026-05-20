## DELTA REVIEW

### Prior CRITICAL
- [C1: --allowedTools vs --disallowedTools] PARTIAL — §5.4 no longer uses `--allowedTools`, but still omits Claude Code's documented `--tools` restriction flag and relies on a deny list despite saying the reviewer needs only Read/Grep/Glob.
- [C2: OAuth credential paths vs sandbox deny] RESOLVED — §5.4 now explicitly denies broad roots and re-allows only the active provider's credential paths.
- [C3: Windows sandbox-runtime claim] PARTIAL — §5.4 correctly says Windows is unsupported/fail-closed, but §5.1 still describes SandboxManager as Seatbelt/bubblewrap/JobObject.
- [C4: Egress content channel] ACCEPTED-AS-IS — §8.1 acknowledges the allowed-API-request content channel as a v1 known limitation and gives reasonable partial mitigations.

### Prior WARN
- [W1: Phase numbering] PARTIAL — §5.3 is cleaner, but §5.1 still says phases 0-5 while §5.3 defines 0-4 and §11 reserves auto-fix as Phase 4 in v2.
- [W2: sandbox-runtime deny/allow read model] RESOLVED — §5.4 now states the deny-then-allow model and denies `/Users`, `/home`, `/Volumes`, and `/tmp` before narrow re-allows.
- [W3: Gemini/OpenCode schema enforcement] PARTIAL — §12 Q7 acknowledges weaker guarantees, but §5.4 commands still show CLI JSON output with no concrete Markdown findings-file path or parse contract.
- [W4: OpenCode raw JSON events] PARTIAL — §12 Q7 acknowledges raw/weak structured output, but §5.4 still presents `opencode --format json` as the spawn path without specifying event extraction.
- [W5: Codex OpenRouter support] UNRESOLVED — §5.4 auth matrix still claims Codex OpenRouter via `--provider openrouter`, while §12 Q6 says it is unverified/out of scope and current OpenAI CLI docs do not list that flag.
- [W6: Finding signature contradiction] RESOLVED — §5.5 now has one canonical symbol-relative signature definition.
- [W7: missing ReviewResult/pending/decisions schemas] RESOLVED — §5.5 adds versioned `PendingReport`, `DecisionEntry`, and `ReviewResult` schemas.
- [W8: Brain vs FP-Ledger lifecycle] RESOLVED — §5.7 defines one FP-Ledger lifecycle and an explicit Brain ↔ FP-Ledger interaction table.
- [W9: Brain poisoning provenance] RESOLVED — §5.6 now requires deterministic fetched evidence or cross-provider source quorum, with extra requirements for diff-derived proposals.
- [W10: local-only audit chain] ACCEPTED-AS-IS — §8.2 now states the local chain is not tamper-proof against a privileged local attacker and adds optional external anchoring.
- [W11: sandbox unavailable fallback] PARTIAL — §5.4 says strict mode fails closed when sandbox deps are missing, but §5.8 still says "Sandbox unavailable → spawn unsandboxed."
- [W12: quota_used_pct headers] PARTIAL — §5.5/§12 Q8 make quota usage best-effort, but §9 still says OAuth tracking comes from provider response headers and warns at 80%.
- [W13: stale review cache key] RESOLVED — §5.3 cache keys now include config, brain, FP ledger, provider versions, Reviewgate version, and schema version.
- [W14: tree-sitter 1-hop graph] RESOLVED — §5.3 now limits symbol graph support by language and admits tree-sitter is not whole-project reference resolution.
- [W15: prompt-injection sanitizer stripping] RESOLVED — §8.3 clarifies marker neutralisation/redaction instead of deleting or altering reviewed code content.
- [W16: v1 scope too large] ACCEPTED-AS-IS — §12 R9 acknowledges broad v1 scope and makes the staged M1-M6 delivery plan explicit enough for a design spec.

### Prior INFO
- [I1: decisions indexing] PARTIAL — §3.2 now explains current-iteration indexing, but step 8 still says iter 1 writes `decisions/2.jsonl` before the clarification says `decisions/1.jsonl`.
- [I2: Stop hook additionalContext cap] RESOLVED — §5.2 removes reliance on Stop-hook `additionalContext` and uses a 4 KB `reason` limit instead.
- [I3: supply-chain-check/dep-audit definitions] RESOLVED — §5.3 defines lockfile SCA via `osv-scanner` or `pnpm audit --audit-level=high`.
- [I4: prompt file flags] RESOLVED — §5.4 uses prompt files and Claude's `--append-system-prompt-file`.
- [I5: writablePaths vs findingsPath] RESOLVED — §5.4/§6 distinguish host writable paths from per-reviewer single-file write allowlists.

### New issues introduced by revision
- [WARN] §3.2 step 7 still says Stop emits `additionalContext`, contradicting §5.2 and §12 Q2 where Stop-hook `additionalContext` is explicitly not relied on.
- [WARN] §5.4/§12 Q5 use Gemini `--approval-mode plan`, but current Gemini CLI docs list `default`, `auto_edit`, and `yolo` approval modes, not `plan`.

## VERDICT
FAIL
