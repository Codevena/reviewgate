## FINDINGS

- [CRITICAL] §5.5/§5.6/§8: `contradicts_memory` is referenced as a field reviewers emit on their `Finding` objects (§5.6 "reviewers may contradict via a `contradicts_memory` field on their findings"; §8 threat-table entry) but the `Finding` interface in §5.5 has no such field. Any code that reads `finding.contradicts_memory` will fail at runtime; the Brain's contradiction-rebuttal channel is a no-op as specified.

- [CRITICAL] §5.6/schema: `MemoryProposal.evidence` item schema has no `from_diff` field, yet §5.6 rule 6 references "any evidence with `kind:'reviewer-observation'` and `from_diff` pointing at attacker-controlled diff content". The doubled-quorum protection against Brain poisoning via crafted diffs depends on this field being present in proposals — it cannot be evaluated without it. A malicious diff-derived proposal passes rule 6 silently if `from_diff` is absent.

- [CRITICAL] §5.2/§5.5: `SOFT-PASS` is defined as a legitimate verdict in the aggregator (§5.5 severity-weighted veto section: "only WARN singleton/minority + no CRIT → SOFT-PASS") and appears in `PendingReport.verdict` type union. The FSM pseudocode in §5.2 only handles `PASS`, `FAIL`, and `ESCALATE`. There is no FSM transition for `SOFT-PASS`. Depending on implementation, the FSM falls through to `FAIL` (over-blocking) or `PASS` (under-blocking); the spec is silent on intent.

- [CRITICAL] §5.4 (anti-sycophancy rule 1): The host-model tier check requires knowing whether the host Claude process is Opus, Sonnet, or Haiku to select the reviewer tier. The spec says detection is via `env CLAUDE_PROJECT_DIR + process tree`, but neither of these surfaces exposes the current model identifier. There is no documented env variable for the active model in Claude Code hooks. Without knowing the host tier, the downgrade ("Opus host → Sonnet reviewer") cannot be enforced. The rule is stated as hard-enforced but the detection mechanism is unspecified and likely non-implementable without a model-override flag the user must set.

- [WARN] §5.2: The FSM condition "no dirty.flag since last PASS" implies the flag is cleared after a PASS, but the spec never states who removes `dirty.flag`, when, or under what conditions (e.g., does SessionStart reset clear it? Does gate clear it on PASS? Is it timestamp-compared?). If the flag is never cleared, every subsequent Stop fires a full review even on doc-only changes. If it is cleared on the first PASS and not re-written on the next PostToolUse, the whole guard is broken.

- [WARN] §5.2: The block JSON includes `"continue": true`. The Claude Code Stop hook documented response fields are `decision` and `reason`. The `continue` field is not documented. It will likely be silently ignored. If it is the mechanism intended to prevent Claude Code from showing a turn-end banner while the review runs, losing it changes behavior silently. Needs spike (should be in §12 open questions).

- [WARN] §5.4 (anti-sycophancy): The triage provider is configured as `claude-code` at `claude-sonnet-4-6` by default in both the config example (§5.4) and the full config reference (§6). Anti-sycophancy rule 1 covers only "reviewer" roles, not the triage call. A triage LLM using the same model as the host effectively prejudges risk classification with the host's perspective before diverse reviewers are even selected. If the host is Sonnet-4-6 and triage is Sonnet-4-6, the triage call inherits any blind spots of the model under review. The spec does not acknowledge or mitigate this.

- [WARN] §14 (references): arxiv 2509.16533 is listed twice with two different paper titles: "Sycophancy in self-review under iterative pressure" and "Multi-Agent Debate for LLM Judges (NeurIPS 2025)". One of these is wrong. If they are two different papers, one citation is incorrect. If the NeurIPS 2025 claim in §2.2 ("NeurIPS 2025 work shows majority vote fails") rests on the wrong arxiv ID, the academic anchor for the severity-weighted veto design rationale is unfounded.

- [WARN] §5.7 / §5.2: `state.json` is described as the loop FSM state store but has no schema defined anywhere in the spec. The FSM depends on at least: current iteration counter, last-PASS timestamp, last-verdict, run_id, cost-so-far. If multiple components write different assumptions about its structure (StateStore, Orchestrator, AuditLogger), a corrupt or version-mismatched `state.json` produces the only error-recovery path defined: "reinit" — which silently resets the iteration counter and cost cap, allowing a stuck-loop to restart.

- [WARN] §5.8 (error table) / §6 (sandbox config): `sandbox.deniedReads` in the config schema (§6) includes `~/.config` as a blanket deny. The sandbox profile in §5.4 also denies `/Users` broadly and re-allows only `{credentialPath for active provider}`, which for Gemini is `~/.config/gemini/`. The `~/.config` blanket deny in the config schema would deny the Gemini credential path before the re-allow can fire, because (per the actual `@anthropic-ai/sandbox-runtime` docs confirmed) `allowRead` takes precedence over `denyRead`. However the config field `deniedReads` is a user-facing override and if a user copies the default and applies it, it can create a misleading impression that Gemini auth will break. More critically, the config-level `deniedReads` and the runtime sandbox profile (§5.4) are two separate mechanisms and their interaction is never specified.

- [WARN] §5.9 (Ubuntu 24.04+): The spec says "Reviewgate fails closed if bubblewrap is missing on Linux". Ubuntu 24.04+ enables `kernel.apparmor_restrict_unprivileged_userns` by default, which causes bubblewrap to be installed but non-functional without an AppArmor profile or sysctl override. The `which bubblewrap` check the spec implies will return success while every sandbox attempt silently fails. The spec needs a bubblewrap functional-verification step (not just presence check) in `reviewgate doctor`.

- [WARN] §5.5 / signing: Finding signatures use SHA-1. The spec positions Reviewgate as a security tool whose FP-Ledger and Brain poisoning defenses depend on signature stability and uniqueness. SHA-1 has known collision attacks. A malicious diff can be crafted to produce a finding with a signature that collides with an existing FP-Ledger `active` entry, causing a genuine security finding to be filtered. The cost of a SHA-1 chosen-prefix collision is within reach of a state actor. Use SHA-256 throughout.

- [WARN] §5.2 / escalation: `ESCALATION.md` is written by the FSM on escalation but it does not appear in the storage layout (§5.7) and has no schema. Its path is undeclared. The FSM says "allow_stop after writing ESCALATION.md" but it is not in the `.reviewgate/` tree layout, not gitignored, and not defined. A reviewer reading `pending.md` on an escalated run needs to find this file; Claude cannot be instructed to read it if its path is not in the block-JSON reason.

- [INFO] §11 (W5 partial from Codex r3): §11 v1 scope list says "OAuth + API-key auth per provider; OpenRouter only where verified". This is now consistent with the auth matrix and §12 Q6. The partial flag from Codex r3 is resolved in the current text.

- [INFO] §12 (NEW2 partial from Codex r3): §12 Q5 resolution text no longer says "bubblewrap + plan mode together"; it says sandbox is the primary layer and plan mode is only added when doctor confirms it. The partial flag from Codex r3 is resolved.

- [INFO] §5.4: `codex exec --sandbox read-only` — the Codex CLI flag `--sandbox read-only` is specified here as a restriction mechanism in addition to the sandbox-runtime wrapping. The interaction between the Codex CLI's own sandboxing and `@anthropic-ai/sandbox-runtime`'s Seatbelt/bubblewrap wrapper is never described. If Codex's internal sandbox and the outer srt sandbox conflict (e.g., Codex's sandbox blocks bubblewrap from binding network proxy ports), the two layers may interfere. Needs spike.

- [INFO] §5.4 (Gemini): `gemini --include-directories "{workingDir}"` — the Gemini CLI headless reference is listed in §14 but this specific flag's behavior under bubblewrap (where the working dir is a bind-mount) is unverified. The Gemini CLI may resolve the directory path before bubblewrap remaps it.

- [INFO] §5.4: `--append-system-prompt-file` is used for Claude reviewer persona injection. The Claude CLI docs use `--append-system-prompt` (inline string), not `--append-system-prompt-file` (file path). The file-variant flag is called out in the spec as the chosen approach but is also listed as a spike in §12 Q3 context. The flag name itself is unverified against the installed CLI.

- [INFO] §9 / cost model: `opencode stats --json --days 1` is used as the cost extraction mechanism (diff of snapshots before/after). This command is not in the OpenCode CLI reference linked in §14 (`opencode.ai/docs/cli/`). If the command does not exist or changed, cost extraction silently returns 0 for every OpenCode run, breaking the cost cap for OpenRouter mode.

## NEW ISSUES NOT IN PRIOR CODEX REVIEWS

- [CRITICAL] Schema: `Finding.contradicts_memory` field is referenced in two places but absent from the `Finding` interface — the Brain's contradiction-rebuttal channel cannot function as designed.
- [CRITICAL] Schema: `MemoryProposal.evidence[].from_diff` is referenced in the Brain poisoning defense (§5.6 rule 6) but absent from the `MemoryProposal.evidence` item schema — the doubled-quorum rule for diff-derived proposals is unenforceable.
- [CRITICAL] FSM: `SOFT-PASS` verdict has no FSM transition defined in §5.2, making its behavior (block or allow) undefined at implementation time.
- [CRITICAL] Anti-sycophancy: Host-model tier detection mechanism is unspecified and likely non-implementable via env/process-tree inspection alone.
- [WARN] FSM: `dirty.flag` clearing semantics are never specified (who clears it, when, and on what condition).
- [WARN] Hook: `"continue": true` in Stop-hook block JSON is an undocumented field; needs spike entry in §12.
- [WARN] Anti-sycophancy gap: Triage provider shares model tier with host, bypassing the cross-tier rule that only covers "reviewer" roles.
- [WARN] References: arxiv 2509.16533 appears twice under two different paper titles; one citation is wrong.
- [WARN] Linux: Ubuntu 24.04+ `apparmor_restrict_unprivileged_userns` silently breaks bubblewrap despite a clean `which bubblewrap` result; `doctor` must functionally verify bubblewrap, not just check for its presence.
- [WARN] Security: SHA-1 used for finding signatures enables chosen-prefix collision attacks to poison the FP-Ledger; use SHA-256.
- [WARN] Storage: `ESCALATION.md` written on escalation has no declared path, schema, or gitignore entry.
- [WARN] State: `state.json` has no schema defined; FSM state fields are undeclared.

## VERDICT
FAIL
