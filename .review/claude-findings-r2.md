## DELTA REVIEW

### Prior CRITICAL

- [CC1: Finding.contradicts_memory] RESOLVED — §5.5 now includes `contradicts_memory?: { brain_entry_id: string; reason: string }` as an optional field on `Finding`; the rebuttal channel has a concrete schema and can be implemented.

- [CC2: MemoryProposal.evidence.from_diff] RESOLVED — §5.5 `MemoryProposal.evidence[]` now includes `from_diff?: { file; line_start; line_end }` and §5.6 rule 6 correctly references it; the doubled-quorum guard is now enforceable.

- [CC3: SOFT-PASS FSM transition] RESOLVED — §5.2 FSM pseudocode now has an explicit `SOFT-PASS` branch with three configurable policy paths (`allow` / `block` / `ask-once`) and the `dirty.flag` lifecycle table includes a SOFT-PASS row identical to PASS.

- [CC4: Host-model tier detection] RESOLVED — §5.4 anti-sycophancy rule 1 now specifies a four-source priority chain: (a) `REVIEWGATE_HOST_MODEL` env, (b) `CLAUDE_MODEL` env, (c) hook stdin `session.model` field, (d) fail-safe assume-Opus fallback. Fallback (d) is provably safe by construction (Sonnet < Opus; cannot produce same-tier reviewer). Q9 spike added to §12 to verify field name.

### Prior WARN

- [WW1: dirty.flag clearing] RESOLVED — §5.2 now has an exhaustive `dirty.flag` lifecycle table covering every state transition (PostToolUse write, Stop-PASS delete via atomic rename, Stop-SOFT-PASS delete, Stop-FAIL keep, Stop-ESCALATE delete, SessionStart delete, cache-hit delete). Who clears it and when is no longer ambiguous.

- [WW2: "continue": true] RESOLVED — §5.2 block-JSON section explicitly removes `continue`/`suppressOutput`, explains they are undocumented Stop-hook fields, and relies only on `decision` + `reason`. The change is intentional and documented, not silently dropped.

- [WW3: triage cross-tier] RESOLVED — §5.4 anti-sycophancy rule 5 now explicitly extends the downgrade table to the triage call. Sonnet host → Haiku triage; Opus host → Sonnet triage. Config comment in §6 triage section should now reflect this dynamically (static config shows Sonnet-4-6 but the rule overrides it at runtime — this is acceptable given the preflight mechanism).

- [WW4: arxiv duplicate] RESOLVED — §14 now shows two distinct citations: arxiv 2509.16533 for sycophancy and openreview Vusd1Hw2D9 for Multi-Agent Debate (NeurIPS 2025). The duplicate arxiv ID is gone; academic anchors are no longer conflated.

- [WW5: bubblewrap functional check] RESOLVED — §5.4 sandbox section now explicitly states that `reviewgate doctor` runs `bwrap --ro-bind / / --unshare-user --uid 0 -- true` as a functional test and refuses to mark sandbox ready unless it passes. Ubuntu 24.04+ AppArmor remediation hints are documented.

- [WW6: SHA-1 collision] RESOLVED — §5.5 signature definition now uses `sha256(...)` throughout; SHA-1 is gone from the spec.

- [WW7: ESCALATION.md schema] RESOLVED — §5.2 now specifies the path (`.reviewgate/ESCALATION.md`), a concrete Markdown schema with section headings, gitignore entry (added to the §5.7 gitignore block), and notes that the reason is also embedded in the Stop-hook `reason` field so Claude can surface it without reading the file.

- [WW8: state.json schema] RESOLVED — §5.2 now provides a fully typed `ReviewgateState` interface (zod-validated) covering all fields the FSM depends on: `schema`, `session_id`, `iteration`, `cost_usd_so_far`, `tokens_so_far`, `signature_history`, `decision_history`, `last_diff_hash`, `last_stop_ts`, `last_pass_diff_hash`, `started_at`, `escalated`, `escalation_reason`, `recovered_from`.

### Any new issues introduced

- [WARN] §5.4 / §6 triage config static value: Anti-sycophancy rule 5 specifies a runtime downgrade for triage (Sonnet host → Haiku triage), but the static config in §6 still shows `triage: { provider: 'claude-code', model: 'claude-sonnet-4-6' }` with no note that this value is overridden at preflight. A developer implementing the ConfigLoader from the §6 schema alone will hardcode the Sonnet triage call and miss the runtime downgrade. The spec needs a comment in the §6 config block or an explicit note that `phases.triage.model` is overridden by the anti-sycophancy preflight when host-model detection yields a same-or-higher tier.

- [INFO] §5.2 `ask-once` SOFT-PASS policy: The policy semantics say "block once; if Claude rejects all remaining WARN with `reviewer_was_wrong:true`, the next iter SOFT-PASS allow_stops." This creates an observable interaction with the FP-Ledger promotion path (3 rejects across ≥ 2 reviewers → `active`). A single `ask-once` cycle where Claude rejects all WARNs in one iteration counts as one batch of rejections — if the same WARNs appear across ≥ 2 reviewers in one SOFT-PASS, that single run contributes toward `candidate` status in the FP-Ledger. This is the desired behaviour, but the spec does not confirm it is intentional. Low risk; clarification only.

- [INFO] §5.5 `PendingReport.verdict`: The type union `'PASS' | 'SOFT-PASS' | 'FAIL'` does not include `'ESCALATE'`. The FSM has an ESCALATE verdict path that writes `ESCALATION.md`, but if `pending.json` is always written with `verdict: 'PASS' | 'SOFT-PASS' | 'FAIL'`, machine consumers reading `pending.json` on an escalated run will see a stale or absent `verdict` field. Either add `'ESCALATE'` to the union or explicitly state that `pending.json` is not written (or is superseded by `ESCALATION.md`) on escalation.

## VERDICT

PASS

All 4 prior CRITICAL and all 8 prior WARN findings are RESOLVED. The two new WARN-level observations are both narrow spec-clarity gaps in new text, not holes in core mechanisms. The one that could bite an implementor (triage model override not annotated in §6 config) is logged as WARN; it does not invalidate the design. No new CRITICAL issues found.
