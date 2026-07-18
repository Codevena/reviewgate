# Alpha.12 Benchmark v2 Attempt 05

Status: non-authoritative, fail-closed after review
Recorded: 2026-07-18T22:04:49Z

Attempt 05 initially completed the preregistered protocol in
`bench/preregistrations/alpha12-v2-attempt-05.json`, but post-run ReviewGate
review found a provenance mismatch between the baseline and replayed `-critic`
variant. The artifact set is preserved for debugging and provenance only.

Integrity:

- Baseline source commit: `f9ff7a96dcf259dbbca40fecfa9de2f35a68a4b1`
- `-critic` source commit recorded by `no-critic.result.json`: `419a1427f3f53a206a8b43072e91dbc1f3fdf30f`
- Repository dirty at run start: `false`
- Runner SHA-256: `0ee7d1c006ccadfb62c97f12a6382b1a50144adb9b708eab4e422525f1020a90`
- Preregistration SHA-256: `2d28c20d16ce1b98c45d5cd554e4194f2d8e3531c56ca33761a6cf6c83369a5e`
- ReviewGate version: `0.1.0-alpha.12`
- Provider calls used: `264/360`

Coverage:

- Codex reviewer: `90/90`
- Claude Code reviewer: `90/90`
- OpenRouter critic: `84/84` eligible calls
- Baseline verdict stamp: authoritative, `gate_exit_code=0`
- Matrix-level post-review verdict: non-authoritative because variant
  provenance differs from baseline provenance.

Failure:

- Gate: post-run ReviewGate correctness finding `corpus-commit-mismatch`.
- Reason: `matrix.json` uses baseline provenance (`f9ff7a9…`) as the matrix
  provenance, while `no-critic.result.json` records `corpus_commit` and
  `integrity.source_commit` as `419a142…`.
- Cause class: repository `HEAD` advanced between baseline and replay variant.
  The benchmark runner at this revision validated each variant independently but
  did not require variant provenance to match baseline provenance.

Do not publish precision, recall, clean false-positive, or ablation metrics from
this attempt.

Observed baseline metrics (debugging only):

- Precision: `35/101 = 0.3465`
- Recall: `35/42 = 0.8333`
- Clean false-positive rate: `32/48 = 0.6667`

Observed critic ablation (debugging only):

- `-critic` precision: `35/111 = 0.3153`
- `-critic` recall: `35/42 = 0.8333`
- `-critic` clean false-positive rate: `38/48 = 0.7917`
- Delta (`baseline - -critic`): precision `+0.0312`, recall `0.0000`, clean-FP `-0.1250`

Artifacts:

- `matrix.json` — authoritative paired matrix summary
- `baseline.result.json` — full baseline run
- `no-critic.result.json` — replayed reviewer responses with critic disabled
- `reviewer-responses.sha256.json` — captured reviewer response hashes used for paired replay
