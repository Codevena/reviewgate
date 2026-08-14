# Policy Measurement & Pruning Slice 2A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an authoritative, opportunity-conditioned evidence pipeline that measures all 18 policy passes without changing production policy behavior.

**Architecture:** Keep Slice 1's catalog, trace, Bench pairing, Rig replay, and audit chain as the authority boundary. Add strict measurement schemas and pure `src/stats/policy/` analysis modules; Bench and Rig only gain additive truth/state evidence needed by those modules. Capture, replay, dogfood harvesting, classification, and rendering meet in one content-addressed bundle that publishes only after every input validates.

**Tech Stack:** Bun, TypeScript with `exactOptionalPropertyTypes`, Zod, Biome, `bun:test`, existing Reviewgate Bench/Rig/Audit infrastructure, Node filesystem primitives for no-follow artifact I/O.

This remains one integrated plan rather than four subsystem plans because no lane is a shippable
measurement by itself: the final authority manifest, correction families, classifications, and
report are valid only when Bench, Rig, dogfood, and the preregistration are closed together. Each
task below is nevertheless an independently reviewable commit with its own executable contract.

## Global Constraints

- The approved design is `docs/superpowers/specs/2026-08-11-policy-measurement-pruning-design.md`; it is the source of truth for every threshold and classification.
- Slice 2A must not change pass order, predicates, protections, defaults, severities, verdict semantics, or any production policy outcome.
- The closed inventory is exactly the 18 IDs in `POLICY_PASS_IDS`, in catalog order; Lore remains outside it.
- Stateless execution is exactly 30 frozen cases × 3 independently captured response sets × 23 profiles: one baseline, 18 singleton ablations, and four fixed group ablations.
- Within one repeat, every counterfactual reuses the baseline's exact preflight/review/grounding/critic logical responses and has no provider or subprocess capability.
- Stateful sufficiency is at least three independent sequences per stateful pass and at least two opportunity-bearing turns per sequence, using real branch-local stores.
- Dogfood uses only explicit `tp`/`fp` dispositions joined by `(run_id, iter)` and sorted representative/member signatures to a verified complete trace; missing or historical unsigned decisions are exclusions, never labels.
- Stateless sufficiency is at least eight opportunity cases, 15 distinct opportunity signatures, all three authoritative repeats, and the preregistered direction rule.
- Dogfood corroboration is at least five explicit dispositions from at least three distinct `(run_id, iter)` runs; one verified unique safety contribution may veto deletion.
- Statistics use case-level repeat collapse, a deterministic 10,000-resample percentile bootstrap, an exact two-sided sign test, Holm correction over 18 singleton primaries, and a separate Holm family for four interactions.
- Result labels are exactly `retain`, `delete-candidate`, `harmful-candidate`, and `inconclusive`; candidate labels never authorize deletion.
- Authority/provenance/catalog/response/trace/state/preregistration/artifact failures exit `4` and publish no named result/report. Too few opportunities produces a valid `inconclusive` result.
- Existing `reviewgate stats`, `bench matrix`, Rig, audit, cache, report bytes, and legacy schemas remain compatible.
- No live provider, real Rig, paid capture, or Qwen credit is used while implementing or testing this plan.
- Use `apply_patch`, explicit path staging, and one commit per task. Never use `git add -A`; preserve the main checkout's foreign `.reviewgate/lore/approvals.jsonl` change.
- Before each task commit, mark that task's completed checkboxes in this plan and stage this plan
  alongside the task-owned paths. The plan path is therefore explicitly authorized in every task
  commit and is the durable execution ledger.
- After every task commit, update the live task plan and append the commit, fresh verification,
  durable decision, open risk, and exact next task to the canonical Brain project note and current
  Daily Note. This checkpoint is mandatory before starting the next task so context compaction
  cannot erase the execution state.
- Before every commit: check `.reviewgate/gate.lock`, foreign processes, `git status`, staged paths, `git diff --cached --check`, focused GREEN, mutation restore SHA, and independent task review.
- Full `bun test` runs serially with complete output captured to a file. Run `bunx tsc --noEmit` and `bun run lint` before claiming completion. Schema changes require the full suite.
- Do not create a concrete paid preregistration in this plan. Provider roster, attempt paths, and credit ceiling require a later explicit cost approval.

---

## File and interface map

### Shared authority boundary

- `src/artifacts/canonical-json.ts` — generic canonical JSON create-if-absent writer and no-follow verifier.
- `src/cli/commands/bench.ts` — keeps public Bench commands; delegates non-trace JSON artifact I/O to the shared boundary.

### Contracts

- `src/core/policy/measurement-contract.ts` — fixed interaction groups, thresholds, lane assignments, and reason-code constants.
- `src/schemas/policy-measurement-preregistration.ts` — strict preregistration and input-manifest schemas.
- `src/schemas/policy-measurement.ts` — dogfood snapshot, lane evidence, classification, bundle, and result schemas.

### Evidence producers

- `src/bench/runner.ts` and `src/schemas/bench-result.ts` — additive per-finding truth identities.
- `src/cli/commands/bench.ts` — baseline capture plus 18 singleton/four group replay profiles.
- `src/core/decision-outcome.ts` and `src/core/loop-driver.ts` — sorted representative/member decision signatures.
- `src/audit/verifier.ts` — verified audit bytes reusable by the dogfood harvester.
- `src/rig/replay.ts` — multi-pass profiles and final-finding output for real stateful replay.

### Pure analysis

- `src/stats/policy/statistics.ts` — repeat collapse, bootstrap, sign test, Holm adjustment.
- `src/stats/policy/classify.ts` — two-phase safety-first classification.
- `src/stats/policy/dogfood.ts` — stable audit snapshot and trace attribution.
- `src/stats/policy/rig.ts` — stateful scenario validation and truth scoring.
- `src/stats/policy/assemble.ts` — closed input validation and evidence assembly.
- `src/stats/policy/render.ts` — Markdown rendering from parsed JSON only.

### CLI and docs

- `src/cli/commands/stats.ts` and `src/cli/index.ts` — `bench policy` and `stats policy`, preserving default `stats`.
- `docs/architecture.md`, `TEST_PLAN.md`, `NEXT_SESSION.md`, and `AGENTS.md` — final implementation and measurement handoff.

---

### Task 1: Extract the shared canonical JSON artifact boundary

**Files:**
- Create: `src/artifacts/canonical-json.ts`
- Modify: `src/cli/commands/bench.ts:1491-1751`
- Create: `tests/unit/canonical-json-artifact.test.ts`
- Modify: `tests/unit/bench-matrix.test.ts:370-620`

**Interfaces:**
- Consumes: `canonicalJson`, a strict Zod schema, an artifact root, a directory name, and a maximum byte count.
- Produces:
  - `writeCanonicalJsonArtifact<T>(input): CanonicalArtifactWriteResult`
  - `verifyCanonicalJsonArtifact<T>(input): CanonicalArtifactVerification<T>`
  - unchanged public `verifyBenchArtifactReference(...)` behavior through a Bench wrapper.

- [x] **Step 1: Write the failing generic artifact tests**

```ts
import { z } from "zod";
import {
  verifyCanonicalJsonArtifact,
  writeCanonicalJsonArtifact,
} from "../../src/artifacts/canonical-json.ts";

const ExampleSchema = z.object({ schema: z.literal("example.v1"), value: z.number() }).strict();

it("writes canonical mode-0600 content addressed JSON and verifies the same inode", () => {
  const stored = writeCanonicalJsonArtifact({
    root,
    directory: "examples",
    schema: ExampleSchema,
    value: { schema: "example.v1", value: 7 },
    maxBytes: 4096,
  });
  expect(stored.ok).toBe(true);
  if (!stored.ok) return;
  expect(stored.ref).toBe(`artifacts/examples/${stored.sha256}.json`);
  expect(lstatSync(join(root, stored.ref)).mode & 0o7777).toBe(0o600);
  expect(
    verifyCanonicalJsonArtifact({
      root,
      directory: "examples",
      schema: ExampleSchema,
      ref: stored.ref,
      sha256: stored.sha256,
      maxBytes: 4096,
    }),
  ).toEqual({ ok: true, value: { schema: "example.v1", value: 7 } });
});
```

Add named RED cases for a symlinked ancestor, final symlink, hardlink, `0644`, oversized bytes,
invalid UTF-8, noncanonical JSON, hash mismatch, path traversal, and a file swapped between
`lstat`/FD read/path recheck.

- [x] **Step 2: Run the RED tests**

Run: `bun test tests/unit/canonical-json-artifact.test.ts`

Expected: FAIL because `src/artifacts/canonical-json.ts` does not exist.

- [x] **Step 3: Implement the generic boundary**

```ts
export type CanonicalArtifactReason =
  | "invalid-reference"
  | "path-escape"
  | "missing"
  | "not-a-file"
  | "too-large"
  | "hash-mismatch"
  | "invalid-encoding"
  | "invalid-json"
  | "invalid-schema"
  | "non-canonical"
  | "identity-mismatch"
  | "read-error";

export type CanonicalArtifactVerification<T> =
  | { ok: true; value: T }
  | { ok: false; reason: CanonicalArtifactReason };

export type CanonicalArtifactWriteResult =
  | { ok: true; ref: string; sha256: string }
  | { ok: false; reason: CanonicalArtifactReason };

export function verifyCanonicalJsonArtifact<T>(input: {
  root: string;
  directory: string;
  schema: z.ZodType<T>;
  ref: string;
  sha256: string;
  maxBytes: number;
}): CanonicalArtifactVerification<T> {
  // Require artifacts/<directory>/<sha>.json, component-wise contained parents,
  // regular nlink=1 mode 0600, O_NOFOLLOW, bounded one-buffer read, stable
  // dev/ino/size/mtime/ctime/path, fatal UTF-8, schema parse, and canonical bytes.
}

export function writeCanonicalJsonArtifact<T>(input: {
  root: string;
  directory: string;
  schema: z.ZodType<T>;
  value: T;
  maxBytes: number;
}): CanonicalArtifactWriteResult {
  // Parse before writing, hash canonical UTF-8, create parents component by
  // component, use writeFileIfAbsent(..., { mode: 0o600 }), then reverify.
}
```

Move no behavior: Bench's response/result/trace-set paths remain byte-identical, and policy traces
continue through `verifyPolicyTraceReference`.

- [x] **Step 4: Make Bench delegate to the shared boundary**

```ts
const BENCH_ARTIFACT_TYPES = {
  "bench-result": { directory: "results", schema: BenchResultSchema },
  "response-manifest": { directory: "responses", schema: BenchResponseManifestSchema },
  "policy-trace-set": { directory: "policy-trace-sets", schema: BenchPolicyTraceSetSchema },
} as const;
```

Keep `verifyBenchArtifactReference` exported as a compatibility wrapper and retain the special
policy-trace branch.

- [x] **Step 5: Run focused GREEN and compatibility checks**

Run:

```bash
bun test tests/unit/canonical-json-artifact.test.ts tests/unit/bench-matrix.test.ts tests/unit/bench-result-schema.test.ts
bunx tsc --noEmit
bun run lint
```

Expected: all pass; existing Bench artifact refs and bytes remain unchanged.

- [x] **Step 6: Kill artifact-boundary mutants**

In a validated disposable copy, separately remove `O_NOFOLLOW`, accept `0644`, skip `nlink===1`,
skip canonical-byte comparison, and reread for hashing after verification. Each mutant must fail its
named test; restore and compare the two production-file SHA-256 values.

- [x] **Step 7: Review and commit**

Stage only the four task paths above plus this plan ledger and commit:

```bash
git commit -m "refactor(artifacts): share canonical JSON storage"
```

---

### Task 2: Define the closed measurement and preregistration contracts

**Files:**
- Create: `src/core/policy/measurement-contract.ts`
- Create: `src/schemas/policy-measurement-preregistration.ts`
- Create: `src/schemas/policy-measurement.ts`
- Create: `tests/unit/policy-measurement-preregistration.test.ts`
- Create: `tests/unit/policy-measurement-schema.test.ts`

**Interfaces:**
- Consumes: `POLICY_PASS_IDS`, `POLICY_CATALOG_VERSION`, catalog `order/class/opportunity/overlaps`.
- Produces fixed constants and strict schemas used by every later task, exported under these exact
  names: `PolicyMeasurementPreregistrationSchema`, `PolicyMeasurementPreregistration`,
  `PolicyBenchBundleSchema`, `PolicyBenchBundle`, `PolicyRigScenarioManifestSchema`,
  `PolicyRigScenarioManifest`, `PolicyDogfoodSnapshotSchema`, `PolicyDogfoodSnapshot`,
  `PolicyDogfoodInputManifestSchema`, `PolicyDogfoodInputManifest`,
  `PolicyDogfoodAdjudicationSchema`, `PolicyDogfoodAdjudication`,
  `PolicyDogfoodAttestationSchema`, `PolicyDogfoodAttestation`,
  `PolicyRigEvidenceSchema`, `PolicyRigEvidence`, `PolicyPassEvidenceSchema`,
  `PolicyPassEvidence`, `PolicyPassClassificationSchema`, `PolicyPassClassification`,
  `PolicyMeasurementInvalidityCodeSchema`, `PolicyMeasurementInvalidityCode`,
  `PolicyMeasurementSchema`, and `PolicyMeasurement`.

- [x] **Step 1: Write the missing-module RED tests**

```ts
expect(POLICY_MEASUREMENT_SINGLETONS).toEqual(POLICY_PASS_IDS);
expect(POLICY_MEASUREMENT_INTERACTIONS).toEqual([
  ["judgment.critic", "judgment.confidence", "judgment.reputation"],
  ["scope.diff", "scope.delta", "scope.session"],
  ["history.cycle-rejected", "history.region-rejected", "history.fp-signature", "history.fp-cluster"],
  ["evidence.fact-location", "evidence.grounding-token", "judgment.grounding-llm", "evidence.redaction-placeholder", "evidence.self-refutation"],
]);
expect(POLICY_MEASUREMENT_THRESHOLDS).toEqual({
  statelessCases: 8,
  statelessSignatures: 15,
  repeats: 3,
  statefulSequences: 3,
  opportunityTurnsPerSequence: 2,
  dogfoodDispositions: 5,
  dogfoodRuns: 3,
  bootstrapResamples: 10_000,
});
```

The preregistration tests must reject reordered/missing/duplicate pass IDs, altered groups, 29 or 31
cases, repeats other than three, a dogfood `until` different from `registered_at`, non-clean-source
rules, missing/extra OpenRouter route, retry/output ceilings outside their bounds, changed
interval/correction/candidate/veto literals, mutable/out-of-attempt/duplicate output paths,
threshold drift, unbounded provider calls, and dogfood manifest/attestation refs without full SHA.

- [x] **Step 2: Run RED**

Run: `bun test tests/unit/policy-measurement-preregistration.test.ts tests/unit/policy-measurement-schema.test.ts`

Expected: FAIL on both missing modules.

- [x] **Step 3: Implement the fixed contract**

```ts
export const POLICY_MEASUREMENT_SINGLETONS = POLICY_PASS_IDS;

export const POLICY_MEASUREMENT_INTERACTIONS = [
  ["judgment.critic", "judgment.confidence", "judgment.reputation"],
  ["scope.diff", "scope.delta", "scope.session"],
  ["history.cycle-rejected", "history.region-rejected", "history.fp-signature", "history.fp-cluster"],
  ["evidence.fact-location", "evidence.grounding-token", "judgment.grounding-llm", "evidence.redaction-placeholder", "evidence.self-refutation"],
] as const satisfies readonly (readonly PolicyPassId[])[];

export const POLICY_MEASUREMENT_THRESHOLDS = {
  statelessCases: 8,
  statelessSignatures: 15,
  repeats: 3,
  statefulSequences: 3,
  opportunityTurnsPerSequence: 2,
  dogfoodDispositions: 5,
  dogfoodRuns: 3,
  bootstrapResamples: 10_000,
} as const;

export type PolicyMeasurementLane = "stateless-bench" | "stateful-rig";
export type PolicyClassification =
  | "retain"
  | "delete-candidate"
  | "harmful-candidate"
  | "inconclusive";
```

Add a literal lane map: orders 110, 120, 130, 150, and 160 are `stateful-rig`; all others are
`stateless-bench`.

- [x] **Step 4: Implement strict schemas**

`PolicyMeasurementPreregistrationSchema` must contain:

```ts
{
  schema: "reviewgate.policy-measurement.preregistration.v1";
  registered_at: string;
  release: string;
  attempt: string;
  source: {
    ref: string;
    runner: "dist/reviewgate";
    require_exact_clean_head_containing_this_file: true;
    require_compiled_runner_sha256: true;
  };
  catalog_version: "reviewgate.policy-catalog.v1";
  pass_ids: PolicyPassId[];
  corpus: { path: string; unique_cases: 30; clean: 16; seeded_bug: 14; repeats: 3; manifest_sha256: string; content_sha256: Record<string, string> };
  roster: {
    reviewers: Array<{
      provider: string;
      model: string;
      persona: string;
      openrouter_provider: {
        only?: string[];
        order?: string[];
        allowFallbacks?: boolean;
      } | null;
    }>;
    critic: {
      provider: string;
      model: string;
      persona: string;
      openrouter_provider: {
        only?: string[];
        order?: string[];
        allowFallbacks?: boolean;
      } | null;
    } | null;
    substitution_allowed: false;
  };
  execution: {
    reviewer_max_attempts: number;
    critic_max_attempts: number;
    max_output_tokens: number;
  };
  profiles: { singleton: PolicyPassId[][]; interactions: PolicyPassId[][] };
  stateful: { manifest_ref: string; manifest_sha256: string; min_sequences_per_pass: 3; min_opportunity_turns: 2 };
  dogfood: {
    since: string;
    until: string;
    input_manifest_ref: string;
    input_manifest_sha256: string;
    attestation_ref: string;
    attestation_sha256: string;
    min_dispositions: 5;
    min_runs: 3;
  };
  analysis: {
    stateless_min_cases: 8;
    stateless_min_signatures: 15;
    bootstrap_resamples: 10000;
    seed: number;
    primary: "ground_truth_error";
    interval: "percentile-bootstrap-95";
    correction: { singleton: "holm-18"; interaction: "holm-4" };
    candidate_rules: "safety-first-two-phase-v1";
    vetoes: ["unique-prevented-fp", "unique-preserved-tp", "required-backstop"];
  };
  hard_gates: { maximum_provider_calls: number; maximum_failed_fraction: 0; reviewer_coverage: 1; eligible_critic_coverage: 1; immutable_artifacts: true; no_variant_provider_calls: true };
  outputs: {
    attempt_dir: string;
    bench_bundle: string;
    rig_bundle: string;
    dogfood_snapshot: string;
    result_json: string;
    report_md: string;
  };
  commands: { bench: string[]; stats: string[] };
  rerun_policy: { failed_attempts_are_preserved: true; overwrite_allowed: false; favorable_repeat_selection_allowed: false };
}
```

Use `superRefine` to require `dogfood.until === registered_at`, exact inventory/groups/thresholds,
exact singleton shape `[[pass1], [pass2], ...]`, positive bounded retry/output values, closed
analysis/candidate/veto literals, and every output path as a unique repo-relative descendant of
`bench/results/policy-measurement/<attempt>/`. `openrouter_provider` reuses the strict structural
`OpenRouterProviderRouting` contract (`only`, ordered `order`, `allowFallbacks`) and is non-null
exactly for an effective OpenRouter route; Task 8 compares its canonical structure before creating
adapters.

Define strict schemas for Bench profile bundles, Rig scenario manifests, dogfood input inventories,
human attestations, dogfood snapshots, per-pass evidence, interactions, exclusions, artifacts, and
final `reviewgate.policy-measurement.v1` results. A dogfood input manifest contains the closed,
code-unit-sorted list of audit and trace refs with exact SHA-256, byte count, `(run_id, iter)` and
cutoff window. An attestation binds its own actor, timestamp, content-bound challenge SHA, input
manifest SHA and explicit `tp`/`fp` rows. Legacy artifacts may omit all new additive fields, but a
policy measurement result itself has no legacy/partial mode.

- [x] **Step 5: Run GREEN and schema regressions**

Run:

```bash
bun test tests/unit/policy-measurement-preregistration.test.ts tests/unit/policy-measurement-schema.test.ts tests/unit/policy-catalog.test.ts tests/unit/bench-preregistration.test.ts tests/unit/rig-preregistration.test.ts
bunx tsc --noEmit
bun run lint
```

- [x] **Step 6: Kill contract mutants**

Mutate exact pass order, delete one interaction member, change 8→7, 15→14, 3 repeats→2,
10,000→1,000, allow `dogfood.until > registered_at`, drop route/retry/output binding, merge the two
correction families, loosen candidate/veto literals, allow an output outside the attempt root, and
allow authoritative partial inventory. Each must fail a named schema/contract test; restore file
hashes.

- [x] **Step 7: Review and commit**

```bash
git commit -m "feat(policy): define measurement contracts"
```

---

### Task 3: Persist identity-level Bench truth and validate multi-pass profiles

**Files:**
- Modify: `src/schemas/bench-result.ts:489-635,804-900`
- Modify: `src/bench/runner.ts:205-260,700-790`
- Modify: `src/cli/commands/bench.ts:441-479`
- Modify: `tests/unit/bench-result-schema.test.ts`
- Modify: `tests/unit/bench-runner.test.ts`
- Modify: `tests/unit/bench-matrix.test.ts`

**Interfaces:**
- Consumes: a `PendingReport`, `MatchResult`, and authoritative baseline/counterfactual traces.
- Produces additive `CaseResult.policy_truth` and
  `validateAuthoritativeTraceProfilePair(baseline, counterfactual, expectedAblations)`.

- [x] **Step 1: Write RED tests for truth identities**

```ts
expect(result.cases[0]?.policy_truth).toEqual({
  expected_label_count: 1,
  findings: [
    {
      signature: "expected-signature",
      severity: "WARN",
      outcome: "TP",
      label_index: 0,
      near_miss: false,
    },
  ],
  fn_label_indexes: [],
});
```

Add schema failures for duplicate signatures, TP without a label, FP with a label, a label outside
`expected_label_count`, mismatched FN indexes, and policy-truth data on a non-scored case.

- [x] **Step 2: Write RED tests for group pairing**

```ts
expect(
  validateAuthoritativeTraceProfilePair(baseline, grouped, [
    "scope.diff",
    "scope.delta",
    "scope.session",
  ]),
).toEqual({ ok: true });
```

Require exact catalog order inside the expected ablation set and reject missing, extra, reordered,
duplicate, or `not-run` requested pass rows. Keep the old one-pass wrapper green.

- [x] **Step 3: Run RED**

Run: `bun test tests/unit/bench-result-schema.test.ts tests/unit/bench-runner.test.ts tests/unit/bench-matrix.test.ts`

Expected: the new `policy_truth` and group validator assertions fail.

- [x] **Step 4: Add the additive truth schema and runner mapping**

```ts
export const BenchPolicyTruthSchema = z.object({
  expected_label_count: z.number().int().nonnegative(),
  findings: z.array(
    z.object({
      signature: z.string().min(1),
      severity: Severity,
      outcome: z.enum(["TP", "FP", "NEUTRAL"]),
      label_index: z.number().int().nonnegative().nullable(),
      near_miss: z.boolean(),
    }).strict(),
  ),
  fn_label_indexes: z.array(z.number().int().nonnegative()),
}).strict();
```

In `runBenchCase`, map `aggregatedMatch.findings[].findingId` back to the parsed report finding and
return it as `CaseRunOutcome.policyTruth`. In `outcomeToCaseResult()` in
`src/cli/commands/bench.ts`, explicitly project `out.policyTruth` to persisted
`CaseResult.policy_truth`. Sort truth findings by signature with `compareCodeUnits`; preserve matcher
label indexes exactly. The focused Matrix test must parse the written Bench result and assert the
persisted block, not only the in-memory runner value.

- [x] **Step 5: Generalize trace-pair validation**

```ts
export function validateAuthoritativeTraceProfilePair(
  baseline: AuthoritativeTraceRun,
  counterfactual: AuthoritativeTraceRun,
  expectedAblations: readonly PolicyPassId[],
): AuthoritativeTracePairValidation;

export function validateAuthoritativeTracePair(
  baseline: AuthoritativeTraceRun,
  counterfactual: AuthoritativeTraceRun,
): AuthoritativeTracePairValidation {
  if (counterfactual.requestedAblations.length !== 1) {
    return invalidTracePair(
      "requested-pass-mismatch",
      "counterfactual must request exactly one policy ablation",
    );
  }
  return validateAuthoritativeTraceProfilePair(
    baseline,
    counterfactual,
    counterfactual.requestedAblations,
  );
}
```

The general validator must still bind config/request/response/final identities and every requested
row's `status: ran`. Add a compatibility regression in which the new group validator accepts a
valid two-pass group while the legacy `validateAuthoritativeTracePair` rejects that same pair: WITH
legacy guard = 1 rejection; WITHOUT it = 0 rejections.

- [x] **Step 6: Run GREEN and byte-neutral regressions**

Run:

```bash
bun test tests/unit/bench-result-schema.test.ts tests/unit/bench-runner.test.ts tests/unit/bench-matrix.test.ts tests/integration/policy-trace-equivalence.test.ts
bunx tsc --noEmit
bun run lint
```

- [x] **Step 7: Kill truth/profile mutants**

Drop `policy_truth`, map finding IDs as signatures, allow group subsets, skip group row `ran` checks,
and compare response hashes as a multiset. Named tests must kill all five; restore SHAs.

- [x] **Step 8: Review and commit**

```bash
git commit -m "feat(bench): persist policy truth identities"
```

---

### Task 4: Implement case-level statistics and multiplicity correction

**Files:**
- Create: `src/stats/policy/statistics.ts`
- Create: `tests/unit/policy-statistics.test.ts`

**Interfaces:**
- Consumes repeat-level paired case rows.
- Produces case-collapsed effects, repeat direction, deterministic bootstrap intervals, exact sign
  p-values, and Holm-adjusted p-values.

- [x] **Step 1: Write RED tests for independence and exact math**

```ts
expect(collapseCaseRepeats([
  effect("case-a", 1, 1), effect("case-a", 2, 1), effect("case-a", 3, 1),
  effect("case-b", 1, -1), effect("case-b", 2, -1), effect("case-b", 3, -1),
])).toEqual([
  { caseId: "case-a", mean: 1, repeats: [1, 1, 1] },
  { caseId: "case-b", mean: -1, repeats: [-1, -1, -1] },
]);

expect(exactTwoSidedSignTest([1, 1, 1, 1])).toBe(0.125);
expect(holmAdjust([0.01, 0.04, 0.03])).toEqual([0.03, 0.06, 0.06]);
expect(repeatDirection([1, 2, 0])).toBe("positive");
expect(repeatDirection([1, -1, 0])).toBe("conflict");
expect(repeatDirection([1, 0, 0])).toBe("insufficient");
```

Add a bootstrap test that calls the function twice with seed `20260811` and requires byte-identical
intervals, plus a different-seed control.

- [x] **Step 2: Run RED**

Run: `bun test tests/unit/policy-statistics.test.ts`

Expected: missing module failure.

- [x] **Step 3: Implement pure statistics**

```ts
export interface RepeatCaseEffect {
  caseId: string;
  repeat: 1 | 2 | 3;
  errorReduction: number;
}

export interface CollapsedCaseEffect {
  caseId: string;
  mean: number;
  repeats: [number, number, number];
}

export function collapseCaseRepeats(rows: readonly RepeatCaseEffect[]): CollapsedCaseEffect[];
export function percentileBootstrap95(values: readonly number[], resamples: 10_000, seed: number): { lo: number; hi: number } | null;
export function exactTwoSidedSignTest(values: readonly number[]): number;
export function holmAdjust(pValues: readonly number[]): number[];
export function repeatDirection(repeatMeans: readonly [number, number, number]): "positive" | "negative" | "zero" | "conflict" | "insufficient";
```

Use a local deterministic 32-bit PRNG seeded from the preregistration. Sort case IDs with
`compareCodeUnits`. Reject duplicate `(caseId, repeat)` rows and repeats outside 1..3.

- [x] **Step 4: Run GREEN and property checks**

Run: `bun test tests/unit/policy-statistics.test.ts`

Also assert every adjusted p-value is in `[raw, 1]`, adjusted sorted order is monotone, empty sign
tests return `1`, and empty bootstrap returns `null`.

- [x] **Step 5: Kill statistics mutants**

Count repeats as cases, change 10,000 resamples, use nondeterministic `Math.random`, make the sign
test one-sided, remove Holm cumulative maxima, and combine singleton/interaction p-values. Named
tests must kill each mutant; restore SHA.

- [x] **Step 6: Review and commit**

```bash
git commit -m "feat(stats): add paired policy statistics"
```

---

### Task 5: Implement safety-first pass classification

**Files:**
- Create: `src/stats/policy/classify.ts`
- Create: `tests/unit/policy-classify.test.ts`

**Interfaces:**
- Consumes schema-validated per-pass evidence summaries and corrected statistics.
- Produces ordered `PolicyPassClassification[]` with machine-readable reasons, vetoes, and
  `harm_observed`.
- Keeps the one-argument call compatible and accepts optional schema-validated interaction rows plus
  raw-ref-bound identity facts: `classifyPolicyPasses(evidence, { passFacts, interactions })`. Task 8
  assembles that pure context from validated identity-level sources; classification never infers it
  from aggregate counts.

- [x] **Step 1: Write the classification RED matrix**

Create literal fixtures for:

```ts
expect(classifyPolicyPasses(onePass({ opportunityCases: 7, signatures: 15 }))[0]?.classification)
  .toBe("inconclusive");
expect(classifyPolicyPasses(onePass({ opportunityCases: 8, signatures: 14 }))[0]?.classification)
  .toBe("inconclusive");
expect(classifyPolicyPasses(onePass({ uniqueContribution: "prevented-blocking-fp" }))[0]?.classification)
  .toBe("retain");
expect(classifyPolicyPasses(onePass({ worsenedCases: ["a", "b"] }))[0]?.classification)
  .toBe("harmful-candidate");
expect(classifyPolicyPasses(onePass({ worsenedCases: ["a"], dogfoodSuppressedTp: 1 }))[0]?.classification)
  .toBe("harmful-candidate");
expect(classifyPolicyPasses(coveredZeroEffectFixture)[targetIndex]?.classification)
  .toBe("delete-candidate");
expect(classifyPolicyPasses(interactionVetoFixture)[targetIndex]?.classification)
  .toBe("inconclusive");
expect(classifyPolicyPasses(interactionVetoFixture)[targetIndex]?.reasons)
  .toContain("interaction-removal-harm");
```

Add stateful 2-sequence/3-sequence boundary tests, dogfood 4/5 and 2/3 run boundaries, conflicting
repeat directions, one-positive-plus-two-zero, historical unsigned decisions, and one unique
benefit coexisting with harm (`retain` plus `harm_observed: true`).

- [x] **Step 2: Run RED**

Run: `bun test tests/unit/policy-classify.test.ts`

Expected: missing module failure.

- [x] **Step 3: Implement two-phase classification**

```ts
export function classifyPolicyPasses(
  evidence: readonly PolicyPassEvidenceInput[],
  context?: { passFacts?: readonly PolicyPassClassificationFacts[]; interactions?: readonly PolicyInteractionEvidenceInput[] },
): PolicyPassClassification[] {
  const retained = new Set<PolicyPassId>();
  // Phase 1: direct unique contribution and safety-retention vetoes only.
  // Phase 2: individual harm, then deletion against the fixed retained set.
  // Group-only harm blocks deletion but is never allocated back as individual retain evidence.
  // Every remaining pass, including a group-vetoed pass, is inconclusive.
}

export type PolicyPassEvidenceInput = PolicyPassEvidence;
export type PolicyInteractionEvidenceInput = PolicyMeasurement["interactions"][number];
```

Use closed reason codes:

```ts
type PolicyClassificationReason =
  | "unique-prevented-fp"
  | "unique-preserved-tp"
  | "required-backstop"
  | "interaction-removal-harm"
  | "two-ground-truth-harms"
  | "ground-truth-plus-dogfood-harm"
  | "sufficient-covered-zero-unique-benefit"
  | "insufficient-opportunities"
  | "incomplete-authority"
  | "direction-conflict"
  | "uncovered-benefit"
  | "dogfood-only";
```

Never branch on p-value significance. Persist raw evidence refs for every reason. `retain` requires
direct, pass-identifiable unique protection/backstop evidence; an interaction row may veto deletion
and emit `interaction-removal-harm`, but cannot itself produce `retain`.

- [x] **Step 4: Run GREEN**

Run: `bun test tests/unit/policy-classify.test.ts tests/unit/policy-statistics.test.ts`

- [x] **Step 5: Kill classification mutants**

Change each numeric threshold by one, invert classification precedence, treat missing decisions as
FP, remove unique-contribution veto, accept coverage by an inconclusive pass, and ignore interaction
harm. Every mutant must fail a named literal matrix row; restore SHA.

- [x] **Step 6: Review and commit**

```bash
git commit -m "feat(stats): classify policy pass evidence"
```

---

### Task 6: Bind dogfood decisions to signatures and verified traces

**Files:**
- Modify: `src/core/decision-outcome.ts:13-52`
- Modify: `src/core/loop-driver.ts:513-542`
- Modify: `src/audit/verifier.ts:1-75`
- Create: `src/stats/policy/dogfood-attestation.ts`
- Create: `src/stats/policy/dogfood.ts`
- Modify: `tests/unit/decision-outcome.test.ts`
- Modify: `tests/unit/loop-driver-emit-decisions.test.ts`
- Create: `tests/unit/policy-dogfood.test.ts`
- Create: `tests/unit/policy-dogfood-attestation.test.ts`
- Modify: `tests/unit/audit-verify-corruption.test.ts`

**Interfaces:**
- Produces `findingSignatures(finding): string[]`, additive audit
  `finding_signatures`, `verifyAuditBytes(...)`, `createPolicyDogfoodInputManifest(...)`,
  content-bound `attestPolicyDogfood(...)`, and `harvestPolicyDogfood(...)`.

- [x] **Step 1: Write RED for representative/member signatures**

```ts
expect(findingSignatures(clustered)).toEqual(["member-a", "member-z", "representative"]);
await emitDecisionOutcomes(root, 1, "run-1", audit);
expect(audit.events[0]?.finding_signatures).toEqual([
  "member-a",
  "member-z",
  "representative",
]);
```

Require code-unit sorting and deduplication. Keep `decision_outcome` bytes unchanged.

- [x] **Step 2: Write dogfood harvester RED cases**

Build a real temporary audit chain and stored policy trace. Assert one human-attested joined `tp`,
one human-attested joined `fp`, and exclusion counts for agent-only decision, missing attestation,
attestation/input-manifest SHA mismatch, missing decision, incomplete trace, ambiguous run/iter,
signature absent from lineage, malformed chain, changed source file, and dogfood event at or after
`registered_at`. A legacy `decision.applied` row without human attestation must remain excluded even
when its derived `decision_outcome.bucket` says `tp` or `fp`.

- [x] **Step 3: Run RED**

Run:

```bash
bun test tests/unit/decision-outcome.test.ts tests/unit/loop-driver-emit-decisions.test.ts tests/unit/policy-dogfood-attestation.test.ts tests/unit/policy-dogfood.test.ts
```

Expected: missing signatures/harvester APIs.

- [x] **Step 4: Implement shared signatures and additive emission**

```ts
export function findingSignatures(f: Finding): string[] {
  return [...new Set([f.signature, ...(f.members?.map((member) => member.signature) ?? [])])]
    .sort(compareCodeUnits);
}

await audit.append({
  event: "decision.applied",
  run_id: sessionId,
  iter,
  trigger: "stop-hook",
  finding_signatures: findingSignatures(f),
  decision_outcome: buildDecisionOutcome(d, f),
});
```

- [x] **Step 5: Refactor audit verification to verified bytes**

```ts
export function verifyAuditBytes(input: {
  bytes: Buffer;
  auditDir: string;
}): { ok: true; events: AuditEvent[] } | { ok: false; brokenAtLine: number; totalLines: number };

export async function verifyChain(path: string): Promise<VerifyResult> {
  const bytes = await readFile(path);
  const result = verifyAuditBytes({ bytes, auditDir: resolve(dirname(path), "..", "..", "..") });
  return result.ok
    ? { ok: true, brokenAtLine: null, totalLines: result.events.length }
    : { ok: false, brokenAtLine: result.brokenAtLine, totalLines: result.totalLines };
}
```

Preserve current broken-line semantics and policy-trace reference checks.

- [x] **Step 6: Freeze the source inventory before preregistration**

```ts
export function createPolicyDogfoodInputManifest(input: {
  auditRoots: readonly string[];
  since: string;
  until: string;
}): PolicyDogfoodInputManifest;
```

Read each eligible audit JSONL exactly once through a stable no-follow FD, hash that exact Buffer,
verify it with `verifyAuditBytes`, resolve every referenced complete trace, and emit a closed,
code-unit-sorted inventory of audit/trace refs, SHA-256 values, byte counts and `(run_id, iter)`.
The immutable input manifest is persisted through Task 1 before the policy preregistration is
written; the preregistration binds its exact ref/SHA and identical `[since, until)` cutoff.

- [x] **Step 7: Require an explicit human attestation**

```ts
export function policyDogfoodAttestationPreflight(input: {
  manifest: PolicyDogfoodInputManifest;
  actor: string;
  rows: readonly PolicyDogfoodAdjudication[];
}): { rendered: string; challenge: `ATTEST ${string}`; candidateSha256: string };

export function attestPolicyDogfood(input: {
  manifest: PolicyDogfoodInputManifest;
  actor: string;
  rows: readonly PolicyDogfoodAdjudication[];
  confirmation: string;
  now: Date;
}): PolicyDogfoodAttestation;
```

Mirror the existing Lore approval boundary: render and defang every disposition plus its source
finding/trace identity, bind the challenge to the canonical manifest+rows bytes, require exact
interactive confirmation, rerun the preflight before returning the strict attestation, and never
echo a fresh challenge after mismatch. Task 10 wires this API to a TTY-only
`stats policy attest-dogfood` command and persists the returned immutable artifact. Agent-authored
decision files are candidate evidence only; without this content-bound human attestation they are
never TP/FP labels.

- [x] **Step 8: Implement dogfood harvesting**

```ts
export function harvestPolicyDogfood(input: {
  preregistration: PolicyMeasurementPreregistration;
  inputManifest: PolicyDogfoodInputManifest;
  attestation: PolicyDogfoodAttestation;
}): PolicyDogfoodSnapshot;
```

Verify the preregistered manifest/attestation refs and SHAs before opening any source, reverify every
frozen source Buffer against the inventory, join unique `(run_id, iter)` complete traces, and
attribute only attested evaluations/effects whose `source_signatures` intersect the attested
decision signatures. Count every exclusion by a closed code. Write no files in this function and
never rescan an audit root for later files.

- [x] **Step 9: Run GREEN and regressions**

```bash
bun test tests/unit/decision-outcome.test.ts tests/unit/loop-driver-emit-decisions.test.ts tests/unit/policy-dogfood-attestation.test.ts tests/unit/policy-dogfood.test.ts tests/unit/audit-verify-corruption.test.ts tests/unit/stats-load.test.ts
bunx tsc --noEmit
bun run lint
```

- [x] **Step 10: Kill dogfood mutants**

Emit representative only, locale-sort signatures, accept agent-only decisions, accept an
attestation for a different manifest, join by finding ID, skip trace verification, count missing
decisions as FP, rescan beyond the frozen inventory, and reread audit bytes for hashing. Named tests
must kill all mutants; restore SHAs.

- [x] **Step 11: Review and commit**

```bash
git commit -m "feat(audit): bind decisions to policy signatures"
```

---

### Task 7: Collect stateful evidence from real isolated Rig replay

**Files:**
- Modify: `src/rig/replay.ts:73-106,349-650,653-742`
- Modify: `src/rig/turn-script.ts`
- Modify: `src/rig/driver.ts`
- Modify: `src/rig/harvest.ts`
- Modify: `src/cli/commands/rig.ts`
- Create: `src/stats/policy/rig.ts`
- Modify: `src/schemas/policy-measurement.ts`
- Modify: `src/schemas/rig-manifest.ts`
- Modify: `src/schemas/rig-result.ts`
- Modify: `tests/unit/rig-replay.test.ts`
- Create: `tests/unit/policy-rig-evidence.test.ts`
- Modify: `tests/unit/policy-measurement-schema.test.ts`
- Modify: `tests/unit/rig-ablate.test.ts`
- Modify: `tests/unit/rig-driver.test.ts`
- Modify: `tests/unit/rig-harvest.test.ts`
- Modify: `tests/integration/policy-trace-offline-replay.test.ts`

**Interfaces:**
- Produces `replayPolicyProfileSequence(...)` for one or more ablated pass IDs and
  `collectPolicyRigEvidence(...)` for a strict scenario manifest.
- Preserves `replayPolicyEnvelopePair`, `replayPolicyEnvelopeSequence`, and `runRigAblate` behavior.
- Extends the producer boundary so the driver's exact single-read script bytes are content-addressed
  in the Rig manifest, verified by harvest before labels are used, copied into the Rig result, and
  required by exact ablation and Task-7 evidence collection. The additive persisted fields remain
  optional for legacy schema parseability; exact authority rejects their absence.

- [x] **Step 1: Write RED for multi-pass persistent replay**

```ts
const pairs = await replayPolicyProfileSequence({
  sourceRepoRoot,
  items,
  ablatedPassIds: [
    "history.cycle-rejected",
    "history.region-rejected",
    "history.fp-signature",
    "history.fp-cluster",
  ],
});
expect(pairs[0]?.counterfactual.ablated).toEqual([
  "history.fp-signature",
  "history.cycle-rejected",
  "history.fp-cluster",
  "history.region-rejected",
]);
expect(pairs[1]?.state.counterfactual.digest).not.toBe(pairs[1]?.state.baseline.digest);
```

The expected trace order is catalog order, independent of CLI input order. Assert both branches
carry final findings, not only trace counts.

- [x] **Step 2: Write RED for scenario sufficiency and truth**

Create three independent fixture sequences for each of the five stateful passes, each with two
opportunity turns, plus controls at 2 sequences and at one opportunity turn. The fixture builder must
write real `FpLedgerStore`, `ReputationStore`, region/cycle state, and `ImplicitOutcomeStore` inputs;
it may parameterize file construction but may not inject state callbacks or bypass production replay.
All five families must begin with equal, isolated branch roots and perform real persisted-state reads.
Only the three production outcome-writing families (`history.fp-signature`, `history.fp-cluster`, and
`judgment.reputation`) are expected to diverge after turn one. `history.cycle-rejected` and
`history.region-rejected` are read-only in this replay contract and therefore remain byte/digest
equal with zero branch writes absent an exogenous change. This replaces the invalid 5/5-divergence
witness; no write-only `ImplicitOutcomeStore` policy causality or invented learning write is inferred.

- [x] **Step 3: Run RED**

Run: `bun test tests/unit/rig-replay.test.ts tests/unit/policy-rig-evidence.test.ts`

Expected: missing profile replay/evidence APIs.

- [x] **Step 4: Generalize replay while keeping wrappers**

```ts
export interface PolicyReplayPair {
  baseline: PolicyTrace;
  counterfactual: PolicyTrace;
  findings: { baseline: Finding[]; counterfactual: Finding[] };
  state: { baseline: PolicyReplayBranchStateEvidence; counterfactual: PolicyReplayBranchStateEvidence };
}

export async function replayPolicyProfileSequence(input: {
  sourceRepoRoot: string;
  items: PolicyReplaySequenceItem[];
  ablatedPassIds: readonly PolicyPassId[];
}): Promise<PolicyReplayPair[]>;
```

Normalize the ablation set to catalog order. Single-pass APIs call the profile API with `[passId]`.
Return structured-cloned production final findings from `ReplayPolicyExecution`; keep provider
ceiling and exact baseline reproduction.

- [x] **Step 5: Implement scenario evidence collection**

```ts
export async function collectPolicyRigEvidence(input: {
  preregistration: PolicyMeasurementPreregistration;
  manifest: PolicyRigScenarioManifest;
  sourceRepoRoot: string;
}): Promise<PolicyRigEvidence>;
```

Verify every result/manifest/script/state/cassette/trace binding before replay. Match seeded turn tags
through the existing `matchesAnyTag`; calculate baseline/counterfactual blocking TP/FP/FN, pass
opportunities, state reads/writes/digests, and sequence authority. Replay the four-history-pass group
on every applicable sequence. Never infer later policy causality from `ImplicitOutcomeStore` because
production does not read it as a policy input.

- [x] **Step 6: Run GREEN and legacy regressions**

```bash
bun test tests/unit/rig-replay.test.ts tests/unit/policy-rig-evidence.test.ts tests/unit/rig-ablate.test.ts tests/integration/policy-trace-offline-replay.test.ts
bunx tsc --noEmit
bun run lint
```

- [x] **Step 7: Kill stateful mutants**

Use a fresh branch pair per turn, share state directories, import baseline-owned absent paths into
counterfactual, replace real store reads with envelope fields, omit one group member, and count
`ran` with zero opportunities as an opportunity turn. Named tests must kill all six; restore SHAs.

- [x] **Step 8: Review and commit**

```bash
git commit -m "feat(rig): collect stateful policy evidence"
```

---

### Task 8: Run the complete stateless policy schedule from one baseline capture

**Files:**
- Modify: `src/cli/commands/bench.ts:1049-1248,2357-2810`
- Modify: `src/schemas/bench-result.ts:804-1000`
- Modify: `src/schemas/policy-measurement.ts:528-610`
- Create: `tests/unit/bench-policy.test.ts`
- Verify unchanged regression contract: `tests/unit/bench-matrix.test.ts`
- Verify unchanged regression contract: `tests/unit/bench-preregistration.test.ts`
- Modify: `tests/unit/policy-measurement-schema.test.ts`

**Interfaces:**
- Produces `runBenchPolicy(input: BenchPolicyInput): Promise<BenchRunOutput>` and an immutable
  `PolicyBenchBundle` whose `PolicyBenchProfileArtifact` rows bind all three repeat identities,
  response/result/trace-set refs and hashes, ordered response hashes, case truth, and pass authority.
- Keeps `runBenchMatrix` as a singleton-profile wrapper over the shared capture engine.

- [x] **Step 1: Write the exact schedule RED**

Use the internal capture engine with a two-case unit fixture and the exact closed 23 profiles; do not
weaken or override the production preregistration schema. A separate command-level test builds 30
small temporary corpus cases satisfying the literal 16-clean/14-seeded contract. Count calls:

```ts
const output = await runBenchPolicy(input);
expect(output.exitCode).toBe(0);
expect(bundle.profiles).toHaveLength(23);
expect(bundle.profiles[0]?.ablated_pass_ids).toEqual([]);
expect(bundle.profiles.slice(1, 19).map((row) => row.ablated_pass_ids)).toEqual(
  POLICY_PASS_IDS.map((passId) => [passId]),
);
expect(bundle.profiles.slice(19).map((row) => row.ablated_pass_ids)).toEqual(
  POLICY_MEASUREMENT_INTERACTIONS,
);
expect(calls.review).toBe(baselineExpectedReviewCalls);
expect(calls.complete).toBe(baselineExpectedCompleteCalls);
expect(calls.preflight).toBe(baselineExpectedPreflights);
```

Variant adapters throw if any live method is reached. Assert all profile traces in each repeat have
identical ordered response hashes.

- [x] **Step 2: Write invalidity RED cases**

Cover incomplete profile inventory, group member/order mismatch, one unconsumed response, changed
request/config hash, a `not-run` requested pass, cross-repeat response reuse, non-authoritative case,
tampered truth block, output already exists, and preregistration mismatches for route,
reviewer/critic retry ceilings, max output tokens, candidate/veto/correction literals, and every
output path before adapter creation. Routing fixtures independently alter `only`, `order`, and
`allowFallbacks`. A provider factory spy must remain at zero for every mismatch.

- [x] **Step 3: Run RED**

Run: `bun test tests/unit/bench-policy.test.ts`

Expected: missing `runBenchPolicy` and bundle schema support.

- [x] **Step 4: Refactor the capture engine around profiles**

```ts
export interface BenchPolicyInput {
  repoRoot: string;
  preregistration: string;
  out: string;
  adapters?: Partial<Record<ProviderId, ProviderAdapter>>;
  providerAvailable?: (id: ProviderId, apiKeyEnv?: string) => boolean;
  now?: () => Date;
}

interface BenchExecutionProfile {
  id: "baseline" | `single:${PolicyPassId}` | `interaction:${number}`;
  ablatedPassIds: readonly PolicyPassId[];
}

async function runCapturedProfiles(
  input: BenchMatrixInput,
  profiles: readonly BenchExecutionProfile[],
): Promise<CapturedProfileRun[]>;
```

Capture the baseline once with `repeat: 3`; sort captured calls by global logical ordinal; replay a
fresh fully consumed adapter view per profile. `runBenchMatrix` passes baseline plus its requested
singletons. `runBenchPolicy` loads the preregistration, verifies source/corpus/roster/structured
OpenRouter routing (`only`, ordered `order`, `allowFallbacks`)/retries/
output ceiling/analysis rules/output paths against the effective run before adapter creation, and
passes the exact closed 23 profiles.

- [x] **Step 5: Persist the strict Bench policy bundle**

Write response manifests, results, traces, and trace sets through Task 1's artifact boundary. Bind
profile ID, ordered ablation IDs, repeat/case identity, truth block, result refs/hashes, and exact
response-manifest ref/hash. Publish the Bench input bundle only after every artifact reverifies.

- [x] **Step 6: Run GREEN and Bench regressions**

```bash
bun test tests/unit/bench-policy.test.ts tests/unit/bench-matrix.test.ts tests/unit/bench-result-schema.test.ts tests/unit/bench-preregistration.test.ts tests/unit/bench-runner.test.ts
bunx tsc --noEmit
bun run lint
```

- [x] **Step 7: Kill schedule/pairing mutants**

Drop one singleton, drop one group, reuse only the final repeat, allow a variant preflight, compare
response hashes as sets, skip full consumption, ignore truth tamper, default a `not-run` pass to
zero opportunities, and construct an adapter before rejecting each route/retry/output/output-path
mismatch. Each must fail a named test; restore SHAs.

- [x] **Step 8: Review and commit**

```bash
git commit -m "feat(bench): execute preregistered policy schedule"
```

---

### Task 9: Assemble and validate the authoritative evidence bundle

**Files:**
- Modify: `src/schemas/policy-measurement.ts`
- Modify: `src/stats/policy/dogfood.ts`
- Modify: `src/cli/commands/bench.ts`
- Modify: `src/rig/policy-replay-state.ts`
- Modify: `src/stats/policy/rig.ts`
- Create: `src/stats/policy/assemble.ts`
- Modify: `tests/unit/policy-measurement-schema.test.ts`
- Modify: `tests/unit/policy-dogfood.test.ts`
- Modify: `tests/unit/policy-rig-evidence.test.ts`
- Modify: `tests/unit/rig-replay.test.ts`
- Create: `tests/unit/policy-assemble.test.ts`
- Create: `tests/integration/policy-measurement-pipeline.test.ts`

**Interfaces:**
- Consumes parsed preregistration, Bench bundle, Rig scenario manifest, dogfood audit roots, and
  source repository.
- Extends the unreleased dogfood snapshot with the exact verified evaluation result/severity/
  protection authority and a schema-cross-validated derived effect, copied during the existing
  single frozen trace read so assembly never rescans dogfood traces.
- Extends the existing Bench and Rig verification success values with their already-verified parsed
  artifacts, complete ref/hash inventories, source commit, and per-turn error identities. Assembly
  consumes those values without trace/result rescans and rebinds persisted provenance to the
  preregistration and resolved source HEAD.
- Produces `assemblePolicyMeasurement(...)` and a fully schema-valid in-memory result plus source
  artifact inventory. It does not publish files.

- [x] **Step 1: Write the end-to-end in-memory RED**

```ts
const assembled = await assemblePolicyMeasurement({
  repoRoot,
  preregistrationPath,
  benchBundlePath,
  rigManifestPath,
});
expect(assembled.result.schema).toBe("reviewgate.policy-measurement.v1");
expect(assembled.result.passes.map((row) => row.pass_id)).toEqual(POLICY_PASS_IDS);
expect(assembled.result.interactions).toHaveLength(4);
expect(assembled.result.artifacts.authoritative).toBe(true);
```

The fixture must include one `retain`, one `harmful-candidate`, one `delete-candidate`, and one
`inconclusive`, with remaining catalog rows valid/inconclusive.

- [x] **Step 2: Write fail-closed RED matrix**

Require typed `PolicyMeasurementAuthorityError` code and no output for: dirty or wrong source HEAD,
prereg bytes/hash mismatch, catalog drift, corpus truth mismatch, missing repeat/profile, response
hash/order mismatch, trace-set swap, state digest mismatch, unverified Rig result, dogfood audit hash
change, wrong correction-family cardinality, and any ref outside the declared input roots.

- [x] **Step 3: Run RED**

Run: `bun test tests/unit/policy-assemble.test.ts tests/integration/policy-measurement-pipeline.test.ts`

Expected: missing module failure.

- [x] **Step 4: Implement authoritative assembly**

```ts
export class PolicyMeasurementAuthorityError extends Error {
  readonly exitCode = 4;
  constructor(readonly code: PolicyMeasurementInvalidityCode, message: string) {
    super(`policy measurement: ${code} — ${message}`);
  }
}

export interface CanonicalSourceArtifact {
  kind: "preregistration" | "bench" | "rig" | "dogfood" | "trace" | "state" | "cassette";
  ref: string;
  sha256: string;
}

export async function assemblePolicyMeasurement(input: {
  repoRoot: string;
  preregistrationPath: string;
  benchBundlePath: string;
  rigManifestPath: string;
}): Promise<{ result: PolicyMeasurement; sources: CanonicalSourceArtifact[] }>;
```

Validation order is prereg/source/catalog/corpus → complete Bench inventory/pairs → complete Rig
inventory/state → dogfood audit/trace joins → case/sequence/run evidence → separate 18/4 Holm
families → two-phase classification → final schema parse. Do not catch an authority error and emit a
partial result.

- [x] **Step 5: Compute opportunity-conditioned evidence**

Derive distinct opportunity cases and signatures from trace evaluations, not `status: ran`. Derive
truth effects from `policy_truth` and Rig final findings. Store every raw evidence ref used by a
classification and every excluded lane/reason. Do not pool repeats, sequences, or dogfood runs.

- [x] **Step 6: Run GREEN**

```bash
bun test tests/unit/policy-assemble.test.ts tests/integration/policy-measurement-pipeline.test.ts tests/unit/policy-statistics.test.ts tests/unit/policy-classify.test.ts tests/unit/policy-dogfood.test.ts tests/unit/policy-rig-evidence.test.ts
bunx tsc --noEmit
bun run lint
```

- [x] **Step 7: Kill bundle-authority mutants**

Bypass prereg source binding, accept 17 passes, accept 2 repeats, merge Holm families, count
no-opportunity rows, drop one raw evidence ref, skip dogfood source hash, and continue after one
invalid lane. Each must fail a named unit/integration test; restore SHAs.

- [x] **Step 8: Review and commit**

```bash
git commit -m "feat(stats): assemble authoritative policy evidence"
```

---

### Task 10: Publish atomic bundles and expose the CLI/report

**Files:**
- Create: `src/stats/policy/render.ts`
- Modify: `src/cli/commands/stats.ts:1-49`
- Modify: `src/cli/index.ts:618-642,726-1035`
- Create: `tests/unit/policy-render.test.ts`
- Modify: `tests/unit/stats-command.test.ts`
- Modify: `tests/unit/cli-required-args.test.ts`
- Modify: `tests/integration/policy-measurement-pipeline.test.ts`

**Interfaces:**
- Produces `runPolicyStats(...)`, `renderPolicyMeasurement(...)`, `bench policy`, and `stats policy`.
- Produces the TTY-only `stats policy attest-dogfood` write boundary for Task 6's immutable human
  attestation; non-TTY/EOF/mismatch writes nothing and exits nonzero.
- Preserves `runStats(...)` and default `reviewgate stats` bytes.

- [ ] **Step 1: Write RED for report parity**

```ts
const markdown = renderPolicyMeasurement(PolicyMeasurementSchema.parse(fixture));
expect(markdown).toContain("| Pass | Lane | Opportunities | Classification |");
expect(markdown).toContain("`judgment.confidence`");
expect(markdown).toContain("INCONCLUSIVE — insufficient-opportunities");
expect(extractClassifications(markdown)).toEqual(
  Object.fromEntries(fixture.passes.map((row) => [row.pass_id, row.classification])),
);
```

Assert exclusions, interaction rows, raw/adjusted p-values, intervals, vetoes, and artifact authority
are rendered; forbid claims absent from JSON.

- [ ] **Step 2: Write CLI RED tests**

Assert:

```ts
expect(runCli(["stats", "--json"]).stdout).toBe(existingStatsGolden);
expect(runCli(["bench", "policy", "--help"]).code).toBe(0);
expect(runCli(["stats", "policy", "--help"]).code).toBe(0);
expect(runCli(["stats", "policy", "attest-dogfood", "--help"]).code).toBe(0);
expect(runCli(["stats", "policy", "--preregistration", bad, "--bench", b, "--rig", r, "--out", out]).code).toBe(4);
expect(existsSync(out)).toBe(false);
```

Required flags are parser-level required and help names the no-provider counterfactual and exit-4
authority boundary. Add TTY controls proving that the full candidate dossier is rendered before the
challenge, matching confirmation writes one content-addressed `0600` attestation, and non-TTY,
EOF, mismatch, or a manifest swap writes zero artifacts.

- [ ] **Step 3: Run RED**

Run:

```bash
bun test tests/unit/policy-render.test.ts tests/unit/stats-command.test.ts tests/unit/cli-required-args.test.ts tests/integration/policy-measurement-pipeline.test.ts
```

Expected: missing renderer/commands and current flat Stats command has no `policy` child.

- [ ] **Step 4: Implement pure rendering**

```ts
export function renderPolicyMeasurement(result: PolicyMeasurement): string {
  const parsed = PolicyMeasurementSchema.parse(result);
  // Render only parsed fields: authority header, 18-row table, four interactions,
  // evidence/veto dossiers, exclusions, limitations, and artifact identities.
}
```

- [ ] **Step 5: Implement atomic bundle publication**

```ts
export async function runPolicyStats(input: {
  repoRoot: string;
  preregistration: string;
  bench: string;
  rig: string;
  out: string;
}): Promise<{ exitCode: 0 | 2 | 4; stdout: string; stderr: string }>;
```

Require final output absent. Assemble completely in memory, create a private sibling staging
directory, write/reverify content-addressed sources plus `result.json` and `report.md` at mode 0600,
then rename the directory once on the same filesystem. On any error remove only the validated staging
directory; never touch source artifacts. Catch only `PolicyMeasurementAuthorityError` as exit 4.

- [ ] **Step 6: Wire commands without changing default Stats**

Add `bench policy` with required `--preregistration` and `--out`. Add `stats policy` with required
`--preregistration`, `--bench`, `--rig`, and `--out`, plus `stats policy attest-dogfood` with
required frozen input manifest, adjudication draft, actor, and output root. The latter must use a
real TTY/readline boundary in production and the Task 6 preflight/attestation API; it never infers a
human actor from a DecisionEntry. Keep the existing Stats args/run as the default path and add the
child command using Citty's supported `subCommands` field.

- [ ] **Step 7: Run GREEN and compiled-help preparation**

```bash
bun test tests/unit/policy-render.test.ts tests/unit/stats-command.test.ts tests/unit/cli-required-args.test.ts tests/integration/policy-measurement-pipeline.test.ts tests/unit/bench-policy.test.ts
bunx tsc --noEmit
bun run lint
```

- [ ] **Step 8: Kill publication/CLI mutants**

Write the report before validation, publish files separately, accept an existing output directory,
map authority errors to exit 1, omit a required CLI flag, route bare `stats` into policy mode,
accept a non-TTY/EOF/mismatched attestation, and skip the preflight rerun after manifest swap. Named
tests must kill every mutant; restore SHAs.

- [ ] **Step 9: Review and commit**

```bash
git commit -m "feat(cli): expose policy measurement commands"
```

---

### Task 11: Document the implemented boundary and preregistration handoff

**Files:**
- Modify: `docs/architecture.md`
- Modify: `TEST_PLAN.md`
- Modify: `NEXT_SESSION.md`
- Modify: `AGENTS.md`
- Modify: `docs/superpowers/specs/2026-08-11-policy-measurement-pruning-design.md`

**Interfaces:**
- Consumes the final implemented paths and CLI help.
- Produces an accurate trailhead and an explicit “implementation complete, paid preregistration not
  yet authorized” handoff.

- [ ] **Step 1: Update architecture and test documentation**

Document:

- the three evidence lanes and pure `src/stats/policy/` ownership;
- additive Bench truth identities and audit decision signatures;
- exact 23-profile response pairing and real stateful replay;
- bundle authority, exit codes, and no-partial-publish rule;
- threshold/mutation tests and why repeats are not independent cases; and
- the Slice 2A/2B boundary.

- [ ] **Step 2: Update the session handoff**

`NEXT_SESSION.md` must say:

```markdown
Slice 2A implementation is complete. No policy pass changed and no paid measurement ran.
Next: author and dry-validate the 15 real stateful scenarios (three independent two-opportunity
sequences for each of five stateful passes); accrue explicit dogfood decisions with complete traces;
freeze the audit/trace inventory; obtain the TTY human attestation; then choose and cost the concrete
provider roster. Only after those inputs exist, write and review one committed attempt-specific
reviewgate.policy-measurement.preregistration.v1 and run exactly one registered capture.
Qwen remains a separate parked measurement stream.
```

- [ ] **Step 3: Refresh the trailhead only from actual paths**

Run `node /Users/markus/.claude/scripts/verify-map.js`. Update the Stats and Bench rows in
`AGENTS.md` to name `src/stats/policy/assemble.ts` and the new focused tests; set `verified_commit`
to the Task-10 code commit, which is the complete code state being documented. Do not touch
unrelated rows.

- [ ] **Step 4: Mark the design implemented without claiming measurement**

Change the design status to “Implemented; preregistration and measurement pending” and link this
plan. Do not add results or candidate classifications.

- [ ] **Step 5: Verify docs and commit**

Run:

```bash
git diff --check
rg -n "T[B]D|T[O]DO|PLACE[H]OLDER" docs/architecture.md TEST_PLAN.md NEXT_SESSION.md AGENTS.md docs/superpowers/specs/2026-08-11-policy-measurement-pruning-design.md
```

Expected: diff clean and no placeholder hits.

Commit:

```bash
git commit -m "docs: document policy measurement workflow"
```

---

### Task 12: Final verification, mutation dossier, and independent reviews

**Files:**
- Create: `docs/dev/2026-08-11-policy-measurement-mutation-evidence.md`
- Create ignored report: `.superpowers/sdd/2026-08-11-policy-measurement-pruning/final-report.md`
- Modify only files named by a confirmed review finding.

**Interfaces:**
- Consumes the complete Slice 2A branch.
- Produces final executable evidence and the reviewed handoff; no measurement artifacts.

- [ ] **Step 1: Consolidate the mutation dossier**

For every mutation family from Tasks 1–10, record production file SHA before mutation, exact test
command, named failing test, observed RED summary, restore SHA, and final GREEN command. Verify every
production SHA is restored and `git diff -- src tests` contains only intended implementation changes.

- [ ] **Step 2: Run the complete focused suite serially**

Run:

```bash
bun test \
  tests/unit/canonical-json-artifact.test.ts \
  tests/unit/policy-measurement-preregistration.test.ts \
  tests/unit/policy-measurement-schema.test.ts \
  tests/unit/bench-policy.test.ts \
  tests/unit/policy-statistics.test.ts \
  tests/unit/policy-classify.test.ts \
  tests/unit/policy-dogfood.test.ts \
  tests/unit/policy-rig-evidence.test.ts \
  tests/unit/policy-assemble.test.ts \
  tests/unit/policy-render.test.ts \
  tests/integration/policy-measurement-pipeline.test.ts \
  tests/integration/policy-trace-equivalence.test.ts \
  tests/integration/policy-trace-offline-replay.test.ts
```

Expected: zero failures.

- [ ] **Step 3: Run static gates**

```bash
bunx tsc --noEmit
bun run lint
git diff --check
```

Expected: all exit 0.

- [ ] **Step 4: Run exactly one full suite**

Confirm no other Bun/test/build process and viable host load, then run:

```bash
bun test > /tmp/reviewgate-policy-slice2-full.txt 2>&1
```

Read the terminal summary from the file and record pass/skip/fail counts and exit code. Do not pipe
through `tail`, change timeouts, or start a second run while the first process exists.

- [ ] **Step 5: Build and smoke the compiled CLI**

After confirming no foreign gate/build process and understanding that the repo build refreshes the
machine-wide symlink, run:

```bash
bun run build
./dist/reviewgate bench policy --help
./dist/reviewgate stats --help
./dist/reviewgate stats policy --help
```

Expected: all exit 0; default Stats help remains present; policy help states authoritative exact
replay and required arguments.

- [ ] **Step 6: Run independent contract and security/failure-mode reviews**

Contract review must map every approved spec requirement to code/tests and reject missing lanes,
threshold drift, false independence, or production behavior changes. Security review must probe
artifact containment/mode/link/race boundaries, cross-run substitution, audit/trace joins, output
atomicity, provider ceilings, and typed exit 4. Any CRITICAL/WARN receives a named RED regression,
minimal fix, focused/full gate proportional to the fix, and delta re-review. Converge within three
rounds or escalate the remaining judgment call to Markus.

- [ ] **Step 7: Final repository and Brain handoff**

Check explicit staged paths, absent `.reviewgate/gate.lock`, clean tracked worktree, commit ancestry,
and no foreign process. Update `/Users/markus/Documents/Brain/02 Projekte/Aktiv/ReviewGate.md` and
the current Daily Note with commits, exact verification, review verdicts, and the still-pending
provider/cost preregistration decision. Do not push, merge, run a real Rig, or spend provider credits
without separate authorization.

- [ ] **Step 8: Commit the final mutation dossier and any review-bound fixes**

If review rounds changed code, commit each fix separately after its delta re-review. Then stage only
`docs/dev/2026-08-11-policy-measurement-mutation-evidence.md` and any final documentation line that
records verified counts:

```bash
git commit -m "docs(test): record policy measurement evidence"
```

Recheck a clean tracked worktree after the commit. The ignored `.superpowers` report and Brain notes
remain outside the commit.

---

## Numeric guard witnesses

Every new guard and mutation named in Tasks 1–10 is bound to a literal quantity below. “WITH” is
the intended implementation; “WITHOUT” is the single named guard bypass/mutant while all other
inputs remain fixed. The implementing test must assert both columns before its task commit.

| Task / guarded quantity | WITH mechanism | WITHOUT / named mutant |
|---|---:|---:|
| T1 valid canonical artifact accepted | 1/1 | 1/1 control |
| T1 symlink/final-link/hardlink/0644/oversize/UTF-8/noncanonical/hash/traversal/swap invalidities rejected | 10/10 | 9/10 for each single bypass |
| T1 exact Buffer is both hashed and parsed | 1 Buffer read | 2 Buffer reads after reread mutant |
| T2 exact pass inventory fixture accepted/rejected | valid fixture accepted = 1; reordered, missing, duplicate fixtures rejected = 3/3 | valid accepted = 0 after deletion; invalid rejected = 2/3 after each reorder/duplicate bypass |
| T2 interaction members valid | 15/15 declared member positions | 14/15 after one member deletion |
| T2 corpus split and repeats valid | 30 = 16+14, repeats = 3 | 29 or 31 cases, or repeats = 2 |
| T2 stateless thresholds valid | cases = 8, signatures = 15 | cases = 7 or signatures = 14 |
| T2 stateful sequence threshold | 3 sequences sufficient | 2 sequences insufficient |
| T2 stateful opportunity-turn threshold | 2 turns sufficient | 1 turn insufficient |
| T2 dogfood thresholds | 5 dispositions from 3 runs sufficient | 4 dispositions or 2 runs insufficient |
| T2 bootstrap threshold | 10,000 resamples valid | 1,000 resamples invalid |
| T2 closed route/retry/output/analysis/output-path fixtures rejected | 12/12 invalid fixtures | 11/12 for each bypass |
| T3 persisted truth identities | 1 expected truth block with 1 finding | 0 blocks when persistence is dropped; 0 matching signatures when IDs are substituted |
| T3 malformed truth rows rejected | 6/6 | 5/6 for each schema bypass |
| T3 group missing/extra/reordered/duplicate/not-run rows rejected | 5/5 | 4/5 for each validator bypass |
| T3 valid two-pass group | group validator accepts 1/1; legacy wrapper rejects 1/1 | legacy wrapper rejects 0/1 when its singleton guard is removed |
| T3 ordered response mismatch rejected | 1/1 | 0/1 under multiset comparison |
| T4 independent samples after repeat collapse | 2 cases | 6 pseudo-samples when repeats are counted |
| T4 fixed bootstrap and seed | 10,000 resamples; same-seed distinct outputs = 1 | resample count = 1,000; two injected `Math.random` streams produce distinct outputs = 2 |
| T4 exact two-sided sign test `[1,1,1,1]` | p = 0.125 | p = 0.0625 one-sided |
| T4 Holm `[0.01,0.04,0.03]` | `[0.03,0.06,0.06]` | `[0.03,0.04,0.06]` when cumulative maxima are removed |
| T4 correction family cardinality | 18 singleton + 4 interaction | one combined family of 22 |
| T5 stateless boundary | 8 cases and 15 signatures sufficient | 7 cases or 14 signatures insufficient |
| T5 stateful boundary | 3 sequences × 2 opportunity turns sufficient | 2 sequences or 1 opportunity turn insufficient |
| T5 dogfood boundary | 5 dispositions from 3 runs corroborating | 4 dispositions or 2 runs insufficient |
| T5 unique contribution precedence | 1 direct unique event → retain | 0 retained when veto is removed |
| T5 harm precedence | 2 ground-truth harms, or 1 ground-truth + 1 dogfood TP → harmful | 0 harmful when precedence is inverted |
| T5 group-only removal harm | deletion vetoes = 1; classification = `inconclusive` | deletion vetoes = 0; classification = `delete-candidate` when interaction harm is ignored |
| T5 coverage | 1 retained overlapping pass may cover benefit | 0 valid cover from an inconclusive pass |
| T6 representative/member signature identity | 3 sorted unique signatures | 1 representative-only signature |
| T6 frozen input inventory fixture | 2 audit + 2 trace refs consumed = 4; extras = 0 | 5 refs consumed after one post-freeze audit is rescanned; extras = 1 |
| T6 human provenance | 2/2 attested TP/FP rows eligible | 0/2 eligible without matching human attestation |
| T6 dogfood exclusion matrix | 10/10 excluded | 9/10 for each provenance/join/trace/source bypass |
| T6 audit read identity | 1 stable Buffer read per source | 2 reads under hash reread mutant |
| T7 stateful scenario sufficiency | 5/5 passes have 3 sequences × 2 opportunity turns | 0/5 sufficient at 2 sequences or 1 opportunity turn |
| T7 four-history profile order | 4/4 IDs in catalog order | 3/4 when one member is omitted |
| T7 branch persistence | 5/5 isolated real reads; exactly 3/5 write-producing families diverge and 2/5 read-only families remain equal with zero writes | expected 3/5 divergence is lost or branch isolation fails under fresh-pair/share/import mutants |
| T7 opportunity carrier | 2/2 turns have opportunities | 0/2 valid when only `ran` with zero opportunities is supplied |
| T7 final identity output | baseline + counterfactual findings present in 2/2 branches | 1/2 after one branch output is dropped |
| T8 exact profile schedule | 23 profiles = 1 + 18 + 4 | 22 after one singleton/group drop |
| T8 two-case/three-repeat provider ceiling | review = 6, complete = 6, preflight = 1 | review = 138, complete = 138, preflight = 23 if all 23 profiles call live |
| T8 response full consumption | 12/12 review+complete entries consumed; leftovers = 0 | 11/12 consumed; leftovers = 1 |
| T8 response order | order mismatches = 0 | order mismatches = 1 under set/multiset comparison mutant |
| T8 repeat isolation | 3 distinct response-manifest SHAs | 1 SHA reused across repeats |
| T8 authority invalidity matrix | 16/16 rejected before publication | 15/16 for each single bypass |
| T9 final catalog rows and interactions | 18 pass rows + 4 interaction rows | 17 pass rows or 3 interactions accepted by mutant |
| T9 fail-closed authority matrix | invalid fixtures rejected = 16/16 | invalid fixtures rejected = 15/16 under each validation bypass |
| T9 invalid-lane continuation | published outputs = 0 | published outputs = 1 when assembly continues after the invalid lane |
| T9 opportunity conditioning | considered rows with opportunities = counted; `ran`/0-opportunity rows counted = 0 | `ran`/0-opportunity rows counted = 1 |
| T9 correction families | 18 singleton + 4 interaction | one merged family of 22 |
| T9 raw evidence completeness | missing refs = 0 | missing refs = 1 when one evidence ref is dropped |
| T10 renderer classification parity | 18/18 JSON rows equal Markdown rows | 17/18 after one row omission |
| T10 default Stats compatibility | golden equality assertions = 1/1 | equality assertions = 0/1 if bare Stats routes to policy mode |
| T10 authority exit mapping | authority fixture exit = 4 | authority fixture exit = 1 under mapping mutant |
| T10 authority failure publication | named outputs = 0 | named outputs = 1 when report-before-validation mutant is active |
| T10 atomic publication | named publish operations = 1 directory rename | named publish operations = 2 under split-write mutant |
| T10 human-attestation boundary | matching TTY challenge writes = 1; non-TTY/EOF/mismatch/swap writes = 0/0/0/0 | the individually bypassed invalid case writes = 1 |
| T10 parser-required flags | 10/10 omissions rejected (2 Bench + 4 Stats + 4 attestation) | 9/10 omissions rejected when one required marker is removed |

---

## Definition of Done

- Every task commit is focused, reviewed, and mutation-protected.
- All 18 pass IDs and four interaction groups are closed and schema-bound.
- Bench proves exactly one live baseline per repeat and zero variant provider calls.
- Rig proves real multi-turn branch-local state for every stateful family.
- Dogfood accepts only explicit signed decisions joined to verified traces.
- Case-level statistics, separate Holm families, thresholds, vetoes, and two-phase classifications
  match the approved spec literally.
- Invalid inputs exit 4 and publish no named result/report; insufficient evidence yields a valid
  `inconclusive` result.
- Existing Stats/Bench/Rig/Audit/production policy behavior remains compatible.
- Focused suite, TypeScript, Biome, full suite, build, compiled help, mutation dossier, contract
  review, and security/failure-mode review are all green.
- No concrete provider roster, paid preregistration, measurement run, pass deletion, push, or merge
  occurs as part of Slice 2A implementation.

## Plan self-review and spec coverage

| Approved spec requirement | Owning task(s) |
|---|---|
| Closed 18-pass inventory, lanes, four interactions, exact thresholds | Task 2 |
| Identity-level Bench truth and group-safe trace pairing | Task 3 |
| Case is the independent unit; deterministic interval/sign/Holm math | Task 4 |
| Safety-first retain/harm/delete/inconclusive precedence and vetoes | Task 5 |
| Explicit signed dogfood decisions, verified chain/trace join, exclusions | Task 6 |
| Three × two-turn stateful sequences, real stores, isolated persistence | Task 7 |
| 30 × 3 baseline capture, 18 singleton + four group offline profiles | Task 8 |
| Closed artifact/input validation and opportunity-conditioned assembly | Task 9 |
| Atomic JSON/Markdown bundle, exit 4, CLI compatibility | Task 10 |
| Architecture/test/trailhead and cost/preregistration handoff | Task 11 |
| Mutation dossier, full/static/build/help gates, independent reviews | Task 12 |

Type names are fixed in Task 2 and reused verbatim in Tasks 5–10. `runBenchPolicy` produces
`PolicyBenchBundle`; `collectPolicyRigEvidence` produces Rig lane evidence from
`PolicyRigScenarioManifest`; `harvestPolicyDogfood` produces `PolicyDogfoodSnapshot`;
`assemblePolicyMeasurement` is the only function that combines them into `PolicyMeasurement`.
No approved requirement is deferred to Slice 2B except actual pass deletion/consolidation, exactly
as required by the design.

## Plan-gate findings mapping

### Round 1 — `FAIL`, addressed for delta review

| Finding | Minimal correction incorporated | Owning task(s) |
|---|---|---|
| C1 Task 3 lacked the persisted `CaseResult` projection path | Added `src/cli/commands/bench.ts:441-479`, `CaseRunOutcome.policyTruth` → `policy_truth`, and a written-result assertion | Task 3 |
| C2 legacy singleton validator would accept groups | Preserved an explicit `requestedAblations.length === 1` guard and added the same-pair group/legacy 1-accept/1-reject witness | Task 3 |
| C3 preregistration omitted run-/cost-/result-affecting inputs | Added structural OpenRouter routing (`only`, ordered `order`, `allowFallbacks`), retry ceilings, output-token ceiling, interval/correction/candidate/veto literals, immutable output paths, and pre-adapter effective-run comparison | Tasks 2, 8 |
| C4 group harm was incorrectly classified as individual `retain` | Group-only harm now vetoes deletion but yields `inconclusive`; only direct unique protection/backstop evidence yields `retain` | Task 5 |
| C5 agent decisions were treated as human ground truth | Added a content-bound, TTY-only human attestation artifact; unattested agent decisions are excluded | Tasks 2, 6, 10 |
| C6 dogfood sources were not frozen before registration | Added a canonical audit/trace inventory with refs/SHAs/bytes/run identities, bound by exact prereg ref/SHA and reverified without root rescans | Tasks 2, 6, 9 |
| C7 guard tests lacked literal WITH/WITHOUT values | Added the binding numeric witness table for every guard/mutation family, including provider calls 6/6/1 versus 138/138/23 | Tasks 1–10 |

Round 2 must inspect only these deltas, their finding mappings, and their side effects. It must not
re-litigate already-passed plan areas or promote new implementation-detail nice-to-haves.

### Round 2 — `FAIL`, addressed for final delta review

| Finding | Minimal correction incorporated | Owning task(s) |
|---|---|---|
| C3 routing was narrowed to `string \| null` | Replaced it with the existing strict `OpenRouterProviderRouting` structure and required canonical pre-adapter comparison of `only`, ordered `order`, and `allowFallbacks` | Tasks 2, 8 |
| C7 several witnesses remained symbolic/inequality-based and CLI flags counted 6 instead of 10 | Replaced threshold, inventory, Holm, interaction, replay, Stats, publication, attestation and atomicity rows with literal fixture values; required flags are now 10/10 versus 9/10 | Tasks 1–10 |

Round 3 is the final allowed plan-gate round. It checks only `20071b2` to the Round-2 fix commit,
these two mappings, and their side effects. Any remaining judgment call is escalated to Markus
instead of opening a fourth paper-perfection round.

### Round 3 — `PASS`

Final strict delta review found no remaining CRITICAL or WARN. C3 now binds the exact structural
OpenRouter routing contract and C7's witnesses are literal and recomputable, including inventory
`4 → 5`, Holm `[0.03,0.06,0.06] → [0.03,0.04,0.06]`, response consumption `12/12 → 11/12`,
atomic publication `1 → 2`, and required CLI flags `10/10 → 9/10`. The plan gate is closed; Task 1
is the next authorized implementation step.
