# Alpha.11 demo provenance

This directory contains a deterministic replay of a real
`reviewgate@0.1.0-alpha.11` run. The production init, control-plane, trigger,
Stop-hook, decision, re-review and audit-verification paths execute live. Only
the two OpenRouter provider responses are replayed.

Public disclosure shown by the script:

> Recorded provider response replay — the gate path and verdict handling are
> live. Notice: provider response outputs were recorded for deterministic replay
> and provenance verification.

## Recorded run

- Recorded: 2026-07-13 in a disposable, freshly initialized git repository.
- Package: `reviewgate@0.1.0-alpha.11`.
- npm integrity: `sha512-Q7s8lQTCBXVU6qxxrAPO2xJJVLFcVs1NkrR4yCd1Fb8uOYfVL8pfNocu6PxLFZlz9Q4yVplM6ZsGSLvN7aFpsw==`.
- Model: `deepseek/deepseek-v4-flash` through OpenRouter, upstream pinned to
  `alibaba`.
- Policy state: `APPROVED`, effective fingerprint `4a09783594d9`.
- Baseline commit: `9573b44f49a5b54134d37d6995dc92bc8e79bafc`.
- Result: iteration 1 `FAIL` with one merged CRITICAL SQL-injection finding;
  iteration 2 `PASS` after an explicit accepted/fixed decision and a
  parameterized query.
- Audit verification: the final run's two JSONL chains verified with all event
  hashes matching (1 event in the first chain, 3 in the second).
- Cassette: `alpha11-openrouter.jsonl`, SHA-256
  `929845145547d20e8994cefff3e822847813601a202a8ce7426a2a55a199d860`.

The cassette contains raw provider output but no API key. It was reviewed before
commit. `demo.sh` verifies its checksum and aborts before displaying a verdict if
Alpha.11 emits its exact prompt-drift marker (`cassette: prompt drift for`) or if
a recorded response is missing.

The provider model probe used by the interactive wizard is not the same request
shape as a real review. On 2026-07-13, the wizard's suggested `deepseek` upstream
accepted the probe but rejected the review's strict `response_format`. The
recorded evidence therefore pins the schema-capable `alibaba` upstream. This is a
provider-routing compatibility observation, not a claim that an upstream will
remain compatible forever. The portable replay uses a small Java fixture because
Alpha.11's bundled symbol graph supports TypeScript/JavaScript/Python and writes
absolute caller paths into that research block; an unsupported-language fixture
keeps the strict prompt hash independent of the disposable checkout path.
