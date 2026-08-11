# Policy Accountability & Pruning — Slice 2: Measurement before deletion

**Status:** Approved design, ready for implementation planning

**Date:** 2026-08-11

**Depends on:** `reviewgate.policy-catalog.v1`, authoritative policy traces, exact Bench pairing,
exact Rig replay, and persisted audit trace verification from Slice 1

## Decision

Reviewgate will not prune policy passes from anecdotes, zero-opportunity runs, or aggregate
precision alone. Slice 2 first builds an authoritative, opportunity-conditioned evidence bundle for
all 18 ablatable policy passes. It uses the same captured provider responses for every stateless
counterfactual, isolated real state for stateful counterfactuals, and only explicitly dispositioned
dogfood findings.

Slice 2 is divided into two separately approved changes:

1. **Slice 2A — Measurement and candidate classification.** Add preregistration, capture,
   validation, aggregation, reporting, and dogfood attribution. Production policy behavior must not
   change.
2. **Slice 2B — Pruning.** Write a new, result-specific specification for only the passes classified
   as deletion or harm candidates. No deletion, default change, or pass consolidation is authorized
   by this document.

The intended outcome is not a predetermined smaller catalog. `retain` and `inconclusive` are valid
results. A pass survives whenever the evidence cannot safely justify removal.

## Problem

Slice 1 made each policy decision observable and replayable, but observability is not evidence of
value. Reviewgate still has 18 interacting passes, most of them demoters, and several were introduced
after individual field incidents. Looking at a final report cannot answer whether one pass:

- prevented a false positive that another pass would not have prevented;
- suppressed a true positive;
- merely duplicated a retained pass;
- mattered only after state accumulated across turns; or
- appeared useful because repeated model responses were treated as independent samples.

The failure mode to avoid is deleting a safety backstop because a small or correlated sample found
no statistically significant average effect. The opposite failure mode is preserving sediment
forever because every pass has a plausible story. This design makes both decisions evidence-bound.

## Goals

- Measure all 18 catalog passes against frozen ground truth and real explicit dispositions.
- Condition every conclusion on actual pass opportunities and trace status.
- Reuse identical logical provider responses for a baseline and all counterfactuals.
- Exercise stateful passes through real stores and persistent branch-local state across turns.
- Separate unique contribution from redundant contribution.
- Predeclare the interaction groups most likely to hide stacked over-suppression.
- Produce a machine-readable evidence bundle and a human-readable report from one validated input
  set.
- Fail closed on provenance, catalog, response, trace, state, preregistration, or artifact mismatch.
- Preserve the existing `reviewgate stats` behavior while adding policy-specific analysis.

## Non-goals

- Changing pass order, predicates, protections, defaults, severities, or verdict semantics.
- Deleting or disabling a pass in Slice 2A.
- Inventing labels for findings without explicit ground truth or human dispositions.
- Treating missing dogfood decisions as acceptance or rejection.
- Ranking reviewer providers or resuming the parked Qwen measurement stream.
- Spending provider credits before the preregistration and a separate cost approval are committed.
- Treating a non-significant result as proof that a pass is useless.

## Evidence model

### Units and terminology

- A **case** is one frozen Bench corpus case. It is the independent unit for stateless inference.
- A **repeat** is one independently captured provider-response set for every case. Repeats reduce
  model-response sensitivity but are not counted as independent cases.
- A **sequence** is one seeded multi-turn Rig scenario with its own initial state and its own
  baseline/counterfactual state branches. It is the independent unit for stateful evidence.
- A **run** in dogfood is one `(run_id, iter)` pair with a verified complete policy trace.
- A **finding identity** is its stable signature. Clustered findings additionally carry all member
  signatures through trace lineage.
- An **opportunity** is the catalog entry's declared opportunity, observed in a valid trace. A pass
  with `status: not-run` has no opportunity. `ran` alone is not an opportunity; the pass summary or
  evaluation must show a considered finding or a declared stage opportunity.
- **Baseline** means all catalog passes active in catalog order.
- **Ablated** means the named pass or preregistered pass group is disabled internally while every
  other input, response, configuration value, and initial state remains paired.

### Ground-truth loss

For each Bench case and repeat, calculate these identity-level counts after policy:

- `blocking_fp`: blocking findings not matched by the frozen case truth;
- `blocking_fn`: frozen expected findings that are no longer blocking;
- `blocking_tp`: frozen expected findings that remain blocking; and
- `ground_truth_error = blocking_fp + blocking_fn`.

The matching rule and expected identities come only from the committed corpus. They may not be
edited after provider responses are captured. Severity changes remain separate fields so a WARN to
INFO transition cannot disappear inside a verdict-only metric.

For baseline `B` and an ablated variant `A`, pass-oriented effects are:

- `fp_prevented = blocking_fp(A) - blocking_fp(B)`;
- `tp_preserved = blocking_tp(B) - blocking_tp(A)`;
- `fp_caused = blocking_fp(B) - blocking_fp(A)`;
- `tp_suppressed = blocking_tp(A) - blocking_tp(B)`; and
- primary paired effect `error_reduction = ground_truth_error(A) - ground_truth_error(B)`.

Positive `error_reduction` favors the active pass. Negative values indicate harm. The report also
shows precision, recall, blocking-count, severity, and verdict deltas; none replaces the primary
ground-truth outcome.

### Evidence pyramid

Evidence is collected in three lanes. A lane may veto deletion even when another lane has a positive
average result.

1. **Stateless Bench.** Thirty frozen cases, three independent response captures, one active
   baseline and all counterfactuals replayed from the exact same logical response sequence.
2. **Stateful Rig.** Seeded multi-turn sequences using real `FpLedgerStore`, `ReputationStore`,
   region/cycle state, and branch-local persistence. Baseline and counterfactual begin from the same
   verified snapshot and never share later writes.
3. **Dogfood.** Verified production traces joined only to explicit human decisions by run,
   iteration, and finding signatures. It is observational corroboration, not a substitute for
   invisible-finding ground truth.

## Policy inventory and primary lanes

The catalog remains the only pass inventory. The preregistration must contain these 18 IDs in this
exact order and must copy neither opportunity prose nor transition rules into a second mutable
registry.

| Order | Pass | Primary lane | Opportunity-conditioned measure |
|---:|---|---|---|
| 10 | `evidence.fact-location` | Bench | re-anchor yield, blocking and truth delta |
| 20 | `evidence.self-refutation` | Bench | blocking and disposition accuracy delta |
| 30 | `judgment.hypothetical` | Bench | severity and truth delta |
| 40 | `evidence.grounding-token` | Bench | severity and truth delta |
| 50 | `judgment.grounding-llm` | Bench | severity and truth delta |
| 60 | `evidence.redaction-placeholder` | Bench | blocking and truth delta |
| 70 | `judgment.critic` | Bench | precision and recall delta |
| 80 | `scope.diff` | Bench | blocking and truth delta |
| 90 | `scope.delta` | Bench | blocking and truth delta |
| 100 | `scope.session` | Bench | blocking and truth delta |
| 110 | `history.fp-signature` | Stateful Rig | state-conditioned precision and recall delta |
| 120 | `history.cycle-rejected` | Stateful Rig | state-conditioned precision and recall delta |
| 130 | `history.fp-cluster` | Stateful Rig | state-conditioned precision and recall delta |
| 140 | `judgment.confidence` | Bench | precision and recall delta |
| 150 | `judgment.reputation` | Stateful Rig | state-conditioned precision and recall delta |
| 160 | `history.region-rejected` | Stateful Rig | state-conditioned precision and recall delta |
| 170 | `judgment.test-security` | Bench | blocking and truth delta |
| 180 | `judgment.docs-cap` | Bench | severity and truth delta |

All passes are still summarized in all lanes where they have valid opportunities. A stateful pass
with no configured state in the stateless corpus receives zero descriptive opportunities there; that
does not count against it and cannot support deletion.

## Preregistered interaction groups

Single-pass ablation cannot detect every failure caused by stacked demoters. Slice 2A therefore runs
these four group ablations from the same baseline response captures:

1. `judgment.critic` + `judgment.confidence` + `judgment.reputation`
2. `scope.diff` + `scope.delta` + `scope.session`
3. `history.cycle-rejected` + `history.region-rejected` + `history.fp-signature` +
   `history.fp-cluster`
4. `evidence.fact-location` + `evidence.grounding-token` + `judgment.grounding-llm` +
   `evidence.redaction-placeholder` + `evidence.self-refutation`

Group results are not allocated back to individual passes by assumption. They reveal synergy,
redundancy, or aggregate over-suppression and can veto an individual deletion classification.

## Preregistration

The new strict schema is `reviewgate.policy-measurement.preregistration.v1`. Its canonical JSON is
committed under `bench/preregistrations/` before any provider call or outcome analysis. It binds:

- a source rule requiring a clean HEAD that contains the exact preregistration bytes; the resolved
  HEAD SHA is captured in the result, avoiding an impossible self-referential commit hash;
- Reviewgate version, policy catalog version, and exact ordered pass inventory;
- the 30-case corpus path, per-case content hashes, truth manifest, and 16 clean/14 seeded split;
- exactly three repeats and the no-substitution provider roster, models, personas, retry ceilings,
  output ceilings, and provider-call ceiling;
- 18 singleton ablation sets and the four interaction sets above;
- state scenario refs and hashes, initial-state refs and hashes, turn order, and expected opportunity
  carriers;
- a dogfood window `[since, registered_at)` and the audit roots allowed as inputs;
- the sufficient-evidence thresholds, candidate rules, vetoes, primary estimand, interval method,
  correction families, and deterministic analysis seed;
- immutable output paths, no-overwrite behavior, and failed-attempt retention; and
- the exact capture, replay, aggregation, and report commands.

The concrete provider roster is an attempt-level input, not a hidden design default. It requires a
separate cost approval. Qwen is not part of this slice unless a later preregistration explicitly names
it and its credit spend is approved.

Any command, source, catalog, corpus, roster, threshold, state scenario, audit window, or output path
that differs from the committed preregistration fails before live provider calls or analysis.

## Stateless Bench execution

`reviewgate bench policy` is the Slice 2A capture command. It reads the committed preregistration
rather than accepting an ad hoc pass list. For each of the three repeats it:

1. runs the 30 cases once with all passes active and captures every preflight, review, grounding, and
   critic response in logical call order;
2. persists and verifies the response manifest and all baseline policy traces;
3. replays 18 singleton counterfactuals and four interaction counterfactuals without any provider
   capability; and
4. verifies exact request identity, response hashes, effective configuration, catalog inventory,
   trace completeness, and full consumption for every case and variant.

The three response sets are independently captured. Within a repeat, all 23 executions — baseline,
18 singleton variants, and four group variants — use the same ordered response hashes. A variant
that makes a live preflight or completion call invalidates the entire attempt.

The command extends the existing Bench artifact conventions rather than weakening
`reviewgate.bench.matrix.v1`. Existing `bench matrix` behavior and old artifacts remain compatible.

## Stateful Rig execution

Stateful evidence uses exact policy replay and real production store APIs. Each of the five primary
stateful passes has at least three independent committed sequences, and each sequence has at least
two opportunity-bearing turns after its seed state is established.

The sequence families are:

- `history.fp-signature`: an explicitly rejected signature recurs, with a nonmatching control;
- `history.cycle-rejected`: a rejected signature reappears across the cycle boundary, with an
  accepted control;
- `history.fp-cluster`: the required distinct rejection evidence activates a cluster, with
  insufficient-distinct and category-change controls;
- `judgment.reputation`: real decision events make a reviewer unreliable before a later finding,
  with a reliable-reviewer control; and
- `history.region-rejected`: a later finding overlaps a rejected region, with nonoverlap and changed
  category/severity controls.

Every sequence records immutable pre-policy findings, exact iteration diffs, ordered response call
identities, policy traces, and state snapshots. Baseline and counterfactual start at the same digest.
Subsequent turns import only exogenous snapshot changes; branch-owned present and absent paths remain
branch-local. Tests may not simulate state divergence through callbacks or shadow learning models.

The history interaction group is also replayed across the applicable stateful sequences. Its
stateless Bench row remains part of the closed 23-execution inventory, but zero state there is only a
descriptive no-op and cannot support an interaction conclusion.

The measurement consumes only Rig results with `policyReplay.authoritative: true`, the current
catalog, exact result/manifest/script/source/state/cassette bindings, and complete turn/trace
inventory.

## Dogfood attribution

Dogfood is usable only where a human explicitly dispositioned a surfaced finding. Slice 2A adds a
backward-compatible producer change: each new `decision.applied` audit event carries the existing
outer `finding_signatures` field populated with the sorted, deduplicated representative and cluster
member signatures of that finding. `decision_outcome` remains unchanged.

The harvester:

1. verifies the audit chain and the referenced complete policy trace;
2. joins `decision.applied` to `run.complete` by exact `(run_id, iter)`;
3. joins the decision to final and lineage identities through `finding_signatures`;
4. attributes only catalog-valid pass evaluations and effects that name those signatures; and
5. records `tp` and `fp` as labels while reporting `declined` separately.

Historical decision events without `finding_signatures`, runs without a complete trace, decisions
that cannot be joined uniquely, and signatures absent from trace lineage are excluded with explicit
reason counts. They are never repaired heuristically.

Dogfood cannot observe findings removed before a human could see them. Therefore:

- missing decisions are not labels;
- the absence of a complaint is not a true negative;
- dogfood alone cannot prove recall safety or justify deletion; and
- one verified dogfood case where the active pass uniquely preserved a true positive may veto
  deletion, while a case where it demoted a true positive is harm evidence; invisible-finding recall
  still comes from Bench or seeded Rig truth.

The dogfood window ends at the preregistration's `registered_at`, preventing post-result window
selection. The canonical harvested subset includes source audit file hashes and is written into the
immutable evidence bundle.

## Sufficiency and classification

### Sufficient evidence

A stateless pass has sufficient primary evidence only when all conditions hold:

- at least eight distinct Bench cases contain an opportunity;
- those cases contain at least 15 distinct opportunity-bearing finding signatures;
- all three response repeats are authoritative;
- the direction of the case-level primary effect agrees in at least two repeats; and
- the remaining repeat does not show the opposite direction.

For the direction rule, each repeat is `positive`, `negative`, or `zero` from its mean paired primary
effect. Two equal nonzero signs plus zero are stable; any positive/negative conflict is not. Three
zeros are a stable-zero result. One nonzero sign plus two zeros remains inconclusive.

A stateful pass has sufficient primary evidence only when at least three independent seeded
sequences are authoritative and each has at least two opportunity-bearing turns.

Dogfood is sufficient corroboration only with at least five explicit `tp` or `fp` dispositions from
at least three distinct runs. It is never sufficient on its own for deletion. One validated
counterexample is sufficient to apply a safety veto even when the broader dogfood threshold is not
met.

### Unique contribution

A contribution is unique only when a paired, ground-truth event disappears or worsens after the pass
is ablated and no retained overlapping pass produces the same protection in the preregistered group
comparison. Qualifying events are:

- one additional blocking false positive prevented by the pass;
- one blocking true positive preserved by a catalog protection/backstop; or
- one required safety backstop whose removal creates a ground-truth error.

Prose rationale, activation count, duplicate demotion, and zero observed harm are not unique
contributions.

### Deterministic classifications

Classification precedence is safety-first:

1. **`retain`** — at least one validated unique contribution exists, or a safety-retention veto
   fires. A safety-retention veto is evidence that the active pass uniquely prevented a false
   positive, preserved a true positive, or enforced a required backstop; evidence that the active
   pass suppressed a true positive is harm, not a retention veto.
2. **`harmful-candidate`** — the active pass worsens ground truth in at least two distinct cases or
   sequences, or in one ground-truth case/sequence plus one confirmed dogfood true-positive
   disposition, with no retain veto.
3. **`delete-candidate`** — primary evidence is sufficient; no unique contribution exists; every
   observed beneficial effect is reproduced by at least one retained overlapping pass; no
   preregistered group shows harmful interaction from removal; and no safety veto fires.
4. **`inconclusive`** — every other result, including too few opportunities, contradictory repeats,
   incomplete lanes, and merely nonsignificant effects.

Candidate labels are evidence summaries, not code-change authorization. Slice 2B must inspect the
concrete cases behind each candidate and receive a new design approval.

Classification runs in two deterministic phases: first identify `retain` passes from direct unique
events and safety vetoes, then evaluate harm and deletion candidates against that fixed retained set.
Coverage by an `inconclusive` pass is not enough to delete another pass. A retained pass may still
carry `harm_observed: true`; the single label does not hide the underlying case dossier.

## Statistical analysis

The case, not the repeat or finding, is the independent stateless unit. For each pass:

- average each case's paired effect over its three repeats;
- report the mean and median paired `error_reduction`, FP and FN components, precision/recall deltas,
  opportunity counts, and all raw case-level effects;
- calculate a deterministic 95% percentile bootstrap interval over cases with 10,000 resamples and
  the preregistered analysis seed; and
- calculate a two-sided exact sign-test p-value over nonzero case-level primary effects.

Holm correction is applied across the 18 singleton primary p-values. The four interaction-group
p-values form a separate Holm family. Raw and adjusted p-values are both reported. No correction is
applied to descriptive secondary metrics, which are labeled descriptive.

Stateful and dogfood lanes report sequence/run-level raw effects and intervals where defined; their
small samples are not pooled with Bench cases. Statistical significance is never a prerequisite for
a safety veto and never turns absent opportunity into evidence.

## Artifacts and authority

The evidence bundle schema is `reviewgate.policy-measurement.v1`. A successful attempt lives under
`bench/results/policy-measurement/<attempt>/` and contains content-addressed, canonical, mode-0600
artifacts for:

- the committed preregistration and source identity;
- three response manifests;
- baseline, singleton, and group Bench results and policy trace sets;
- authoritative Rig results, replay manifests, cassettes, traces, and state snapshots;
- the canonical dogfood subset and its source audit hashes;
- a closed input manifest binding every ref and SHA-256;
- the machine-readable evidence result; and
- the rendered Markdown report.

Writers use create-if-absent semantics and contained no-follow paths. Readers require a regular
single-link file with exact mode `0600`, bounded bytes, canonical UTF-8 JSON, schema validity,
content-addressed path/hash agreement, and stable inode/size/time across the read. Existing shared
artifact helpers are reused rather than adding a weaker storage path.

Before any classification or report write, the analyzer validates:

- preregistration commit and bytes;
- exact catalog version and ordered inventory;
- corpus, truth, roster, command, response, result, trace-set, and state identities;
- baseline/counterfactual pairing and full logical response consumption;
- all Rig authority and state-isolation bindings;
- audit chains and dogfood trace joins; and
- complete expected variant and interaction inventory.

Any mismatch exits `4`, publishes no named result or Markdown report, and prints one typed reason.
Inputs and reports are built in a private staging directory; after complete validation, the final
bundle directory is published by one same-filesystem rename. Invalid attempt inputs are preserved
for diagnosis. Too few opportunities is not invalid: it produces a valid report whose affected
passes are `inconclusive`.

## Commands and compatibility

- `reviewgate bench policy --preregistration <path> --out <path>` performs one live baseline per
  repeat and all-offline-counterfactual stateless capture.
- Existing Rig capture/replay commands produce the preregistered stateful artifacts; Slice 2A adds
  orchestration only where needed to enforce the full scenario inventory.
- `reviewgate stats policy --preregistration <path> --bench <manifest> --rig <manifest>
  --out <attempt-dir>` validates all lanes, snapshots dogfood, classifies passes, and atomically
  publishes the result JSON plus Markdown report as one bundle directory.
- Existing `reviewgate stats [--since|--last|--json]` output and semantics remain unchanged.

CLI syntax errors exit `2`. Authority, provenance, catalog, trace, state, response, artifact, or
preregistration failures exit `4`. Provider/runtime failures retain the existing Bench/Rig failure
semantics and can never yield an authoritative measurement.

## Report contract

The JSON result contains, for each catalog pass:

- catalog ID, order, class, primary lane, overlaps, and opportunity definition hash;
- per-lane eligibility, authority, opportunity cases/signatures/turns/runs, and exclusion reasons;
- baseline and ablated ground-truth counts and paired effects;
- applied, would-apply, protected, and no-opportunity trace totals;
- raw case/sequence/run evidence refs;
- unique-contribution events and the overlapping pass that did or did not cover each one;
- group interaction effects;
- raw and adjusted statistics;
- every safety veto; and
- one of the four classifications with machine-readable reason codes.

The Markdown report renders the same data. It begins with artifact authority and coverage, then a
compact 18-row classification table, interaction results, exclusions/limitations, and linked case
dossiers. It must not introduce conclusions absent from the JSON.

## Test and mutation strategy

Implementation follows test-first slices. No test uses a live provider. Required coverage includes:

- strict preregistration, result, and artifact schemas with legacy compatibility only where stated;
- exact 30 × 3 schedule, 18 singleton variants, four group variants, and zero variant live calls;
- response order/hash/config/catalog/full-consumption failures;
- case-level deduplication so three repeats cannot become 90 independent cases;
- exact opportunity and signature thresholds, repeat-direction rule, precedence, and all vetoes;
- overlapping-pass unique-contribution logic and group-interaction attribution;
- real multi-turn state persistence and baseline/counterfactual isolation for all five stateful
  families;
- decision signature emission, cluster lineage joins, missing-decision exclusion, and historical
  unsigned-event exclusion;
- canonical/no-follow/0600/content-addressed artifact boundaries and atomic no-partial-report
  behavior; and
- preservation of existing `stats`, Bench, Rig, trace, audit, and production-verdict behavior.

Mandatory mutation families remove or invert:

- case-level deduplication;
- opportunity/signature/sequence/run thresholds;
- the single-counterexample and interaction vetoes;
- classification precedence;
- Holm family separation;
- response or state pairing;
- result/preregistration/artifact bindings;
- dogfood signature/lineage joins; and
- the no-live-call ceiling.

Each mutant must be killed by a named test, restored byte-identically, and recorded in the task
report. Slice 2A completes only after focused suites, `bunx tsc --noEmit`, `bun run lint`, the full
`bun test`, build/binary smoke where CLI behavior changes, and independent contract plus
security/failure-mode review.

## Execution boundary

The implementation plan may decompose Slice 2A into schemas, dogfood attribution, stateless capture,
stateful scenarios, analysis, CLI/reporting, and final verification. It must preserve one invariant:
no production pass semantics change anywhere in those tasks.

After Slice 2A is implemented, the preregistration is committed and reviewed before any paid capture.
The measurement then runs exactly once per registered attempt. Failed attempts are immutable; a new
attempt requires a new preregistration. Only after an authoritative evidence report exists may a
separate Slice 2B design propose deletion or consolidation of specifically named passes.
