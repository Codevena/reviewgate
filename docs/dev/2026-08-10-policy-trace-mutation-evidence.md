# Policy trace contract mutation evidence

Date: 2026-08-11
Source commit: `ade84226130fe5f21184c5aa443d6a395d0f9252`

The mutations below were performed one at a time in a disposable no-hardlink clone. The three
Task-10 test files were copied into that clone, and its baseline was validated before mutation:
`147 pass, 0 fail` across the Task-10 matrix/offline replay plus the relevant aggregation, Bench,
Rig, artifact-store, and persistence regressions. The combined SHA-256 ledger for the seven
production files touched by the mutations was
`b124c4395f08755b417843ef3cb5be5bd25523f056e324a7429e81cc1e089669`.

## Killed mutations

| # | Deliberate mutation | Named failing command | Exact red evidence | Restored production SHA-256 |
|---:|---|---|---|---|
| 1 | Removed `evidence.fact-location` from the closed catalog inventory. | `bun test tests/unit/policy-pass-contract-matrix.test.ts -t "contains one literal contract"` | `0 pass, 1 fail`; literal fixture inventory had the missing catalog row. | `catalog.ts`: `8343fe3bbf1aae538c25ba70e2a3aea65968f02d9766af422acbef9b83cade6c` |
| 2 | Returned the production mutation without appending its `PolicyEffect`. | `bun test tests/unit/policy-pass-contract-matrix.test.ts -t "evidence.self-refutation"` | `1 pass, 1 fail`; active effect length was `0`, expected `1`. | `trace.ts`: `9f5c972a8f5eebe082c352a13c77b9b1c45cb3cd5bbb4772d5256bcd3e09c2a5` |
| 3 | Omitted every non-no-opportunity `opportunities` increment. | `bun test tests/unit/policy-pass-contract-matrix.test.ts -t "evidence.self-refutation"` | `0 pass, 2 fail`; no-match opportunity was `0`, expected `1`, and telemetry could not retain the material effect. | `trace.ts`: `9f5c972a8f5eebe082c352a13c77b9b1c45cb3cd5bbb4772d5256bcd3e09c2a5` |
| 4 | Reversed policy-effect order in `mergePolicyEffects`. | `bun test tests/unit/policy-pass-contract-matrix.test.ts -t "accepts both explanatory stages"` | `0 pass, 1 fail`; the explanatory-stage trace could not finalize with reversed material effects. | `trace.ts`: `9f5c972a8f5eebe082c352a13c77b9b1c45cb3cd5bbb4772d5256bcd3e09c2a5` |
| 5 | Returned the proposed severity mutation even when the pass was ablated. | `bun test tests/unit/policy-pass-contract-matrix.test.ts -t "evidence.fact-location"` | `1 pass, 1 fail`; ablated blocking count was `0`, expected `1`. | `trace.ts`: `9f5c972a8f5eebe082c352a13c77b9b1c45cb3cd5bbb4772d5256bcd3e09c2a5` |
| 6 | Dropped a merged cluster member's effects. | `bun test tests/unit/policy-aggregator-first-half.test.ts -t "propagates a demoted member effect"` | `0 pass, 1 fail`; final `policy_effects` was absent instead of carrying the member's order-60 demotion. | `aggregator.ts`: `b960229f9eae79fbbace76643eace513c873aab7daba2f40f7914b437c95b4d4` |
| 7 | Skipped the authoritative envelope-to-cassette response-call comparison, including ordered raw-response identity. | `bun test tests/unit/rig-replay.test.ts -t "rejects the authoritative invalidity matrix"` | `0 pass, 1 fail`; the `response hash` corruption unexpectedly passed instead of raising `RigAuthorityError`. | `policy-replay-state.ts`: `f8c59f6a7a8f36ef7037fcbabab866b054795d7af36074d9a3bc3451d3cc0239` |
| 8 | Accepted a caller-supplied artifact hash that did not match the stored bytes. | `bun test tests/unit/policy-trace-store.test.ts -t "rejects missing, absolute, traversing, wrong-hash, tampered, and symlink-escaping refs"` | `0 pass, 1 fail`; verification returned `true` for the tampered hash, expected `false`. | `policy-trace-store.ts`: `66d1c28ac972879152d144d1e8d02cebb311871e02167653d89398c7c00194f6` |
| 9 | Coerced a missing trace counter to zero before validation. | `bun test tests/unit/bench-matrix.test.ts -t "rejects every non-authoritative trace-pair boundary"` | `0 pass, 1 fail`; the `missing counters` case returned `ok: true`, expected `false`. | `runner.ts`: `6df3356e443d263323ab2d70c4921d614dcb149fe3fe73e86387469b037b1fec` |
| 10 | Removed report findings when policy-trace persistence returned `error`. | `bun test tests/unit/report-writer.test.ts -t "keeps the production verdict/findings when trace persistence fails"` | `0 pass, 1 fail`; persisted findings length was `0`, expected `1`. | `orchestrator.ts`: `a8876c064c4d467cab2ee8aa6b3edcad7184ebb1eff61bf9958e84e64cd9ae59` |

## Restore and cleanup proof

After every red run, only that mutation's production file was restored from the disposable clone's
immutable `HEAD`; its SHA-256 was checked against the value above and `git diff --exit-code -- <file>`
returned zero. After mutation 10, `git diff --exit-code -- src` was clean and the combined production
ledger was again exactly
`b124c4395f08755b417843ef3cb5be5bd25523f056e324a7429e81cc1e089669`.

The final disposable baseline rerun was `147 pass, 0 fail, 1294 expect() calls` across seven files.
The disposable tree was moved intact, rather than deleted, to the recoverable location
`~/.Trash/reviewgate-task10-mutations-rPRQzq`.
