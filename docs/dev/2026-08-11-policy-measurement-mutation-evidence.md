# Policy measurement mutation evidence — Slice 2A

This index consolidates the disposable-copy mutation evidence for Tasks 1–10. Every listed probe
was run on one production-file mutant, with the named test command below; the task report records
the literal RED output and SHA-256 restoration. No production source was mutated during Task 12.

| Task | Production family / SHA evidence | Exact named command and RED witness | Restore / final GREEN |
| --- | --- | --- | --- |
| 1 | Canonical JSON artifact containment, no-follow FD, mode, link, bounded-read, hash and canonicality; `src/artifacts/canonical-json.ts` | `bun test tests/unit/canonical-json-artifact.test.ts`; each named invalidity changed 10/10 rejections to 9/10, and the FD reread mutant changed 1 read to 2 | SHA restored in Task 1 report; named unit suite green |
| 2 | Preregistration and measurement schemas; preregistration/schema files | `bun test tests/unit/policy-measurement-preregistration.test.ts tests/unit/policy-measurement-schema.test.ts`; corpus/profile/threshold/authority mutants reject their exact fixture | Each detached-copy SHA recorded in Task 2 report; 41/233 focused green |
| 3 | Bench truth identity and profile pairing; `src/schemas/bench-result.ts`, `src/bench/runner.ts` | `bun test tests/unit/bench-result-schema.test.ts tests/unit/bench-runner.test.ts tests/unit/bench-matrix.test.ts`; dropped truth, signature, group/order, ran and response-order guards RED | Task 3 detached-copy restore SHAs; 91/629 focused green |
| 4 | Exact sign test, bootstrap and Holm statistics; `src/stats/policy/statistics.ts` | `bun test tests/unit/policy-statistics.test.ts`; boundary/adjustment mutants fail exact numeric witnesses | Task 4 report records source SHA restores and 8/30 green |
| 5 | Classification thresholds, vetoes and closed evidence; `src/stats/policy/classify.ts` | `bun test tests/unit/policy-classify.test.ts`; threshold, unique-benefit and authority closure mutants RED | Task 5 restore SHAs; classification/statistics green |
| 6 | Decision signatures, dogfood attribution and canonical frozen inventory; audit/schema/dogfood sources | `bun test tests/unit/policy-dogfood.test.ts tests/unit/policy-dogfood-attestation.test.ts`; representative, ordering, manifest/trace/audit join mutants RED | Task 6 isolated-copy SHA restores; planned six-suite green |
| 7 | Rig state, scenarios, cassette/script identity and interaction closure; `src/rig/replay.ts`, `src/rig/policy-replay-state.ts`, `src/stats/policy/rig.ts` | `bun test tests/unit/policy-rig-evidence.test.ts`; persistence, isolation, real-store, inventory and opportunity mutants RED | Task 7 restore SHAs; focused green |
| 8 | Registered Bench capture schedule and provider ceiling; `src/cli/commands/bench.ts` | `bun test tests/unit/bench-policy.test.ts`; 23-profile, repeats, replay order/consumption, truth and pre-provider mutants RED | Task 8 production SHA restores; focused green |
| 9 | Closed authoritative assembly; `src/stats/policy/assemble.ts` and Bench/Rig bindings | `bun test tests/integration/policy-measurement-pipeline.test.ts`; provenance, artifact closure, lane, carrier, response and identity mutants RED | Task 9 records every disposable SHA and delta restore; authority matrix green |
| 10 | Publication, CLI, renderer and TTY attestation; `src/cli/commands/stats.ts`, `src/cli/index.ts`, `src/stats/policy/render.ts`, canonical helper | `bun test tests/unit/stats-command.test.ts tests/unit/cli-required-args.test.ts tests/unit/policy-dogfood.test.ts tests/integration/policy-measurement-pipeline.test.ts`; exit, reservation, marker, TTY, identity-dossier and reproduced-by mutants RED | Task 10 SHA ledger/restores; controller focus 90/0/705 green |

## Source reports and restoration ledger

The exact commands, literal failing test names, observed RED output, per-mutant SHA-256 before and
after restoration, and final focused GREEN commands are preserved in the ignored reports:

- `.superpowers/sdd/2026-08-11-policy-measurement-pruning/task-1-report.md` through
  `task-10-report.md` (Task 8 has no brief but has its report);
- Task 10 additionally records the portable no-replace replacement protocol and review regression
  mutations; Task 11 is documentation-only and has no production mutation family.

Task 12 initially verified the committed branch only. The C1 review-bound delta below is the sole
subsequent production/test change; its targeted tests and static gates are recorded in the ignored
final report.

## Contract review C1 delta — capture/final lifecycle

The final-contract C1 finding required a test-first, no-provider correction: Bench exclusively
reserves the registered attempt root; Stats completes that unmarked capture root under a distinct
publication lock; JSONL is copied through the stable byte verifier rather than parsed as a JSON
document; and the marker binds every registered output and every copied inventory row. The
unmocked filesystem command test is
`tests/integration/policy-measurement-publication.test.ts` (real preregistration/capture files,
but no provider, Bench, Rig, Gate, or credits).

| Guard / restored production SHA-256 | Disposable mutation and exact command | Literal RED / restore |
| --- | --- | --- |
| Attempt-root exclusive reservation; `src/cli/commands/bench.ts` `e528995753159361910374dcf14fb17719c06b279ed39a0ff3478467de38d210` | Bypassed the `EEXIST` branch; `bun test tests/unit/bench-policy.test.ts -t 'existing preregistered attempt root'` | **0 pass / 1 fail / 1 expect**: expected exit 2, received 4. Restored SHA `e528995753159361910374dcf14fb17719c06b279ed39a0ff3478467de38d210`. |
| Kind-aware JSONL byte verifier; `src/cli/commands/stats.ts` `80303c9e79d61caa84cec5d456f8e2d8f4ea968b55a997258fc79cbfa99596d9` | Forced `.jsonl` through the canonical-JSON branch; `bun test tests/integration/policy-measurement-publication.test.ts -t 'completes a real'` | **0 pass / 1 fail / 1 expect**: expected exit 0, received 4. Restored SHA `80303c9e79d61caa84cec5d456f8e2d8f4ea968b55a997258fc79cbfa99596d9`. |
| Registered Rig/Dogfood publication; `src/cli/commands/stats.ts` `80303c9e79d61caa84cec5d456f8e2d8f4ea968b55a997258fc79cbfa99596d9` | Redirected staged `rig_bundle` away from its preregistered path; same unmocked command test | **0 pass / 1 fail / 1 expect**: expected exit 0, received 4. Restored SHA `80303c9e79d61caa84cec5d456f8e2d8f4ea968b55a997258fc79cbfa99596d9`. |
| Complete-marker closed source inventory; `src/cli/commands/stats.ts` `80303c9e79d61caa84cec5d456f8e2d8f4ea968b55a997258fc79cbfa99596d9` | Replaced `sources: copiedSources` with `sources: []`; same unmocked command test | **0 pass / 1 fail / 1 expect**: expected exit 0, received 4. Restored SHA `80303c9e79d61caa84cec5d456f8e2d8f4ea968b55a997258fc79cbfa99596d9`. |

Final GREEN for this delta is the focused command recorded in the final report, followed by
`bunx tsc --noEmit`, `bun run lint`, and `git diff --check`.

### Contract review C1 R1-B — five isolated guard mutations

Each R1-B mutation used a fresh `/tmp/reviewgate-c1-r1b-mut.*/repo` copy that contained the
current uncommitted C1 implementation and a read-only linked dependency tree. Production files in
this worktree were not edited: before/after SHA-256 was byte-identical for
`src/cli/commands/bench.ts` (`2f7f4795051959d399107ea5c6a0bbc36566a6659b793f8efd5ce578f0437ec0`)
and `src/cli/commands/stats.ts` (`bc00e9716accde7978936690b610c8b1b39df345d27b30303a68fa79b2da3c3d`).

| Guard | Disposable mutation / command | Numeric RED witness / restoration |
| --- | --- | --- |
| Preflight before exact attempt reservation | Disabled the invalid-preflight return in `src/cli/commands/bench.ts`; `bun test tests/unit/bench-policy.test.ts -t 'validates the literal 16-clean/14-seeded corpus'` | **0 pass / 1 fail / 10 expects**: named `only route` expected zero adapter factories, received one. Temp mutant discarded; production Bench SHA before/after exact. |
| Raw files, state-tree closure, duplicate refs | Made `verifySourceForPublication` read a state-tree as a file; `bun test tests/unit/policy-rig-evidence.test.ts -t 'publishes the complete 217-artifact Rig closure'` | **0 pass / 1 fail / 9 expects**: real closure rejected a directory as `not-a-file`. The GREEN has **1 pass / 449 expects**, including 217 real artifacts and duplicate-SHA distinct copies. Temp mutant discarded; production Stats SHA before/after exact. |
| Arbitrary nested five-output refs | Rejected any registered output ref containing `/`; `bun test tests/integration/policy-measurement-publication.test.ts -t 'publishes all five valid nested'` | **0 pass / 1 fail / 1 expect**: expected exit 0, received exit 4. Temp mutant discarded; production Stats SHA before/after exact. |
| Post-lock no-partial cleanup | Retained identity-owned empty parent directories; `bun test tests/unit/stats-command.test.ts -t 'treats missing or tampered completion markers'` | **0 pass / 1 fail / 7 expects**: expected capture contents `["bench.json"]`, received `["artifacts", "bench.json"]`. Temp mutant discarded; production Stats SHA before/after exact. |
| Bench/inventory join and deterministic copied-source closure | Compared the result inventory to the relative published Bench ref rather than the preregistered repo ref; `bun test tests/integration/policy-measurement-publication.test.ts -t 'completes a real preregistered capture root'` | **0 pass / 1 fail / 1 expect**: expected empty stderr, received completion-marker authority exit 4. The same integration suite additionally has a direct Bench-output/inventory divergence plus redirected-`copy_ref` rejection. Temp mutant discarded; production Stats SHA before/after exact. |

### Contract review C1 R1-C — nested real Bench assembler root

The real canonical Bench stack now writes generated artifacts beneath the registered
`attempt_dir`, while the registered Bench JSON may be a nested descendant. RED:
`bun test tests/integration/policy-measurement-pipeline.test.ts -t 'assembles a real nested registered Bench stack'`
returned **0 pass / 1 fail / 1 expect**, exit 4 `response-pair-mismatch — baseline profile missing`.
GREEN after deriving `artifactRoot` from verified `prereg.outputs.attempt_dir`: **1 pass / 0 fail /
2 expects**. In isolated `/tmp/reviewgate-c1-r1c-mut.8TjVFF/repo`, restoring the `dirname` behavior
reproduced the same **0 pass / 1 fail / 1 expect** RED. Production
`src/stats/policy/assemble.ts` SHA before/after the disposable mutation was
`ea8f45eafc31beeb5719daa7bd00dd5d5aaee9efaf5dbff68ab127a0174ff471`.

## Restored production binding at Task 12

The task reports retain the before/mutant/restore SHA for every individual probe. The following
SHA-256 values bind the restored production sources on the final-verification tree
`3819f0a65973dab3ea79eab6520635d579389294`; they were recomputed before the final gates:

| Source | SHA-256 |
| --- | --- |
| `src/artifacts/canonical-json.ts` | `f0124d3a5b3dc617f2a70ced77f0c9176ff4f7013a3b82928d05ab1a2bc25d5a` |
| `src/schemas/policy-measurement-preregistration.ts` | `2d24189d413792ee936b2119cbdf5cfea4ee00ae7da947e78b5b1cb5610ebbf8` |
| `src/schemas/policy-measurement.ts` | `e84b02fe4f662a2b845d44f908232a641e93bcea9050110eb924bd507ac43384` |
| `src/bench/runner.ts` | `ff87e6acc00d9d9221b75c2f0986d10361c320abd98cc9db3ba39eccf436e169` |
| `src/cli/commands/bench.ts` | `fde070d159fec1ea9535aceb6c0c5cf2379942a4dfdd2796c0c5437dc631db30` |
| `src/stats/policy/statistics.ts` | `ddfe4a2ce8c30261bb1cb90977fe84bd9fda281dbb619b53589c0d6f03e60fa0` |
| `src/stats/policy/classify.ts` | `b679425805aaaadf1b9cfaa68b0a57c994259a0ae4e27606fbe1d602ce299233` |
| `src/stats/policy/dogfood.ts` | `d51de703cdbd8b979cf9afcd5ca8cdf2b42d24c92c6ec1e7a6ff15008cca8162` |
| `src/stats/policy/rig.ts` | `6325ce79e0c46682f85f3bd2d065d0693bd76fbcdef0a2623b3b1c0fb897f2dc` |
| `src/stats/policy/assemble.ts` | `1e7cf2d9bdec6a9bf7f90983e86d65fcbcbde13821c4868f404ffb710c3f463f` |
| `src/stats/policy/render.ts` | `6366279fe993d4c9ace6aae323f25c2fa2573cd9008ff7d965d28ba51913ce02` |
| `src/cli/commands/stats.ts` | `d92cb1c9eaf0316db89f810e0e9a579f54e27069ed8d3babcea894deefda719b` |
