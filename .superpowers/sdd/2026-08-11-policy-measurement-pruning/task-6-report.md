# Task 6 — Dogfood decision/trace binding

## Evidence

- RED observed for the missing shared signature export, emission field, byte verifier, and dogfood modules.
- GREEN: the six planned focused suites passed (39 tests / 80 assertions), along with `bunx tsc --noEmit`, global `bun run lint`, and `git diff --check`.
- `representative-only` was killed in disposable worktree `/tmp/reviewgate-task6-mutants.itDYBC/w` by `returns representative and cluster-member signatures code-unit sorted and unique` (3 signatures → 1).
- A locale-collation signature-sort mutant was killed by `uses code-unit ordering rather than locale collation`; the source was restored before the final green run.

## Remaining mutation evidence

Step 10 is complete. The focused Dogfood suite now uses real stored traces and hash-chained,
multi-run/multi-file audit fixtures. The runtime exclusion matrix reaches all ten closed authority
codes: `agent-only-decision`, `missing-attestation`,
`attestation-input-manifest-mismatch`, `missing-decision`, `incomplete-trace`,
`ambiguous-run-iter`, `signature-absent-lineage`, `malformed-chain`,
`changed-source-file`, and `post-registered-at`. The normal cases are 10/10 closed codes
represented; each listed bypass mutant below loses its named witness (10/10 → 9/10).

| Mutant | Named killer | Actual disposable-copy result |
|---|---|---|
| representative only | `findingSignatures > returns representative and cluster-member signatures code-unit sorted and unique` | FAIL, 3 → 1 signatures |
| locale collation | `findingSignatures > uses code-unit ordering rather than locale collation` | FAIL (`[a,z,ä]` differs) |
| accept agent-only legacy decision | `excludes agent-authored legacy labels and an attestation without a decision` | FAIL, agent-only count 1 → 0 |
| different attestation manifest | `rejects an attestation signed over a different frozen manifest` | FAIL, labels 0 → 2 |
| finding-ID join | `keeps two matching human attestations eligible by signature lineage, not finding ID` | FAIL, 2 labels → 0; IDs intentionally differ |
| skip trace-lineage verification | `counts signatures outside trace lineage and decisions at or after registered_at` | FAIL, lineage count 1 → 0 |
| count a missing decision as an FP-equivalent | `keeps two matching human attestations eligible by signature lineage, not finding ID` | FAIL, missing-decision 2 → 0 |
| consume beyond frozen inventory | `does not rescan a later audit file outside the four frozen source refs` | FAIL, consumed refs 4 → 5 (later/ref extra 0 → 1) |
| reread audit bytes | `reads each frozen audit pathname once into the verified hashing buffer` | FAIL, stable audit reads 1 → 2 |

The multi-file baseline consumes exactly four frozen audit/trace refs and zero extras. Matching
human attestations are eligible 2/2; a foreign-manifest attestation is eligible 0/2. The invalid
trace fixture intentionally records `incomplete-trace = 2`: source validation plus its attested
row that lacks a complete trace. All mutations ran separately in copies under
`/tmp/reviewgate-task6-mutants.3Hwuui/`; each copy began and ended at source SHA
`e128f6a0d9046b0e4ac5d97b8771475ac7a3b396`, while the primary worktree was unchanged by those
runs.
