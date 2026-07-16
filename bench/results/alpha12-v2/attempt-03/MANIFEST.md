# Alpha.12 Benchmark v2 Attempt 03

Status: non-authoritative, fail-closed
Recorded: 2026-07-16T17:55:35Z

Attempt 03 was started from the preregistered protocol in
`bench/preregistrations/alpha12-v2-attempt-03.json` and failed the authoritative
gate before the paired no-critic replay.

Integrity:

- Source commit: `1fb268d8b1c87a81ac1022ebd06a1b2defe58e82`
- Repository dirty at run start: `false`
- Runner SHA-256: `b62aaa5a1bcf69d7067ed5a110142284b3ec06a1c8945198724feb3cafa3c468`
- Preregistration SHA-256: `954a10449f0b9d3e73bc97c70c108070d6a84857692b6146f701763581cf9573`
- ReviewGate version: `0.1.0-alpha.12`

Failure:

- Exit code: `4`
- Gate: `benchmark-invalid`
- Reason: critic coverage was `80/83` eligible calls; authoritative mode requires
  100% critic coverage and at least one eligible critic call.
- Missing critic verdicts:
  - `sql-injection-ts`, repeat `1`
  - `sql-injection-ts`, repeat `2`
  - `hardcoded-secret-py`, repeat `3`

Coverage observed:

- Codex reviewer: `90/90`
- Claude Code reviewer: `90/90`
- OpenRouter critic: `80/83`
- Provider calls used: `266/360`

Do not publish precision, recall, clean false-positive, or ablation metrics from
this attempt. The result file contains partial baseline data only for debugging
and provenance.
