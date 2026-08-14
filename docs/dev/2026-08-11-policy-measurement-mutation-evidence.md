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

Task 12 initially verified the committed branch only. The subsequent C1--C4 review-bound deltas
are individually TDD- and mutation-bound below; their targeted tests and static gates are recorded
in the ignored final report.

## Contract review C4 delta — paired group-identity causal closure

The final-contract C4 review correctly found that the inherited assembler inferred
`unique_contributions` and `reproduced_by_pass_ids` from matching singleton labels rather than a
paired group comparison. The correction consumes only the already verified in-memory singleton and
group values: it does not reread a source or create a second authority. Every group now persists its
exact code-unit-sorted identity-level worsened/improved inventory and exact verified raw-reference
bindings. The schema closes the aggregate signed identity delta against the paired group truth
delta, so an omitted or added identity cannot remain self-consistent merely by changing the
inventory.

The primary-tree REDs were observed before their minimal guards:

- The old label heuristic failed `keeps singleton losses unique when a necessary overlapping cofactor
  has the same group loss` (**0 pass / 1 fail / 1 expect**): it fabricated
  `reproduced_by_pass_ids` for the cofactor instead of preserving both singleton losses as direct
  unique evidence.
- The initial persisted form accepted removal of an unrelated paired-group identity:
  `requires every paired group identity outcome and exact singleton/group bindings` was **0 pass /
  1 fail / 4 expects** before signed identity-delta closure.
- An offsetting improvement hid an uncovered worsened identity before the classifier examined the
  inventory: `discharges a group-harm veto only when every worsened identity has a retained overlap`
  was **0 pass / 1 fail / 3 expects**. The mutant result was wrongly `delete-candidate`.

The minimal result is deliberately conservative. A direct unique fact requires a target singleton
loss corroborated by the same group identity. A reproduced fact requires the target singleton not
to worsen, a matching group loss, and an independently retained overlapping singleton that worsens
the same identity. A required-backstop is emitted only from a target singleton loss with the
catalog-proven protection rule; group-only harm remains an `inconclusive` deletion veto. For every
interaction, every worsened identity must be closed by a retained overlap before deletion proceeds.

| Guard / restored production SHA-256 at mutation time | WITH named guard | WITHOUT single mutant and literal RED / restore |
| --- | --- | --- |
| Same paired-group identity is required for a direct unique contribution; `src/stats/policy/assemble.ts` `7af009964b423d16815311f5dcd1e6cb737417820b9d12be17727f3e4b6ce424` | `leaves a singleton loss inconclusive without the same paired group identity`: **1 pass / 0 fail** | Treat the group identity as stable unconditionally: **0 pass / 1 fail**; SHA restored exact. |
| Singleton loss remains direct unique for a necessary cofactor; same assembler SHA | `keeps singleton losses unique when a necessary overlapping cofactor has the same group loss`: **1/0** | Invert the direct-unique branch so it emits no contribution: **0/1**; SHA restored exact. |
| Identity facts bind the exact group raw-reference closure; same assembler SHA | Same cofactor guard: **1/0** | Emit an empty `group_comparison.raw_evidence`: **0/1**; strict schema rejects the unbound fact; SHA restored exact. |
| Required-backstop originates in singleton plus catalog protection; same assembler SHA | `emits a catalog-bound required-backstop identity only from its singleton and paired group loss`: **1/0** | Never emit the backstop: **0/1**; expected protected backstop is absent; SHA restored exact. |
| Necessary cofactors are not fabricated as reproduction; same assembler SHA | Same cofactor guard: **1/0** | Force a reproduced relation despite the target singleton loss: **0/1**; strict identity contract rejects it; SHA restored exact. |
| Every harmful identity, not merely any one, requires a retained cover; `src/stats/policy/classify.ts` `58374d81dec4ead00d8f8ce244f280f161bdef794e53aa0bfd60eb4a19f5e40f` | `discharges a group-harm veto only when every worsened identity has a retained overlap`: **1/0** | Change `every` to `some`: **0/1**; a partially covered group wrongly becomes deletable; SHA restored exact. |
| Offsetting improvements cannot suppress an uncovered harmful identity; same classifier SHA | Same guard with zero aggregate error delta: **1/0** | Ignore nonempty harmful identity inventory when aggregate harm is zero: **0/1**; result wrongly becomes `delete-candidate`; SHA restored exact. |
| Persisted group inventory cannot omit or add an outcome; `src/schemas/policy-measurement.ts` `1e1646786af94fba9e61e6b7401f7a76d782ed67f9cc6120de413c201a7d3e35` | `requires every paired group identity outcome and exact singleton/group bindings`: **1/0** | Bypass signed identity-delta closure: **0/1**; omitted inventory accepted; SHA restored exact. |

All eight mutants ran in the non-Git disposable copy
`/private/tmp/reviewgate-task12-c4-mutants.Rghncn/repo`, with only that copy's production files
changed. The restored sources were compared after every probe. Current final-source SHA-256 values
after formatting-only hygiene are `policy-measurement.ts=b8e5e78b4331c524a5934d464228baad869c91acc7ab04576795f11fa9e98b5f`,
`assemble.ts=e82a2a910a30180bba8adb994a1a78931d484ea4a1b801a5c8e40b2b5b38155b`,
`classify.ts=58374d81dec4ead00d8f8ce244f280f161bdef794e53aa0bfd60eb4a19f5e40f`, and
`render.ts=4252d978a389d26eb1d04aa86868df6098c62a4f927c50a287efd68fd97fec35`.

Current-source verification is
`bun test tests/unit/policy-measurement-schema.test.ts tests/unit/policy-classify.test.ts tests/unit/policy-dogfood.test.ts tests/unit/policy-assemble.test.ts tests/unit/policy-render.test.ts tests/unit/stats-command.test.ts tests/integration/policy-measurement-pipeline.test.ts tests/integration/policy-measurement-publication.test.ts`
-> **111 pass / 0 fail / 982 expect() calls**, 36.27s. The focused schema/classify pair is **44
pass / 0 fail / 114 expects**. Fresh `bunx tsc --noEmit`, `bun run lint` (Biome checked 694 files,
no fixes), `git diff --check`, and `git diff --cached --check` all exit 0. No stage, commit, full
suite/build, provider, Gate, real Rig, real measurement, credits, push, or merge occurred.

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

## Contract review C2 delta — one ground-truth harm plus confirmed dogfood TP

The inherited uncommitted C2 implementation separates the broad 5-disposition/3-run dogfood
corroboration threshold from one raw-reference-bound suppressed true-positive counterexample.
The final-contract review's pre-fix RED is retained in `.review/final-contract-findings.md`:
the literal 1-ground-truth-plus-1-TP probe returned `inconclusive`. The additional literal
positive/negative tests below were added after that inherited implementation and are therefore
mutation-proven rather than misrepresented as a second primary-tree RED.

| Guard / restored production SHA-256 | Disposable mutation and exact command | Literal RED / restore |
| --- | --- | --- |
| One ground-truth harm plus one TP is independent of broad 5/3 corroboration; `src/stats/policy/classify.ts` `7baa8a38ac8389be6a78af5211ddcf8f1b0ace2df4928ec1f4e47f8f3957d57c` | Re-coupled both `harm_observed` and the harmful branch to `dogfoodSufficient`; `bun test tests/unit/policy-classify.test.ts -t 'labels exactly one bound ground-truth harm plus one confirmed TP harmful below 5 dispositions across 3 runs'` | **0 pass / 1 fail / 15 filtered / 3 expects**: expected `harmful-candidate`, received `inconclusive`. Restored SHA `7baa8a38ac8389be6a78af5211ddcf8f1b0ace2df4928ec1f4e47f8f3957d57c`. |
| Lone bound TP vetoes deletion; `src/stats/policy/classify.ts` `7baa8a38ac8389be6a78af5211ddcf8f1b0ace2df4928ec1f4e47f8f3957d57c` | Removed the bound suppressed-TP term from `harmObserved`; `bun test tests/unit/policy-classify.test.ts -t 'a lone bound confirmed suppressed TP observes harm and vetoes deletion'` | **0 pass / 1 fail / 15 filtered / 1 expect**: expected `harm_observed: true`, received `false`. Restored SHA exact. |
| Unbound TP cannot supply the 1+1 counterexample; `src/stats/policy/classify.ts` `7baa8a38ac8389be6a78af5211ddcf8f1b0ace2df4928ec1f4e47f8f3957d57c` | Allowed a suppressed TP to bypass `factsBound` in the harmful branch; `bun test tests/unit/policy-classify.test.ts -t 'does not accept unbound or non-suppressed dogfood rows as a counterexample'` | **0 pass / 1 fail / 15 filtered / 1 expect**: expected `inconclusive`, received `harmful-candidate`. Restored SHA exact. |
| Historical agent-only and missing-decision rows are not eligible dogfood facts; `src/stats/policy/dogfood.ts` `d51de703cdbd8b979cf9afcd5ca8cdf2b42d24c92c6ec1e7a6ff15008cca8162` | Injected an otherwise schema-shaped, unvalidated `sig-no-decision` historical/missing label into the final snapshot; `bun test tests/unit/policy-dogfood.test.ts -t 'excludes agent-authored historical labels and missing decisions from the eligible snapshot'` | **0 pass / 1 fail / 19 filtered / 1 expect**: expected the sole attested `sig-a` label, received `sig-a` plus `sig-no-decision`. Restored SHA exact. |

Final C2 focused GREEN in the restored disposable copy:
`bun test tests/unit/policy-classify.test.ts tests/unit/policy-dogfood.test.ts` -> **36 pass / 0 fail /
82 expect() calls**. No primary production file was edited during mutation testing.

## Contract review C3 delta — complete descriptive Bench/Rig/Dogfood lanes

The final-contract C3 finding was verified against the real authoritative pipeline fixture: before
this delta, the stateful-primary pass had a verified Bench carrier but no secondary Bench summary
(`bun test tests/integration/policy-measurement-pipeline.test.ts -t 'reports every applicable Bench Rig and Dogfood lane without promoting secondary authority'` -> **0 pass / 1 fail / 18 filtered / 2 expects**, missing `lane_summaries`). The correction is additive: every singleton has its verified Bench
summary, stateful singletons additionally have their Rig summary, and every singleton has its
verified dogfood summary. Every registered interaction has Bench; the all-history interaction also
has Rig. Dogfood has no preregistered group-ablation source, so it is not invented as an interaction
lane. Existing `PolicyPassEvidence` remains the explicitly selected primary classification input;
the summaries are descriptive and cannot establish deletion sufficiency.

| Guard / restored production SHA-256 | Disposable mutation and exact command | Literal RED / restore |
| --- | --- | --- |
| Stateful summary must retain the valid secondary Bench lane rather than select Bench *or* Rig; `src/stats/policy/assemble.ts` `204887cf9a8cb63001d30e2cbd8a2ae2af12adff5272da48f6d2b03372e6dbb5` | Restored the old either/or behavior by omitting `bench.laneSummary` whenever Rig was present; `bun test tests/integration/policy-measurement-pipeline.test.ts -t 'reports every applicable Bench Rig and Dogfood lane without promoting secondary authority'` | **0 pass / 1 fail / 18 filtered**: final authority schema rejected `passes.10.evidence.lane_summaries` as incomplete. Restored SHA exact. |
| Stateless secondary summaries are authoritative and eligible even for stateful-primary passes; `src/stats/policy/assemble.ts` `204887cf9a8cb63001d30e2cbd8a2ae2af12adff5272da48f6d2b03372e6dbb5` | Reintroduced a `stateless-bench`-dependent `eligible: false`; same pipeline command | **0 pass / 1 fail / 18 filtered**: schema rejected `passes.0.evidence.lane_summaries.0.eligible` (expected literal `true`). Restored SHA exact. |
| History interaction cannot substitute Rig for its verified Bench lane; `src/stats/policy/assemble.ts` `204887cf9a8cb63001d30e2cbd8a2ae2af12adff5272da48f6d2b03372e6dbb5` | Omitted the Bench interaction summary whenever the Rig interaction was selected as primary; same pipeline command | **0 pass / 1 fail / 18 filtered**: schema rejected `interactions.2.lane_summaries` as incomplete. Restored SHA exact. |
| Every pass retains its descriptive dogfood lane, including no-opportunity rows; `src/stats/policy/assemble.ts` `204887cf9a8cb63001d30e2cbd8a2ae2af12adff5272da48f6d2b03372e6dbb5` | Omitted the dogfood summary for every stateful-primary pass; same pipeline command | **0 pass / 1 fail / 18 filtered**: schema rejected `passes.10.evidence.lane_summaries` as incomplete. Restored SHA exact. |
| A descriptive secondary Bench lane cannot grant stateful deletion sufficiency; `src/stats/policy/classify.ts` `7baa8a38ac8389be6a78af5211ddcf8f1b0ace2df4928ec1f4e47f8f3957d57c` | Made the stateful primary-sufficiency predicate consume the descriptive Bench opportunities/statistics; `bun test tests/unit/policy-classify.test.ts -t 'does not let a descriptive secondary Bench summary establish stateful deletion sufficiency'` | **0 pass / 1 fail / 16 filtered / 1 expect**: expected `inconclusive`, received `delete-candidate`. Restored SHA exact. |

All five mutations ran in `/private/tmp/reviewgate-task12-c2.b3mjvS/repo`, which carries a
read-only `node_modules` link and is not a Git worktree. Final bytes after the last restore were
`assemble.ts=204887cf9a8cb63001d30e2cbd8a2ae2af12adff5272da48f6d2b03372e6dbb5`,
`classify.ts=7baa8a38ac8389be6a78af5211ddcf8f1b0ace2df4928ec1f4e47f8f3957d57c`, and
`policy-measurement.ts=9a3d20f9068bfe9a78c8b7bfd34ef2ab95994dd050660cca7ed26b1a8c86dcbe`.
The final named all-lanes guard is **1 pass / 0 fail / 18 filtered / 498 expects**. Its seven-file
focused command is **74 pass / 0 fail**; fresh `bunx tsc --noEmit`, `bun run lint` (Biome 694 files,
no fixes), `git diff --check`, and `git diff --cached --check` all exit 0.

## Contract review C3 R2 — persisted primary-authority closure

The R2 reviewer correctly found that the initial all-lanes result schema still accepted a
self-declared primary lane and derived its required inventory from that value. Four independent
schema witnesses were added first: the pre-fix command
`bun test tests/unit/policy-measurement-schema.test.ts -t 'catalog-stateful pass|promotion of the registered history interaction|primary pass summary|primary interaction summary'`
returned **0 pass / 4 fail / 14 filtered / 4 expect() calls**. The failures were the intended
`true` acceptance of a stateful-to-Bench pass promotion, a history Rig-to-Bench promotion, and a
drifted selected pass or interaction statistic.

The persisted contract now derives each pass primary lane from
`POLICY_MEASUREMENT_LANES[pass_id]`, derives each interaction authority from the exact closed
registered group (only all-history is Rig), and derives canonical summary inventory from those
authorities rather than serialized fields. The selected summary exactly projects shared primary
opportunities, truth effects, trace totals when the primary evidence has them, statistics, raw
references, and primary/descriptive direction. The explicit exception is the supplementary dogfood
`runs` and exclusions on singleton top-level evidence. The compatibility RED showed the real
assembler was still giving its selected summary fewer references than the classification consumed;
the minimal fix projects the top-level selected raw-reference set into that one primary summary.
The four witness command is now **4 pass / 0 fail / 14 filtered / 4 expect() calls**, and the real
all-lanes pipeline fixture is **1 pass / 0 fail / 18 filtered / 498 expect() calls**.

| Guard / final restored production SHA-256 | Disposable mutation and exact command | Literal RED / restore |
| --- | --- | --- |
| Catalog-stateful pass cannot self-promote to Bench; `src/schemas/policy-measurement.ts` `c674523bc9b15509fadd7efa4754369fa6b036e4dd17379d6ce40169bc1389c9` | Replaced the catalog-derived pass lane with serialized `value.lane`; `bun test tests/unit/policy-measurement-schema.test.ts -t 'catalog-stateful pass promoted to stateless'` | **0 pass / 1 fail / 17 filtered / 1 expect**: expected rejection, received accepted `true`. Restored SHA exact. |
| Closed history interaction cannot promote Rig authority to Bench; same schema SHA | Restored the prior serialized-primary interaction path while retaining the group-derived lane inventory; `bun test tests/unit/policy-measurement-schema.test.ts -t 'promotion of the registered history interaction from Rig to Bench'` | **0 pass / 1 fail / 17 filtered / 1 expect**: expected rejection, received accepted `true`. Restored SHA exact. |
| Selected pass summary cannot drift from its primary evidence; same schema SHA | Omitted `requirePrimaryPassSummaryParity`; `bun test tests/unit/policy-measurement-schema.test.ts -t 'primary pass summary whose statistics drift'` | **0 pass / 1 fail / 17 filtered / 1 expect**: expected rejection, received accepted `true`. Restored SHA exact. |
| Selected interaction summary cannot drift from its primary authority; same schema SHA | Omitted `requirePrimaryInteractionSummaryParity`; `bun test tests/unit/policy-measurement-schema.test.ts -t 'primary interaction summary whose statistics drift'` | **0 pass / 1 fail / 17 filtered / 1 expect**: expected rejection, received accepted `true`. Restored SHA exact. |

All R2 mutants ran only in `/private/tmp/reviewgate-c3r2-mutants.v3nuol/repo`, an 84 MiB
non-Git disposable copy with a read-only `node_modules` link. Its schema SHA was rechecked after
every restore against the primary tree. Final C2/C3 focus:
`bun test tests/unit/policy-measurement-schema.test.ts tests/unit/policy-classify.test.ts tests/unit/policy-assemble.test.ts tests/unit/policy-render.test.ts tests/unit/stats-command.test.ts tests/unit/policy-dogfood.test.ts tests/integration/policy-measurement-pipeline.test.ts tests/integration/policy-measurement-publication.test.ts`
-> **98 pass / 0 fail / 1,191 expect() calls**, 33.85s. Fresh `bunx tsc --noEmit`, `bun run lint`
(Biome 694 files/no fixes), `git diff --check`, and `git diff --cached --check` all exit 0.

## Contract review C3 R3 — Dogfood ownership and lane-specific raw-reference closure

The R3 reviewer identified two authority leaks: selected Bench/Rig rows could carry Dogfood's
supplementary run/exclusion facts, and the R2 producer projected the aggregate top-level raw refs
back into the selected lane summary. The latter made the Dogfood input-manifest and attestation
look like Bench/Rig evidence. The final contract therefore keeps lane refs lane-specific and uses
the top-level pass list only as the exact code-unit-sorted union of every applicable lane ref and
closed interaction ref.

Four new schema witnesses were observed before their boundary guard existed:
`bun test tests/unit/policy-measurement-schema.test.ts -t 'selected Bench|selected Rig|Dogfood summary to own|top-level pass references'`
returned **0 pass / 4 fail / 18 filtered / 4 expect() calls**. The deliberate invalidities were a
selected Bench row with Dogfood runs/exclusions, the corresponding selected Rig row, a Dogfood row
whose facts differed from top-level supplementary facts, and a partial top-level ref list. The
minimal schema guard makes non-Dogfood summaries require `runs: 0` and empty exclusions, makes the
Dogfood row exactly match top-level supplementary runs/exclusions, and closes the aggregate union.
The same command is now **4 pass / 0 fail / 18 filtered / 4 expect() calls**.

The real assembler/render witness was also RED first:
`bun test tests/integration/policy-measurement-pipeline.test.ts -t 'reports every applicable Bench Rig and Dogfood lane without promoting secondary authority'`
returned **0 pass / 1 fail / 18 filtered / 499 expect() calls** with 38 structured lane leaks and
38 rendered leaks: every Dogfood input-manifest/attestation ref appeared in a selected Bench or
Rig row. The producer now assigns lane-specific refs without an overwrite, then constructs only
the top-level union. The restored same command is **1 pass / 0 fail / 18 filtered / 499 expect()
calls**.

| Guard / final restored production SHA-256 | Disposable mutation and exact command | Literal RED / restore |
| --- | --- | --- |
| Dogfood exclusively owns supplementary runs and exclusions; `src/schemas/policy-measurement.ts` `08eb2083f24069f9a5f907bd591875971a615e5f1273031d5b616c21e1450f63` | Removed `requireDogfoodSupplementaryOwnership`; `bun test tests/unit/policy-measurement-schema.test.ts -t 'selected Bench|selected Rig|Dogfood summary to own'` | **0 pass / 3 fail / 19 filtered / 3 expects**: all three invalid forms became accepted. Restored schema SHA exact. |
| Selected Bench/Rig summary must not receive top-level aggregate refs; `src/stats/policy/assemble.ts` `ba33482b07944c76bc2a3982af6124ab4244a90188fce81bc2d75db47a8825f9` | Reintroduced a primary-summary assignment from `primary.evidence.raw_evidence_refs`; `bun test tests/integration/policy-measurement-pipeline.test.ts -t 'reports every applicable Bench Rig and Dogfood lane without promoting secondary authority'` | **0 pass / 1 fail / 18 filtered / 499 expects**: the real lane and Markdown checks report the manifest/attestation leaks. Restored assembler SHA exact. |
| Top-level pass refs must equal the lane-plus-interaction union; same schema SHA | Removed the per-pass aggregate-union refinement; `bun test tests/unit/policy-measurement-schema.test.ts -t 'top-level pass references'` | **0 pass / 1 fail / 21 filtered / 1 expect**: the partial top-level list became accepted. Restored schema SHA exact. |

All R3 mutants ran only in `/private/tmp/reviewgate-c3r3-mutants.5F1DLG/repo`, an 84 MiB non-Git
copy with a read-only `node_modules` link. Both production hashes were rechecked after every
restore. A first combined focus exposed an invalid `policy-classify` test helper that copied
Dogfood's `runs: 3` into Bench/Rig summaries; the helper was corrected to mirror the persisted
contract, then the full proportional current-source focus was rerun:
`bun test tests/unit/policy-measurement-schema.test.ts tests/unit/policy-classify.test.ts tests/unit/policy-assemble.test.ts tests/unit/policy-render.test.ts tests/unit/stats-command.test.ts tests/unit/policy-dogfood.test.ts tests/integration/policy-measurement-pipeline.test.ts tests/integration/policy-measurement-publication.test.ts`
-> **100 pass / 0 fail**. Fresh `bunx tsc --noEmit`, `bun run lint` (Biome checked 694 files/no
fixes), `git diff --check`, and `git diff --cached --check` all exit 0. No stage, commit, full
suite/build, provider, Gate, real Rig, real measurement, credits, push, or merge occurred.

## Contract review C3 R3 convergence — persisted lane raw-reference ownership

The final R3 residual showed that producer lane-specificity alone was insufficient: a persisted
result could add an otherwise inventory-bound Dogfood ref to a selected Bench or Rig summary while
keeping the top-level union self-consistent. The closed contract grants no shared lane-summary-ref
exception. Bench rows derive from the verified profile/result/trace family, Rig rows from the
scenario/cassette/trace/state family, and Dogfood rows from frozen audit/trace plus its manifest and
attestation; interaction refs are aggregated only in the enclosing top-level pass refs.

The primary-tree schema/render RED was created before the guard:
`bun test tests/unit/policy-measurement-schema.test.ts -t 'raw reference'` -> **0 pass / 3 fail /
22 filtered / 3 expect() calls**. Two distinct `dogfood/only.json` witnesses were added to the
closed inventory, Dogfood, and the selected Bench or Rig summary; each was accepted and its
selected Markdown lane rendered the Dogfood ref. A third witness showed the same unauthorized
sharing between a descriptive Bench and selected Rig lane.

The minimal persisted boundary rejects any raw ref owned by more than one pass lane summary. Its
same named GREEN is **3 pass / 0 fail / 22 filtered / 3 expect() calls**. The synthetic schema
fixture's former shared `evidence/a.json` placeholder was replaced with separate, inventory-bound
`stateless-bench/…`, `stateful-rig/…`, and `dogfood/…` refs; this is a fixture correction to match
the explicit no-sharing contract, not an allowed production exception.

| Guard / final restored production SHA-256 | Disposable mutation and exact command | Literal RED / restore |
| --- | --- | --- |
| No raw evidence ref may belong to more than one persisted pass lane; `src/schemas/policy-measurement.ts` `4bf9464b1d303376bfcbbfb9daa2df0322423db5a8d018ef4e0c86d70269063d` | Removed `requirePassLaneRawRefDisjointness`; `bun test tests/unit/policy-measurement-schema.test.ts -t 'raw reference'` | **0 pass / 3 fail / 22 filtered / 3 expects**: both Dogfood-to-selected-lane cases became accepted/rendered and Bench/Rig sharing became accepted. Restored schema SHA exact. |

The disposable mutation copy is `/private/tmp/reviewgate-c3r3-r4-mutants.79wMgM/repo`; its source
hash was compared to primary after restoration. Current residual focus is `policy-measurement-schema`
**25 pass / 0 fail / 73 expects** and `policy-measurement-pipeline` **18 pass / 0 fail**. Fresh
`bunx tsc --noEmit`, `bun run lint` (Biome 694/no fixes), `git diff --check`, and
`git diff --cached --check` all exit 0. No stage, commit, full suite/build, provider, Gate, real
Rig, real measurement, credits, push, or merge occurred.

## Controller aggregate regression — stale fixture canonicalization

The final eight-file controller command first exposed **92 pass / 13 fail / 1,122 expects**. Twelve
Stats/publication failures were the intended strict-schema rejection, `pass lane summaries must not
share raw evidence references`; the apparent Classify failure had already returned
`delete-candidate` and then failed only while parsing the same stale fixture. The source was test
factories that projected one inventory list into every Bench/Rig/Dogfood lane, not a production C2
semantic change. The existing bound-suppressed-TP veto guard remains green.

Only fixture producers were corrected: they now provide distinct physical, inventory-bound Bench,
Rig, and Dogfood refs to each lane summary, use an exact lane-plus-applicable-interaction top-level
union, and strip fixture-only source `kind` metadata before strict persisted bindings. No schema or
production guard changed, so no new mutation family was required; the existing raw-reference
disjointness mutant remains the authority witness above. The exact controller command is now
**105 pass / 0 fail**. Fresh `bunx tsc --noEmit`, `bun run lint` (Biome 694 files/no fixes),
`git diff --check`, and `git diff --cached --check` exit 0. No stage, commit, full suite/build,
provider, Gate, real Rig, measurement, credits, push, or merge occurred.

## Contract review C4 R1 — lane-aware unit-event and derived-attribution closure

The R1 review was correct on all three reported authority gaps. The new common in-memory
`PolicyIdentityEvent` records every source-bound Bench case/repeat or Rig scenario/turn outcome;
the persisted aggregate outcome list is its exact sorted projection, not an independent scalar
claim. Bench therefore still requires two worsened repeat units while a Rig identity needs only one
exact scenario/turn unit. Every benefit/direct contribution now carries target singleton and
applicable group directions, baseline catalog-protection when applicable, and exact causal
reproducer facts. The strict result schema derives the contribution kind, validates retained
reproduction, and checks the persisted classification/reasons/vetoes/harm/ref list against a fresh
deterministic two-phase result. Publication recomputes interaction events from copied Bench sources
and verified Rig values; compatibility is limited to a historical unparsable Bench bundle that
claims no unit-event authority.

| Guard / restored SHA-256 | WITH / WITHOUT numeric witness |
| --- | --- |
| Rig one-unit stability; `src/core/policy/identity-events.ts` `60a06f77e5fbc03fbf419f1af9dfdc51c3a4cd7055f10be75dc5ab57e79000a4` | Named real Rig test WITH **1/0/23 filtered/3 expects**; changing Rig `>=1` to `>=2` WITHOUT **0/1/23/3**. |
| Exact event projection; `src/schemas/policy-measurement.ts` `14d00571c6c2eb7871c8f1643470b8727f5ecf9796e8ea36b19a346c27d720b0` | Same-delta transfer/substitution is rejected WITH; removing projection was WITHOUT **0/1/29/2** (`{A:3}` accepted). |
| Direct singleton, derived backstop, retained Q, and fresh-decision closure; same schema SHA | Zero singleton and fake backstop mutants were each **0/1/29/1**. The non-retained Q witness was **0/1/29/1** only when both its retained-Q predicate and independent fresh-classification parity were bypassed; either guard rejects alone. |
| External copied-source closure; `src/cli/commands/stats.ts` `68144c44bcab099144eb0e794b773ca1da57bb0aee622167b17777b3d28227ac` | Named external verifier WITH **1/0/4/2**; bypassing recomputation was WITHOUT **0/1/4/1**, publishing exit 0. |

All six families ran only in `/private/tmp/reviewgate-c4-r1-mutants.zHtAb2/repo`; exact before/after
SHA comparisons restored every production file. Primary REDs were Rig **0/1/23/3**, count transfer
**0/1/29/2**, zero-singleton retain, relabelled backstop, non-retained cover, and source-incomparable
publication **0/1**. Restored GREEN is schema **30/0/84**, five-file C4 focus **94/0/1126**, and
eight-file C2/C3/C4 regression **117/0/1186**. Fresh tsc, Biome **695/no fixes**, working/cached
diff exit 0. No stage, commit, full suite/build, provider, Gate, real Rig/measurement, credits,
push, or merge occurred.

## Contract review C4 R3 — preregistered Rig source anchor

The R2 reviewer correctly found that external verification accepted a self-consistent replacement
Rig graph because singleton and history-group source expectations came from the mutable published
bundle/result. Two permanent current-primary tests first demonstrated that authority failure:
`bun test tests/integration/policy-measurement-pipeline.test.ts -t 'rejects a self-consistent
published Rig (group|manifest) source substitution'` was **0 pass / 2 fail / 28 filtered / 8
expects**. The failures expected external rejection and instead received acceptance.

The minimal fix passes only the already byte-verified preregistration
`stateful.manifest_ref`/`stateful.manifest_sha256` into `verifyPublishedIdentityEventClosure`. It
requires the copied source, published `rig.scenario_manifest`, and every stateful interaction
artifact to equal that preregistered binding; expected Rig singleton and history-group events then
derive from it. The same two-guard command was GREEN at **2 pass / 0 fail / 28 filtered / 8
expects**. A later final-current-source group guard was **1 pass / 0 fail / 29 filtered / 4
expects** in **97.23s**.

| Authority guard / mutation copy | WITH / WITHOUT result | Restore evidence |
| --- | --- | --- |
| Preregistration anchor cannot be replaced by published manifest | Changing the caller to `rigBundle.value.scenario_manifest` was **0 pass / 1 fail / 29 filtered / 4 expects**. | `src/cli/commands/stats.ts` restored to `d8003164a3f998c604b04832d99faf2eb73b73f76280c263b25f2484c7704d56`. |
| Stateful group source cannot derive from published interaction artifact | Removing exact artifact equality and sourcing expected groups from `interaction.artifact` was **0 pass / 1 fail / 29 filtered / 4 expects**. | Same exact source SHA restored. |

Both mutations used only `/private/tmp/reviewgate-c1-r3-mut-soo5X1/repo`, the sole authorized
disposable copy; no primary source was mutated. A test-only `TS2698` return-type assertion and a
mechanical Biome format pass followed the mutation checkpoint. Final source SHAs include
`stats.ts=b8e50a74a394c6de7f0b64bf6574d9a1b665b49d7c29b23531fbad8e1ce79fca` and
`identity-events.ts=711b68da52b47c4108c36d547d7fa4ce4ef2355a0ad2fc033f8ba74c3a5b1bc1`.

The default-parallel exact eight-file C4 focus was **124 pass / 2 timeout failures / 1,206
expects**; a serial diagnostic was **125 pass / 1 timeout failure / 1,206 expects**. The only
failures were these individually passing substitution guards exceeding their existing 120s
per-test budget under composite scheduling. Per controller ruling, neither the composite nor its
timeout is changed or retried; this is an explicit timing limitation, not a passing composite
result. The individual final current-source group guard above and the earlier singleton
**1/0/29/4** result are the proportional closure evidence. Fresh final `bunx tsc --noEmit` exited
0, `bun run lint` checked **695 files with no fixes**, and both `git diff --check` and
`git diff --cached --check` exited 0. HEAD remains `1aef80a0983d8d33ef1cdc62d85ae35b08f3eadd`;
staging is empty. No commit, full suite, build, provider, Gate, real Rig, measurement, credits,
push, or merge occurred.

## Contract review C5 R1 — source-derived statistics and byte-exact report closure

The C5 delta review correctly rejected four authority/report gaps. The final bundle verifier now
recomputes the Bench and Rig lane statistics, case dossiers, and Holm projection from the already
byte-verified copied inputs; it derives Dogfood from the same caller-owned frozen manifest,
attestation, audit, and trace bytes. The live harvester delegates to that pure derivation, so the
final verifier adds no reread or competing authority path. It also requires `report.md` to be the
byte-exact `renderPolicyMeasurement(result)` projection. Every pass and interaction lane now renders
its interval and sorted exclusion inventory.

The initial pure Dogfood helper accidentally reread a trace while validating its audit. A direct
one-buffer guard exposed that integration defect: the intended bounded read count is two, but the
unmemoized helper made three reads. The final helper memoizes each manifest entry by
`kind/ref/sha256` before parsing; it therefore uses the same verified bytes for audit-chain and
trace validation without accepting a changed source.

| Guard / final current source SHA-256 | Exact disposable mutation and named command | WITH / WITHOUT / restore |
| --- | --- | --- |
| Byte-verified Bench C5 statistic and dossier closure; `src/cli/commands/stats.ts` `74f2f5b7a9cf74bcee70c7333ba3ecf9c0b5f911f8e7fad3aafaccf847af2ce9` | Bypassed the exact published-statistic comparison; `bun test tests/integration/policy-measurement-pipeline.test.ts -t 'rejects a self-consistent published Bench C5 statistic substitution'` | WITH is in the final 8-guard pipeline GREEN below; WITHOUT was **0 pass / 1 fail / 38 filtered / 3 expects**, because the marker-rebound value was accepted. The mutation-time source SHA was restored exactly before later mechanical Biome formatting. |
| Byte-verified Rig C5 statistic closure; same current `stats.ts` SHA | Replaced the exact Rig statistic comparison with a truthy bypass; `bun test tests/integration/policy-measurement-pipeline.test.ts -t 'rejects a self-consistent published Rig C5 statistic substitution'` | WITHOUT **0/1/38/3**; exact mutation-time bytes restored, then only Biome formatting produced the current SHA. |
| Holm adjustment closure; same current `stats.ts` SHA | Omitted `adjusted_p_value` from `samePublishedC5Statistics`; `bun test tests/integration/policy-measurement-pipeline.test.ts -t 'rejects a marker-rebound Holm adjustment detached from verified Bench effects'` | WITHOUT **0/1/38/4**; exact mutation-time bytes restored. |
| Dogfood snapshot/declined copied-source closure; same current `stats.ts` SHA and `src/stats/policy/dogfood-snapshot.ts` `43cafeb586f0481761d753152c55cb3f3d11ad8614ee1dcacd3627f271f54837` | Bypassed the final Dogfood source comparison; `bun test tests/integration/policy-measurement-pipeline.test.ts -t 'rejects a self-consistent published Dogfood declined substitution'` | WITHOUT **0/1/38/3**; the false declined snapshot was accepted. Exact mutation-time bytes restored. |
| Marker-bound Markdown projection; same current `stats.ts` SHA | Changed the report-equality failure branch to return success; `bun test tests/integration/policy-measurement-pipeline.test.ts -t 'rejects a marker-rebound Markdown drift from the verified JSON projection'` | WITHOUT **0/1/38/3**; exact mutation-time bytes restored. |
| Interval and exclusions Markdown parity; `src/stats/policy/render.ts` `e6433cb120262316c74141349fb53bb322338283f2359f7d650ece80fd817441` | Removed the interval, then replaced nonempty exclusions with `none`; `bun test tests/integration/policy-measurement-pipeline.test.ts -t 'reports every applicable Bench Rig and Dogfood lane without promoting secondary authority'` | WITHOUT **0/1/38/545** and **0/1/38/551** respectively; renderer bytes restored exactly. |
| Signed Dogfood `declined` derivation; `src/stats/policy/dogfood.ts` `7166d8d8ccece66e95c2ec247c52ed033738f18cb2c73a6f2463efa93fbf3b52` | Deleted the two `declined` increments; `bun test tests/unit/policy-dogfood.test.ts -t 'derives a declined snapshot from only the caller-owned frozen byte inventory'` | WITHOUT **0/1/21/2**; mutation-time bytes restored before later mechanical formatting. |
| One frozen Buffer per Dogfood manifest entry; `src/stats/policy/dogfood-snapshot.ts` `43cafeb586f0481761d753152c55cb3f3d11ad8614ee1dcacd3627f271f54837` | Removed the memoized-entry early return; `bun test tests/unit/policy-dogfood.test.ts -t 'uses one bounded read buffer and rejects a same-inode source grow'` | WITH **1/0/21/1**; WITHOUT **0/1/21/1**, expected two reads but received three. The sole copy `/private/tmp/reviewgate-c1-r3-mut-soo5X1/repo` was restored to this exact SHA. |

Current-source GREEN commands:

```bash
bun test tests/unit/policy-measurement-schema.test.ts tests/unit/policy-classify.test.ts \
  tests/unit/policy-dogfood.test.ts tests/unit/policy-render.test.ts tests/unit/stats-command.test.ts
# 93 pass / 0 fail / 270 expects

bun test tests/integration/policy-measurement-pipeline.test.ts -t \
  'reports every applicable Bench Rig and Dogfood lane without promoting secondary authority|publishes all 30 paired case effects and their complete statistical Markdown dossier|publishes finite precision and recall deltas from non-zero paired case denominators|rejects a marker-rebound Markdown drift from the verified JSON projection|rejects a self-consistent published Bench C5 statistic substitution|rejects a marker-rebound Holm adjustment detached from verified Bench effects|rejects a self-consistent published Rig C5 statistic substitution|rejects a self-consistent published Dogfood declined substitution'
# 8 pass / 0 fail / 31 filtered / 687 expects

bun test tests/integration/policy-measurement-publication.test.ts
# 6 pass / 0 fail / 30 expects
```

The C1--C4 proportional sample is **6 pass / 0 fail / 20 expects** and the current Rig-anchor
guard is **1 pass / 0 fail / 29 filtered / 4 expects**. Fresh `bunx tsc --noEmit` exited 0; fresh
`bun run lint` checked **696 files** with no fixes. The known C4 eight-file composite timing
limitation remains disclosed above and was not rerun or retuned. This checkpoint is
**review-pending**, unstaged, and uncommitted; no full suite, build, provider, Gate, real Rig,
measurement, credit use, push, or merge occurred.
