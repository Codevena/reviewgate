# Alpha.12 Benchmark v2 Attempt 04

Status: non-authoritative, fail-closed
Recorded: 2026-07-18T20:39:15Z

Attempt 04 was started from the preregistered protocol in
`bench/preregistrations/alpha12-v2-attempt-04.json` and did not produce a
publishable paired matrix result. The baseline artifact is preserved for
debugging and provenance only.

Integrity:

- Source commit: `556e0fe0f4ca3941383f0a43358c22c1d82edbae`
- Repository dirty at run start: `false`
- Runner SHA-256: `e73ae3b345dd5139e2926df246591796c89dea992c240ae9996edf75a0426f26`
- Preregistration SHA-256: `c87b8313e07684519277e6aed1e178da92789afce9a889961c61a268a4bc8685`
- ReviewGate version: `0.1.0-alpha.12`

Failure:

- Gate: `benchmark-invalid`
- Reason: the baseline run had incomplete reviewer coverage. Claude Code reached
  `90/90`, and the OpenRouter critic reached `85/85` eligible calls, but Codex
  reached `0/90` authoritative coverage.
- Provider calls used: `266/360`

Observed coverage:

- Codex reviewer: `0/90`
- Claude Code reviewer: `90/90`
- OpenRouter critic: `85/85`

Do not publish precision, recall, clean false-positive, or ablation metrics from
this attempt. The result file contains partial baseline data only for debugging
and provenance.
