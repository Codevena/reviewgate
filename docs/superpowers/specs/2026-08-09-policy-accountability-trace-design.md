# Policy Accountability & Pruning — Slice 1: Policy Trace & Replay

_Written 2026-08-09. Status: design approved in dialogue; written spec awaiting Markus review._

## Context

Reviewgate's review policy grew from real incidents rather than speculative feature work. That
history justifies the existence of tests, the cassette, the benchmark and the rig, but it also left
outcome-changing policy distributed across pre-aggregation helpers, `src/core/orchestrator.ts` and
`src/core/aggregator.ts`.

The current checkout has 204 TypeScript source files and 44,880 source lines. Two files —
`src/core/orchestrator.ts` (3,259 lines) and `src/core/loop-driver.ts` (3,003 lines) — hold 13.95% of
the source. The larger problem is not their line count by itself: a final finding can be affected by
fact validation, grounding, critic judgement, three scopes, several history layers, confidence,
reputation and category-specific severity calibration. The precedence and protection rules are
encoded in execution order plus comments such as “G0 mirror”, “hard suppressor” and “runs after
reputation”.

Existing observability is partial:

- `src/rig/ablate.ts` names only critic, reputation, FP-ledger and lore. Lore is not a demoter, and
  the rig explicitly treats several unmodelled structural demoters as unknowable interactions.
- `bench matrix` exposes critic, confidence, reputation and scope-to-diff. Fresh per-case state
  deliberately makes the learning layers inert.
- `Finding` has individual marker fields, so a material effect is often visible, but it does not
  provide a complete ordered causal path, opportunity denominator or record of a demotion that a
  protection rule prevented.
- Post-aggregation artifacts cannot always reconstruct the counterfactual. FP-ledger, for example,
  overwrites severity with INFO without persisting the pre-suppression value.

This is policy sedimentation, not generic “too many tests” overengineering. The remedy is to make
every outcome-changing pass accountable, measure it with the correct denominator, prune it when the
evidence warrants that, and only then extract the surviving policy from the large modules.

## Program boundary

This spec is Slice 1 of a three-slice program:

1. **Policy Trace & Replay** — behavior-neutral instrumentation and exact internal ablation.
2. **Policy Measurement & Pruning** — opportunity-conditioned measurement, followed by deletion or
   consolidation of harmful or redundant policy. Behavior may change in Slice 2.
3. **Survivor Consolidation** — extract only the retained passes and remove obsolete config,
   schemas, markers, tests and documentation.

Two already-open reliability fixes precede this program and are not re-planned here:

- the rig stale-report ownership fix in
  `docs/superpowers/specs/2026-08-07-rig-stale-report-design.md`;
- project-scoped behavior for the currently user-scoped Stop hook, so unrelated directories cannot
  be blocked by a missing project policy baseline.

Slice 1 may refactor the mechanical path by which a policy transition is recorded and ablated, but
it must not change any production finding, marker, count, order or verdict.

## Goals

1. Give every outcome-changing pass a stable identity, class, execution position, opportunity
   definition and protection relationship.
2. Explain every material severity change, drop, re-anchor or prevented demotion with a compact,
   machine-readable ordered trace.
3. Distinguish `not-run`, `no-opportunity`, `would-apply`, `protected` and `applied` rather than
   collapsing all non-activations to zero.
4. Run paired ablations through the same production policy path over byte-identical raw reviewer
   responses.
5. Make missing, corrupt or incomplete traces invalidate authoritative Bench/Rig measurements,
   without ever changing a production gate verdict.
6. Produce the inputs Slice 2 needs to delete policy safely.

## Non-goals

- No policy deletion, threshold change or new demotion in Slice 1.
- No new reviewer, provider, learning store, dashboard or public policy feature.
- No public config switches for fact-check, redaction or any other currently always-on pass.
- No general plugin/rule engine and no data-driven dynamic policy loading.
- No semantic unification of FP-ledger, reputation, region memory, Agent Lessons, Brain and Lore.
  Their storage mechanics may be candidates for later consolidation, but they have different
  subjects, trust authorities, lifetimes and consumers.
- No complete extraction of the policy pipeline from Orchestrator/Aggregator before pruning.
- No claim that the current 30-case benchmark alone can validate rare or stateful policy.

## Terminology

- **considered** — the finding reached the pass while the pass was configured to run.
- **opportunity** — required inputs and starting state were present, and the pass could have changed
  this finding if its positive predicate matched.
- **would apply** — the positive predicate matched before protection and before an internal
  ablation suppressed the mutation.
- **protected** — the positive predicate matched, but a named guard intentionally prevented the
  mutation.
- **applied** — the pass changed severity, dropped the finding, suppressed it, capped it or
  re-anchored it.
- **not run** — the production configuration or stage precondition kept the whole pass inactive.
- **policy effect** — one material `applied` or `protected` event attached to a finding.
- **policy trace** — the full per-run artifact containing per-finding evaluations and aggregate
  counters, including findings later dropped by policy.

An opportunity is pass-specific and must be stated in the catalog. It is never inferred from an
activation after the fact. A zero activation count without the opportunity count is not evidence.

## Policy catalog

`src/core/policy/catalog.ts` becomes the single catalog of stable IDs and metadata. It does not load
or execute dynamic code. Each entry has:

- `id`;
- `order` (strictly increasing in production execution order);
- `class` (`evidence`, `value-judgment`, `scope`, `history`);
- possible `actions`;
- closed reason codes;
- opportunity definition;
- `depends_on` and `overlaps_with` relationships;
- whether the pass is internally ablatable;
- the Slice-2 metric appropriate to that pass.

### Initial outcome-changing inventory

| Order | Pass ID | Class | Current implementation | Possible effect |
|---:|---|---|---|---|
| 10 | `evidence.fact-location` | evidence | `src/core/fact-check.ts` | INFO demote or re-anchor |
| 20 | `evidence.self-refutation` | evidence | `src/core/self-refutation.ts` | INFO demote |
| 30 | `judgment.hypothetical` | value-judgment | `src/core/hypothetical-demote.ts` | CRITICAL → WARN |
| 40 | `evidence.grounding-token` | evidence | `src/core/grounding.ts` | CRITICAL → WARN |
| 50 | `judgment.grounding-llm` | value-judgment | `src/core/grounding.ts` | CRITICAL → WARN |
| 60 | `evidence.redaction-placeholder` | evidence | `src/core/aggregator.ts` | INFO demote |
| 70 | `judgment.critic` | value-judgment | `src/core/aggregator.ts` | one-step demote or INFO drop |
| 80 | `scope.diff` | scope | `src/core/aggregator.ts` | INFO demote |
| 90 | `scope.delta` | scope | `src/core/aggregator.ts` | INFO demote |
| 100 | `scope.session` | scope | `src/core/aggregator.ts` | INFO demote |
| 110 | `history.fp-signature` | history | `src/core/aggregator.ts` | INFO suppression |
| 120 | `history.cycle-rejected` | history | `src/core/aggregator.ts` | INFO suppression |
| 130 | `history.fp-cluster` | history | `src/core/aggregator.ts` | INFO suppression |
| 140 | `judgment.confidence` | value-judgment | `src/core/aggregator.ts` | INFO demote or CRITICAL → WARN clamp |
| 150 | `judgment.reputation` | value-judgment | `src/core/aggregator.ts` | one-step/INFO demote or CRITICAL → WARN clamp |
| 160 | `history.region-rejected` | history | `src/core/aggregator.ts` | INFO suppression |
| 170 | `judgment.test-security` | value-judgment | `src/core/aggregator.ts` | INFO demote |
| 180 | `judgment.docs-cap` | value-judgment | `src/core/aggregator.ts` | CRITICAL → WARN |

The catalog also records two non-ablatable explanatory stages:

- `aggregation.cluster` — raw-finding lineage, representative selection, maximum severity and
  consensus;
- `verdict.compute` — final counts and the rule that produced PASS/SOFT-PASS/FAIL.

They are core aggregation semantics rather than experimental suppressors.

### Protection rules

Protection rules do not become standalone demoters. A matched pass records `action: protected` plus
a closed `protected_by` reason. Initial protection reasons include:

- `claimed-fixed-pin`;
- `security-correctness-floor`;
- `corroborated-majority`;
- `corroborated-unanimous`;
- `high-precision-reviewer`;
- `out-of-diff-blocking-hatch`;
- `critical-floor`;
- `single-reviewer-critical-floor`.

Example: if the critic returns `likely_fp` but majority consensus protects the finding, the trace
says that `judgment.critic` would have applied and was protected by `corroborated-majority`. It does
not invent a separate “corroboration pass”.

Lore is excluded from this inventory because it does not demote. Lore's added INFO/decision load
remains a separate metric.

## Trace data model

A new `src/schemas/policy-trace.ts` owns the persisted trace contract.

### Full evaluation versus material effect

The full trace stores one terminal evaluation result for every finding that reaches a configured
pass:

```ts
interface PolicyEvaluation {
  pass_id: PolicyPassId;
  order: number;
  result: "no-opportunity" | "no-match" | "would-apply" | "protected" | "applied";
  before: Severity;
  after: Severity | null; // null only when an applied pass drops the finding
  reason_code: string; // validated against the pass catalog
  protected_by?: string;
  source_signatures: string[];
}
```

This makes the opportunity denominator auditable per case/finding rather than leaving only an
aggregate count. A configured pass that did not run has no per-finding evaluations and carries
`status: not-run` in its summary instead.

Visible findings do not carry this full matrix. They receive only the material subset:

Conceptual shape:

```ts
interface PolicyEffect {
  pass_id: PolicyPassId;
  order: number;
  action: "demoted" | "capped" | "dropped" | "protected" | "suppressed" | "reanchored";
  before: Severity;
  after: Severity | null; // null only for drop
  reason_code: string; // validated against the pass catalog
  protected_by?: string;
  source_signatures: string[];
}
```

Constraints:

- no free-form model text;
- no message, details, diff hunk, source line or source file content;
- `source_signatures` are sorted and deduplicated;
- `order` must match the catalog entry;
- `after` must match the action contract;
- duplicate idempotent effects collapse deterministically;
- effects remain in ascending catalog order.

`FindingSchema` gains optional `policy_effects`. Existing marker fields remain in Slice 1 because
they are consumed throughout the existing renderer, loop and rig. Slice 2/3 decides which marker
fields can be deleted after policy pruning.

### Run-level counters

Each configured pass emits one compact row:

```ts
interface PolicyPassSummary {
  pass_id: PolicyPassId;
  status: "ran" | "not-run" | "error";
  considered: number;
  opportunities: number;
  would_apply: number;
  applied: number;
  protected: number;
  blocking_removed: number;
  blocking_preserved: number;
  dropped: number;
}
```

All numeric fields are required when `status: ran`. Missing data is not defaulted to zero. The
summary schema rejects impossible relationships such as `applied > would_apply` or
`protected > would_apply`.

### Full policy trace artifact

Conceptual shape:

```ts
interface PolicyTrace {
  schema: "reviewgate.policy-trace.v1";
  catalog_version: "reviewgate.policy-catalog.v1";
  run_id: string;
  iter: number;
  ablated: PolicyPassId[];
  raw_response_sha256: string[];
  passes: PolicyPassSummary[];
  evaluations: Array<PolicyEvaluation & { final_signature?: string }>;
  final: {
    verdict: "PASS" | "SOFT-PASS" | "FAIL" | "ERROR";
    counts: { critical: number; warn: number; info: number };
    finding_signatures: string[];
  };
}
```

The full artifact includes evaluations for findings later dropped by a pass and `would-apply`
observations from an ablated pass. A visible final finding contains only its own applied/protected
material effects.

## Recorder and transition boundary

`src/core/policy/trace.ts` provides an in-memory recorder and a shared transition helper. The
recorder is deterministic and performs no filesystem I/O while policy is running.

Every one of the 18 passes routes material mutation through this helper. The helper receives:

- pass ID;
- original finding or cluster lineage;
- opportunity/match facts;
- optional protection reason;
- proposed mutation;
- the internal ablation set.

Behavior:

1. Count `considered` and `opportunities` from explicit booleans supplied by the pass.
2. When the positive predicate does not match, return the original finding.
3. When a guard protects the finding, record `would_apply + protected`, return the original.
4. When the pass is internally ablated, record `would_apply` with no applied mutation and return the
   original.
5. Otherwise apply the existing mutation exactly, record the material effect, and return the
   result (or `null` for a drop).

Pure severity-calculation helpers such as `demoteOneStep` may remain, but a production pass must not
assign a demoted/capped/suppressed severity or drop a finding outside the transition boundary.

### Clustering and lineage

Pre-cluster effects travel with their raw finding. When aggregation clusters findings:

- the representative retains its own effects;
- member effects are copied to the final cluster with their source signatures;
- identical idempotent effects are deduplicated;
- `aggregation.cluster` records every contributing signature and the representative;
- `demoted_from_critical` and `anchor_repaired` keep their existing OR-propagation behavior.

The trace is explanatory only. Final severity and verdict remain canonical in the existing Finding
and PendingReport data.

## Internal ablation contract

Orchestrator/Aggregator receive an internal `policyAblations: ReadonlySet<PolicyPassId>`. The normal
gate never supplies it. It is not part of `reviewgate.config.ts`, the config schema, environment
variables or a public gate CLI flag.

Only Bench/Rig replay code may supply the set. Tests enforce that normal gate/setup/config commands
cannot construct it.

For an ablated pass:

- configuration and stage preconditions remain unchanged;
- the pass evaluates opportunities and its positive predicate;
- `would_apply` remains observable;
- the mutation and material marker do not apply;
- every later pass runs normally on the counterfactual finding;
- reviewer inputs, provider calls, state reads and raw responses remain unchanged.

This is a production-path ablation, not a second hand-built model of pass precedence.

### Pairing and interactions

An ablation result is attributable only when baseline and counterfactual carry identical ordered raw
response hashes. Any mismatch invalidates the pair.

Slice 1 enables one-pass ablation and records `depends_on`/`overlaps_with`; it does not claim
leave-one-out captures all interactions. Slice 2 must additionally evaluate co-activating groups,
especially:

- critic × confidence × reputation;
- diff scope × delta scope × session scope;
- cycle rejection × region rejection × FP signature/cluster;
- fact location × token grounding × LLM grounding × redaction × self-refutation.

## Persistence and compatibility

### Pending report

`PendingReportSchema` gains an optional compact `policy_summary`. Visible findings gain optional
`policy_effects`. The existing `reviewgate.pending.v1` literal remains valid because the additions
are optional and old reports remain parseable.

### Audit artifact

One trace file is written atomically per reviewed iteration inside the existing audit day
partition:

```text
.reviewgate/audit/YYYY/MM/DD/policy/<run-sha12>-i<iter>-<content-sha12>.json
```

`run-sha12` is derived from `sha256(run_id)`; untrusted run IDs never become path components. The
canonical JSON bytes determine the content SHA-256 and filename. Canonicalization uses the same
implementation as the audit hash chain, extracted as a shared helper rather than reimplemented.
`run.complete` gains optional
`policy_trace_ref` and `policy_trace_sha256`; `RunSummary` gains an optional `policy_trace_status`
with the closed values `complete | not-run | error | overflow`. Reference and hash are required
only for `complete` and forbidden for every other status.
The audit hash chain therefore binds the reference and content hash without embedding the full
trace in every JSONL event.

The existing day-partition retention deletes policy artifacts with the corresponding audit day.
The verifier validates referenced artifacts when the optional fields are present; legacy chains
without them remain valid.

### Rendering

For newly traced findings, only already-existing badge variants are derived from `policy_effects`;
Slice 1 adds no new badge text. Legacy marker fields remain the fallback for old artifacts. The
rendered `pending.md` must remain byte-identical for the same findings. Slice 1 adds no second
block of verbose policy prose to the report.

The machine-readable path is available in `pending.json`; the compact badges remain the normal
agent/human explanation. A new top-level CLI subcommand is explicitly out of scope.

### Cache and structured reviewer output

- Trace fields do not participate in production review-cache keys.
- The strict `REVIEW_OUTPUT_SCHEMA` is unchanged. Policy effects are server-authored and are never
  accepted from a reviewer model.
- Bench already disables review caching. Rig replay must bind ablations and the catalog version in
  its own replay identity so two policy profiles cannot share a derived result accidentally.

## Failure behavior

### Production gate

Trace telemetry must never decide whether code passes:

- recorder errors preserve the existing finding and continue the gate;
- artifact write errors leave ref/hash absent and set trace status `error`;
- an artifact over the size limit sets `overflow` and is not silently truncated;
- pending/report writing continues with the canonical existing finding data;
- no trace failure changes a verdict, dirty flag, iteration or decision requirement.

The initial artifact limit is 1 MiB per iteration. The plan must verify the limit against a
worst-case synthetic run before fixing it permanently; changing the value changes storage only,
not policy.

### Authoritative Bench/Rig

An authoritative measurement is invalid when:

- a configured pass row is missing;
- required counters are absent or inconsistent;
- trace status is not `complete`;
- referenced content is missing, over limit or fails SHA-256 validation;
- baseline/counterfactual raw response hashes differ;
- the catalog version differs between paired runs.

The command exits 4 and states the exact cause. It must never interpret missing counters as zero.

## Work packages

1. **Catalog and schemas** — pass metadata, effect/summary/artifact schemas and semantic validation.
2. **Recorder and transition helper** — in-memory totals, material effects, protection and ablation.
3. **Pre-aggregation instrumentation** — fact location, self-refutation, hypothetical and both
   grounding layers.
4. **Aggregator instrumentation** — redaction, critic, three scopes, FP/cycle/cluster, confidence,
   reputation, region, test security and docs cap.
5. **Lineage and rendering** — cluster effect propagation plus byte-identical badge fallback.
6. **Persistence and audit binding** — atomic content-addressed artifact, run-complete ref/hash and
   verifier support.
7. **Internal ablation plumbing** — inaccessible from normal gate/config paths.
8. **Bench/Rig validation** — trace completeness, hash pairing, invalid-result handling and summary
   output.
9. **Documentation and Slice-2 handoff** — exact pass inventory, catalog semantics and measurement
   limitations.

## Test design

### Required contract cases for each pass

Every one of the 18 passes has explicit numbers for:

1. no opportunity: `0 opportunities / 0 would_apply / 0 applied`;
2. one opportunity without predicate match: `1 / 0 / 0`;
3. activation: `1 / 1 / 1`;
4. internal ablation: `1 / 1 / 0` with unchanged finding behavior;
5. protection, when the pass has guards: `1 / 1 / 0 applied / 1 protected`;
6. blocking findings with and without the mechanism.

Example for `judgment.confidence`:

- uncorroborated low-confidence WARN, active: raw blocking `1` → final blocking `0`;
- same raw finding, ablated: raw blocking `1` → final blocking `1`;
- same raw finding from a proven high-precision reviewer: `would_apply 1`, `protected 1`, final
  blocking `1`.

The implementation plan must enumerate the corresponding numbers for all 18 passes before code is
written; a test whose active and ablated blocking result are both equal cannot guard that pass's
effect unless it is explicitly a protection/no-opportunity test.

### Behavior-neutral equivalence

Given identical raw reviews and state:

- trace recorder enabled versus disabled produces identical findings, order, legacy markers,
  counts and verdict after optional trace fields are removed;
- provider call counts and ordered raw response hashes are identical;
- report Markdown is byte-identical;
- no trace error changes the gate decision.

### Completeness and consistency

Tests prove:

- all 18 catalog entries emit exactly one run-summary row when configured;
- effect order is monotonic by catalog order;
- every material marker produced by a catalogued pass maps to a material effect;
- every material effect is valid for its catalogued pass/action/reason;
- cluster members do not lose effects;
- dropped findings remain in the full trace but not the final pending findings;
- missing data is invalid rather than coerced to zero.

### Failure and security cases

- atomic write failure → production verdict unchanged, status `error`;
- 1 MiB overflow → no partial artifact; production status `overflow`, authoritative result invalid;
- artifact byte tamper → verifier failure and Bench/Rig exit 4;
- path traversal in run ID cannot escape the fixed audit directory;
- reviewer-controlled messages/rule IDs cannot enter reason codes or artifact paths;
- legacy pending/audit artifacts parse and render as before;
- normal gate/config/setup cannot supply internal ablations.

### Mutation requirements

Each new contract is seen red in a copy. At minimum, mutations must prove tests catch:

- an unregistered pass;
- a pass that mutates without recording an effect;
- a missing opportunity increment;
- swapped effect order;
- an ablated pass that still mutates severity;
- a lost member effect during clustering;
- a missing raw response hash comparison;
- a tampered artifact hash;
- missing trace interpreted as zero activations;
- trace persistence failure leaking into verdict behavior.

## Verification and acceptance

Slice 1 is complete only when all of the following hold:

1. All 18 outcome-changing passes are catalogued and instrumented.
2. Both non-ablatable explanatory stages are present.
3. Trace-on versus trace-off is behavior-identical after optional telemetry fields are stripped.
4. Existing `pending.md` output is byte-identical for unchanged fixtures.
5. No public config/CLI path exposes internal ablation.
6. An offline replay produces a complete trace for each of the four pass classes without live
   provider calls.
7. Baseline/ablation pairs prove identical ordered raw response hashes.
8. Bench/Rig reject missing, corrupt, overflowed and cross-catalog traces as non-authoritative.
9. Every new guard test has been mutation-proven red in a copy.
10. `bunx tsc --noEmit`, `bun run lint` and the full `bun test` suite pass.
11. The compiled binary paths affected by persistence/CLI validation pass their focused smoke tests.
12. The repository's independent post-implementation review pipeline passes.

## Slice-2 handoff

Slice 1 does not rank or delete passes. It hands Slice 2:

- the versioned policy catalog;
- complete opportunity/activation/protection counts;
- paired raw response hashes and ablation outputs;
- a list of co-activating pass groups;
- explicit measurement limits for stateful and rare passes;
- evidence that production behavior did not move while the measurement layer was installed.

Slice 2 then evaluates stateless passes with paired 30-case × 3-repeat response replays, stateful
passes with seeded multi-turn state/Rig/Cassettes, and all passes against real dogfood dispositions.
Deletion requires sufficient opportunities plus either measured harm or no unique contribution
beyond a retained pass. Zero opportunities alone never justifies deletion.
