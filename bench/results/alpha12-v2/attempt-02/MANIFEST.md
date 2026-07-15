# Alpha.12 Benchmark v2 — Attempt 02 (non-authoritative)

Attempt 02 ran from commit
`1ea1a3a402ac7dc2502ab96c6033c6e0396eb7df` with compiled runner SHA-256
`c041cf84d148e03350566c11f347c940bbff94e0c166aba269f242d370ce3fd2`.

The live baseline completed all 30 unique cases × 3 correlated repeats with full
reviewer coverage (`90/90` for both Codex and Claude Code) and full eligible critic
coverage (`87/87`). The paired no-critic replay then exited `4` because seven
case-runs did not reproduce the baseline reviewer-request hash. The entire attempt
is therefore explicitly **non-authoritative**; none of its precision, recall,
false-positive or ablation values may be used as an Alpha.12 headline.

Offline reproduction isolated the drift to nondeterministic caller ordering in the
symbol-graph section of otherwise identical reviewer prompts. Ripgrep may emit
cross-file matches in different orders, so multi-file cases could hash differently
between the live baseline and deterministic replay. ReviewGate correctly refused to
compare non-identical requests instead of weakening the paired-sample invariant.

The normalized baseline, failed replay result and reviewer request/response hash
manifest are retained under the no-overwrite rerun policy. No prompts, raw model
transcripts, credentials or request bodies are published.
