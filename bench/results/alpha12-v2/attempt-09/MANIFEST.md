# Alpha.12 Benchmark v2 — Attempt 09

Status: authoritative.

Attempt 09 ran the preregistered retry protocol from `bench/preregistrations/alpha12-v2-attempt-09.json` on clean `master` at `50f01fcf088c2419ebac1a9a3e283debc5840a35`.

Hard-gate outcome:

- Matrix authoritative: `true`
- Baseline verdict: authoritative, exit code `0`
- `-critic` replay verdict: authoritative, exit code `0`
- Repository dirty at run time: `false`
- Provider calls used by baseline: 270/450
- Runner SHA-256: `2161978c72783fa908da2d0cdb176c161bc191d0b24aea24b00db734d089a813`
- Preregistration SHA-256: `22c9910a67fe52718299876354728d335b17e97639a2a6099e7e12ac00c7a06f`

Coverage:

- `codex`: 90/90, authoritative
- `claude-code`: 90/90, authoritative
- `openrouter` critic (`deepseek/deepseek-v4-flash` via `alibaba`): 86/86 eligible, authoritative

Headline matrix values:

| variant | precision | recall | clean-FP | Δ precision | Δ recall | Δ clean-FP |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 0.3505 | 0.8095 | 0.7292 | — | — | — |
| `-critic` | 0.3091 | 0.8095 | 0.8958 | +0.0414 | 0.0000 | -0.1667 |

Interpretation: under this benchmark protocol, the critic improved aggregate precision by about 4.1 percentage points and reduced clean-case false positives by about 16.7 percentage points, without changing recall. Absolute clean-FP remains high and should be presented honestly as an alpha benchmark result.

