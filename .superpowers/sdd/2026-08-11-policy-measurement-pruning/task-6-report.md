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

## Fix R1 — artifact authority and multi-run audit inventory

Five named RED regressions were added against `8ff0cd6` before the production fix:

1. one production audit chain contributes two complete `(run_id, iter)` records without
   duplicating the audit ref;
2. a trace inventory binding whose raw audit trace ref or SHA differs is rejected by the closed
   manifest contract;
3. absent/malformed preregistered manifest or attestation artifacts yield no labels and zero
   frozen-source reads;
4. a single `MAX+1` `readSync` buffer observes two source reads (audit + trace) and rejects a
   same-inode audit grow; and
5. offset-equivalent timestamps are inclusive at `since`, while the exact `until` instant is
   excluded by epoch milliseconds.

Root cause: the first inventory stored a repo-relative trace path for safe reading where the audit
contract requires the audit-relative `run.complete.policy_trace_ref`. The fixed strict schema
preserves both identities: trace entries carry the unique repo-relative source `ref`, their parent
`audit_ref`, and the exact audit-relative `trace_ref`; audit-run bindings repeat the latter plus
the SHA. Harvesting first verifies canonical 0600/single-link/no-follow artifacts from the explicit
`artifactRoot` using Task 1's generic canonical verifier, then uses only those verified values.
It reads each frozen source through one bounded `readSync` buffer and checks FD/path identity after
the read.

Isolated mutants ran in copies under `/tmp/reviewgate-task6-r1.HQFz1Y/` from and restored to SHA
`8ff0cd635fd51795fafbf50d8fb38ceac448829d`:

| Mutant | Killer | Actual failure |
|---|---|---|
| reject multi-run audit chains | multi-run production-chain fixture | throws `mutant` |
| omit exact audit/trace binding | wrong same-identity trace fixture | expected schema rejection absent |
| trust passed objects instead of artifact bytes | preregistered-artifact authority fixture | labels 0 → 1 |
| double-read audit FD | bounded-read fixture | source reads 2 → 3 |
| lexical timestamp comparison | epoch window fixture | offset-inclusive label 1 → 0 |
