# Policy Accountability Trace & Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make all 18 outcome-changing review-policy passes observable and exactly ablatable without changing production findings, ordering, legacy markers, Markdown, counts, or verdicts.

**Architecture:** A static policy catalog and Zod-owned trace schema sit beside a fail-open in-memory recorder. Existing pass predicates remain where they are, but every material transition crosses one shared helper; Orchestrator owns the recorder lifecycle, AuditLogger persists the finished content-addressed trace, and Bench/Rig are the only callers allowed to supply internal ablations. Bench replays captured provider responses through the same production policy path; Rig validates captured traces and replays only from branch-isolated snapshots and cassette data.

**Tech Stack:** Bun, TypeScript with `exactOptionalPropertyTypes`, Zod, Biome, `bun:test`, JSONL audit chains, JSON state beneath `.reviewgate/`.

## Global Constraints

- Execute this plan only after the rig stale-report ownership fix and the project-scoped Stop-hook fix are merged and verified.
- Slice 1 changes telemetry and internal replay only; it must not delete policy or change thresholds, findings, markers, order, counts, verdicts, cache behavior, or `pending.md` bytes.
- Keep `REVIEW_OUTPUT_SCHEMA` unchanged; every policy field is server-authored.
- Do not add a gate/config/setup flag, environment variable, or top-level CLI subcommand for policy ablation.
- Only Bench/Rig construction paths may pass `policyAblations`; normal Gate, Setup, Config, and one-shot plan-review paths cannot source it from user configuration.
- Production telemetry is fail-open: trace errors never change the canonical finding or verdict.
- Authoritative Bench/Rig measurement is fail-closed: missing, invalid, corrupt, overflowed, cross-catalog, or response-mismatched traces exit `4`.
- Persist a complete trace only when canonical UTF-8 JSON is at most `1_048_576` bytes; never truncate, sample, or emit a summary-only trace artifact.
- Preserve legacy persisted artifacts through optional additive fields and the existing `reviewgate.pending.v1`, `reviewgate.audit.v1`, `reviewgate.bench.result.v1`, and `reviewgate.rig.result.v1` literals.
- Use Bun built-ins where they fit, `writeFileAtomic` for standalone artifacts, and the existing audit day partition for production policy traces.
- Every task follows red-green-refactor, mutation-proves its new guard red in a disposable copy, runs focused tests, and commits only its owned files.
- Before declaring Slice 1 complete, run `bunx tsc --noEmit`, `bun run lint`, full `bun test`, affected compiled-binary smoke tests, and the repository's independent review pipeline.
- Never stage the foreign `.reviewgate/lore/approvals.jsonl` change and never push without Markus' explicit permission.

---

## Preconditions and File Boundaries

### Preconditions to verify before Task 1

```bash
git log -1 --oneline -- docs/superpowers/specs/2026-08-07-rig-stale-report-design.md
node /Users/markus/.claude/scripts/verify-map.js
test ! -e .reviewgate/gate.lock
git status --short --branch
```

Expected: the stale-report implementation commit is present, the Trailhead reports `MAP OK`, no live gate lock exists, and only known user/foreign state is dirty.

### File structure locked by this plan

| File | Responsibility |
|---|---|
| `src/core/policy/catalog.ts` | Static IDs, order, class, actions, opportunity text, reason/protection codes, dependencies, overlaps, Slice-2 metric |
| `src/schemas/policy-trace.ts` | Zod contracts and semantic validation for effects, evaluations, summaries, stages, full trace, compact pending summary |
| `src/core/policy/trace.ts` | Fail-open recorder, transition helper, cluster lineage, stage recording, finalization |
| `src/core/policy/response-hashes.ts` | Ordered SHA-256 capture for raw reviewer/judge/critic response text |
| `src/core/policy/replay.ts` | Internal execution options, trace validation, baseline/counterfactual pairing, branch-state checks |
| `src/schemas/policy-replay.ts` | Strict Rig-only per-iteration replay envelope; no config or ablation controls |
| `src/core/policy/replay-capture.ts` | Contained external capture, lossless/redacted status, envelope hashing |
| `src/audit/canonical.ts` | One canonical JSON implementation shared by audit hashing and policy artifacts |
| `src/audit/policy-trace-store.ts` | Size check, safe content-addressed path, atomic write, reference/hash verification |
| Existing five pre-aggregation helpers | Keep current predicates and mutations; route their outcomes through the transition helper |
| `src/core/aggregator.ts` | Keep current pass order; instrument orders 60–180 plus cluster/verdict stages |
| `src/core/orchestrator.ts` | Create/finalize runtime, collect raw hashes, persist/report trace, expose in-memory trace to Bench/Rig |
| Bench modules | Run baseline and ablations under identical config/provider responses; validate traces authoritatively |
| Rig modules | Bind catalog/profile identity, validate captured traces, clone state into isolated replay branches |

Do not create 18 tiny pass files in Slice 1. Extraction waits until Slice 2 has measured and deleted policy.

## Closed Catalog Contract

Common evaluation reasons are `ineligible-starting-state`, `predicate-miss`, `configured-off`, and `stage-precondition-miss`. Pass-specific applied reasons and allowed protections are fixed below; unlisted strings fail schema validation.

| Pass | Opportunity | Applied reason | Allowed protection codes |
|---|---|---|---|
| `evidence.fact-location` | cited repo file is safely readable and the finding has a positive line | `location-out-of-range`, `evidence-line-reanchored` | none |
| `evidence.self-refutation` | blocking, non-deterministic finding | `terminal-self-refutation` | `security-correctness-floor`, `deterministic-ground-truth` |
| `judgment.hypothetical` | CRITICAL, non-deterministic finding | `hypothetical-critical` | `security-correctness-floor`, `deterministic-ground-truth` |
| `evidence.grounding-token` | CRITICAL with at least one extractable token | `cited-token-absent` | `security-correctness-floor` |
| `judgment.grounding-llm` | CRITICAL with a judge verdict for its signature | `judge-ungrounded` | `security-correctness-floor` |
| `evidence.redaction-placeholder` | blocking finding whose subject contains a redaction placeholder | `placeholder-code-hallucination` | `security-correctness-floor`, `secret-evidence-backstop` |
| `judgment.critic` | critic emitted a verdict for representative/member signature | `critic-likely-fp` | `claimed-fixed-pin`, `self-refutation-visibility`, `security-correctness-floor`, `corroborated-majority`, `corroborated-unanimous`, `high-precision-reviewer` |
| `scope.diff` | blocking finding has a usable line while changed ranges exist | `outside-changed-file`, `outside-changed-lines`, `preexisting-harness-config` | `out-of-diff-blocking-hatch` |
| `scope.delta` | blocking finding while a delta scope exists | `outside-delta-scope` | `claimed-fixed-pin`, `security-correctness-floor`, `critical-floor`, `out-of-diff-blocking-hatch` |
| `scope.session` | blocking finding while foreign-file facts exist | `foreign-to-session` | `out-of-diff-blocking-hatch` |
| `history.fp-signature` | blocking finding while an active signature snapshot exists | `active-fp-signature` | none |
| `history.cycle-rejected` | blocking finding while rejected signatures exist | `cycle-signature-rejected` | `critical-floor`, `security-correctness-floor` |
| `history.fp-cluster` | blocking finding while active cluster keys exist | `active-fp-cluster` | none |
| `judgment.confidence` | blocking, uncorroborated finding while floor is positive | `below-confidence-floor` | `claimed-fixed-pin`, `security-correctness-floor`, `corroborated-majority`, `corroborated-unanimous`, `high-precision-reviewer` |
| `judgment.reputation` | blocking, uncorroborated finding while unreliable reviewers exist | `unreliable-reviewer` | `claimed-fixed-pin`, `security-floor`, `correctness-demote-disabled`, `corroborated-majority`, `corroborated-unanimous`, `critical-floor` |
| `history.region-rejected` | blocking finding with a usable line while rejected regions exist | `rejected-region-overlap` | `claimed-fixed-pin`, `insufficient-distinct-rejections`, `category-change`, `severity-increase`, `critical-floor`, `security-correctness-floor` |
| `judgment.test-security` | blocking finding in a classified test/fixture file | `test-only-security` | `mixed-category-cluster` |
| `judgment.docs-cap` | CRITICAL finding in a classified docs file | `docs-critical-cap` | `security-correctness-floor` |

## Required 18-Pass Numeric Contract Matrix

Tuple order is `considered/opportunities/would_apply/applied/protected/blocking_removed/blocking_preserved/dropped`. Every row below also gets a configured-but-inactive assertion: `status:not-run`, the pass-specific closed `reason_code`, and no numeric fields.

| Pass | No opportunity | Predicate miss | Active | Ablated | Protection case | Blocking result |
|---|---|---|---|---|---|---|
| `evidence.fact-location` | unreadable WARN: `1/0/0/0/0/0/0/0` | valid line WARN: `1/1/0/0/0/0/0/0` | out-of-range WARN→INFO: `1/1/1/1/0/1/0/0` | same stays WARN: `1/1/1/0/0/0/1/0` | no guard | active `1→0`, ablated `1→1`; re-anchor variant is `1/1/1/1/0/0/1/0` |
| `evidence.self-refutation` | INFO: `1/0/0/0/0/0/0/0` | ordinary WARN: `1/1/0/0/0/0/0/0` | retracting WARN→INFO: `1/1/1/1/0/1/0/0` | same stays WARN: `1/1/1/0/0/0/1/0` | retracting correctness WARN: `1/1/1/0/1/0/1/0` | active `1→0`, ablated/protected `1→1` |
| `judgment.hypothetical` | WARN: `1/0/0/0/0/0/0/0` | present-defect CRITICAL: `1/1/0/0/0/0/0/0` | hypothetical CRITICAL→WARN: `1/1/1/1/0/0/1/0` | stays CRITICAL: `1/1/1/0/0/0/1/0` | hypothetical security CRITICAL: `1/1/1/0/1/0/1/0` | all remain blocking; severity must differ active vs ablated |
| `evidence.grounding-token` | tokenless WARN: `1/0/0/0/0/0/0/0` | present token CRITICAL: `1/1/0/0/0/0/0/0` | absent token CRITICAL→WARN: `1/1/1/1/0/0/1/0` | stays CRITICAL: `1/1/1/0/0/0/1/0` | absent-token security CRITICAL: `1/1/1/0/1/0/1/0` | all remain blocking; severity must differ |
| `judgment.grounding-llm` | CRITICAL without judge row: `1/0/0/0/0/0/0/0` | `grounded:true`: `1/1/0/0/0/0/0/0` | `grounded:false` CRITICAL→WARN: `1/1/1/1/0/0/1/0` | stays CRITICAL: `1/1/1/0/0/0/1/0` | ungrounded correctness CRITICAL: `1/1/1/0/1/0/1/0` | all remain blocking; severity must differ |
| `evidence.redaction-placeholder` | INFO placeholder: `1/0/0/0/0/0/0/0` | bland placeholder WARN: `1/1/0/0/0/0/0/0` | undefined-placeholder WARN→INFO: `1/1/1/1/0/1/0/0` | stays WARN: `1/1/1/0/0/0/1/0` | secret-word/security placeholder: `1/1/1/0/1/0/1/0` | active `1→0`, ablated/protected `1→1` |
| `judgment.critic` | signature omitted: `1/0/0/0/0/0/0/0` | critic `keep`: `1/1/0/0/0/0/0/0` | likely-FP WARN→INFO: `1/1/1/1/0/1/0/0` | stays WARN: `1/1/1/0/0/0/1/0` | majority WARN: `1/1/1/0/1/0/1/0` | active `1→0`, ablated/protected `1→1`; INFO-drop variant has `dropped:1` |
| `scope.diff` | line `0`: `1/0/0/0/0/0/0/0` | inside hunk WARN: `1/1/0/0/0/0/0/0` | outside hunk WARN→INFO: `1/1/1/1/0/1/0/0` | stays WARN: `1/1/1/0/0/0/1/0` | escaped category WARN: `1/1/1/0/1/0/1/0` | active `1→0`, ablated/protected `1→1` |
| `scope.delta` | INFO: `1/0/0/0/0/0/0/0` | file inside delta: `1/1/0/0/0/0/0/0` | outside-delta WARN→INFO: `1/1/1/1/0/1/0/0` | stays WARN: `1/1/1/0/0/0/1/0` | correctness WARN outside: `1/1/1/0/1/0/1/0` | active `1→0`, ablated/protected `1→1` |
| `scope.session` | INFO: `1/0/0/0/0/0/0/0` | owned WARN: `1/1/0/0/0/0/0/0` | foreign WARN→INFO: `1/1/1/1/0/1/0/0` | stays WARN: `1/1/1/0/0/0/1/0` | escaped category foreign WARN: `1/1/1/0/1/0/1/0` | active `1→0`, ablated/protected `1→1` |
| `history.fp-signature` | INFO: `1/0/0/0/0/0/0/0` | unknown WARN signature: `1/1/0/0/0/0/0/0` | active WARN signature→INFO: `1/1/1/1/0/1/0/0` | stays WARN: `1/1/1/0/0/0/1/0` | no guard | active `1→0`, ablated `1→1` |
| `history.cycle-rejected` | INFO: `1/0/0/0/0/0/0/0` | unknown WARN signature: `1/1/0/0/0/0/0/0` | rejected quality WARN→INFO: `1/1/1/1/0/1/0/0` | stays WARN: `1/1/1/0/0/0/1/0` | rejected correctness WARN: `1/1/1/0/1/0/1/0` | active `1→0`, ablated/protected `1→1` |
| `history.fp-cluster` | INFO: `1/0/0/0/0/0/0/0` | unknown cluster key: `1/1/0/0/0/0/0/0` | active cluster WARN→INFO: `1/1/1/1/0/1/0/0` | stays WARN: `1/1/1/0/0/0/1/0` | no guard | active `1→0`, ablated `1→1` |
| `judgment.confidence` | majority WARN: `1/0/0/0/0/0/0/0` | confidence at floor: `1/1/0/0/0/0/0/0` | low-confidence WARN→INFO: `1/1/1/1/0/1/0/0` | stays WARN: `1/1/1/0/0/0/1/0` | high-precision WARN: `1/1/1/0/1/0/1/0` | active `1→0`, ablated/protected `1→1`; CRITICAL clamp preserves blocking |
| `judgment.reputation` | majority WARN: `1/0/0/0/0/0/0/0` | reliable reviewer WARN: `1/1/0/0/0/0/0/0` | unreliable quality WARN→INFO: `1/1/1/1/0/1/0/0` | stays WARN: `1/1/1/0/0/0/1/0` | unreliable security WARN: `1/1/1/0/1/0/1/0` | active `1→0`, ablated/protected `1→1`; CRITICAL quality/correctness clamp preserves blocking |
| `history.region-rejected` | line `0`: `1/0/0/0/0/0/0/0` | no overlapping region: `1/1/0/0/0/0/0/0` | eligible overlap WARN→INFO: `1/1/1/1/0/1/0/0` | stays WARN: `1/1/1/0/0/0/1/0` | one-prior-reject overlap: `1/1/1/0/1/0/1/0` | active `1→0`, ablated/protected `1→1` |
| `judgment.test-security` | INFO test finding: `1/0/0/0/0/0/0/0` | quality WARN in test: `1/1/0/0/0/0/0/0` | security WARN in test→INFO: `1/1/1/1/0/1/0/0` | stays WARN: `1/1/1/0/0/0/1/0` | mixed security/correctness cluster: `1/1/1/0/1/0/1/0` | active `1→0`, ablated/protected `1→1` |
| `judgment.docs-cap` | WARN docs finding: `1/0/0/0/0/0/0/0` | quality CRITICAL in source: `1/1/0/0/0/0/0/0` | quality CRITICAL docs→WARN: `1/1/1/1/0/0/1/0` | stays CRITICAL: `1/1/1/0/0/0/1/0` | correctness CRITICAL docs: `1/1/1/0/1/0/1/0` | all remain blocking; severity must differ |

---

### Task 1: Static Catalog and Persisted Schemas

**Files:**
- Create: `src/core/policy/catalog.ts`
- Create: `src/schemas/policy-trace.ts`
- Modify: `src/schemas/finding.ts`
- Modify: `src/schemas/pending-report.ts`
- Modify: `src/schemas/audit-event.ts`
- Create: `tests/unit/policy-catalog.test.ts`
- Create: `tests/unit/policy-trace-schema.test.ts`
- Modify: `tests/unit/finding-schema.test.ts`
- Modify: `tests/unit/pending-report.test.ts`
- Modify: `tests/unit/run-summary-schema.test.ts`

**Interfaces:**
- Produces: `PolicyPassId`, `PolicyStageId`, `PolicyCatalogId`, `PolicyReasonCode`, `PolicyProtectionCode`, `PolicyEffectAction`, `POLICY_CATALOG_VERSION`, `POLICY_PASS_IDS`, `POLICY_PASSES`, `POLICY_STAGES`, `PolicyEffectSchema`, `PolicyEvaluationSchema`, `PolicyPassSummarySchema`, `PolicyStageEvaluationSchema`, `PolicyTraceFinalSchema`, `PolicyTraceSchema`, `PolicySummarySchema`.
- Consumers: all later tasks; no catalog entry executes dynamic code.

- [ ] **Step 1: Write the failing catalog and schema tests**

```ts
expect(POLICY_PASSES.map((p) => [p.order, p.id])).toEqual([
  [10, "evidence.fact-location"],
  [20, "evidence.self-refutation"],
  [30, "judgment.hypothetical"],
  [40, "evidence.grounding-token"],
  [50, "judgment.grounding-llm"],
  [60, "evidence.redaction-placeholder"],
  [70, "judgment.critic"],
  [80, "scope.diff"],
  [90, "scope.delta"],
  [100, "scope.session"],
  [110, "history.fp-signature"],
  [120, "history.cycle-rejected"],
  [130, "history.fp-cluster"],
  [140, "judgment.confidence"],
  [150, "judgment.reputation"],
  [160, "history.region-rejected"],
  [170, "judgment.test-security"],
  [180, "judgment.docs-cap"],
]);
expect(POLICY_STAGES.map((p) => p.id)).toEqual(["aggregation.cluster", "verdict.compute"]);
expect(PolicyPassSummarySchema.safeParse({
  pass_id: "judgment.confidence",
  status: "ran",
  considered: 1,
  opportunities: 1,
  would_apply: 1,
  applied: 2,
  protected: 0,
  blocking_removed: 1,
  blocking_preserved: 0,
  dropped: 0,
}).success).toBe(false);
expect(PolicyPassSummarySchema.safeParse({
  pass_id: "judgment.confidence",
  status: "not-run",
  reason_code: "configured-off",
  considered: 0,
}).success).toBe(false);
```

- [ ] **Step 2: Run the new tests and verify missing-module failures**

Run: `bun test tests/unit/policy-catalog.test.ts tests/unit/policy-trace-schema.test.ts`

Expected: FAIL because catalog/schema modules do not exist.

- [ ] **Step 3: Implement the catalog and strict semantic schemas**

Use discriminated unions for ran versus inactive summaries and a `superRefine` for counter relationships and complete/ref/hash invariants:

```ts
export const POLICY_CATALOG_VERSION = "reviewgate.policy-catalog.v1" as const;
export const POLICY_PASS_IDS = [
  "evidence.fact-location",
  "evidence.self-refutation",
  "judgment.hypothetical",
  "evidence.grounding-token",
  "judgment.grounding-llm",
  "evidence.redaction-placeholder",
  "judgment.critic",
  "scope.diff",
  "scope.delta",
  "scope.session",
  "history.fp-signature",
  "history.cycle-rejected",
  "history.fp-cluster",
  "judgment.confidence",
  "judgment.reputation",
  "history.region-rejected",
  "judgment.test-security",
  "judgment.docs-cap",
] as const;
export const PolicyPassIdSchema = z.enum(POLICY_PASS_IDS);
export const PolicyPassSummarySchema = z.discriminatedUnion("status", [
  RanPolicyPassSummarySchema,
  InactivePolicyPassSummarySchema,
]);
export const PolicyTraceSchema = z.object({
  schema: z.literal("reviewgate.policy-trace.v1"),
  catalog_version: z.literal(POLICY_CATALOG_VERSION),
  run_id: z.string(),
  iter: z.number().int().nonnegative(),
  ablated: z.array(PolicyPassIdSchema),
  raw_response_sha256: z.array(z.string().regex(/^[0-9a-f]{64}$/)),
  passes: z.array(PolicyPassSummarySchema),
  evaluations: z.array(PolicyEvaluationSchema),
  stages: z.array(PolicyStageEvaluationSchema),
  final: PolicyTraceFinalSchema,
}).strict();
```

Add optional `policy_effects` to `FindingSchema`, optional `policy_summary` to `PendingReportSchema`, and optional `policy_trace_status`, `policy_trace_ref`, `policy_trace_sha256` to `RunSummarySchema`. Keep every outer schema literal unchanged.

- [ ] **Step 4: Add compatibility and malicious-artifact tests**

Prove old fixtures parse, unknown pass/reason/protection/action fails, result counts cannot violate the catalog, `source_signatures` are sorted/deduplicated, and reviewer-controlled prose cannot occupy `reason_code`.

- [ ] **Step 5: Run focused schema tests**

Run: `bun test tests/unit/policy-catalog.test.ts tests/unit/policy-trace-schema.test.ts tests/unit/finding-schema.test.ts tests/unit/pending-report.test.ts tests/unit/run-summary-schema.test.ts`

Expected: PASS.

- [ ] **Step 6: Mutation-prove schema guards and commit**

In a disposable copy, remove `judgment.docs-cap`, permit `applied > would_apply`, and allow a free-form reason. Each mutation must make a named test fail. Restore, then commit:

```bash
git add src/core/policy/catalog.ts src/schemas/policy-trace.ts src/schemas/finding.ts src/schemas/pending-report.ts src/schemas/audit-event.ts tests/unit/policy-catalog.test.ts tests/unit/policy-trace-schema.test.ts tests/unit/finding-schema.test.ts tests/unit/pending-report.test.ts tests/unit/run-summary-schema.test.ts
git commit -m "feat(policy): define trace catalog and schemas"
```

### Task 2: Fail-Open Recorder and Transition Boundary

**Files:**
- Create: `src/core/policy/trace.ts`
- Create: `src/core/policy/response-hashes.ts`
- Create: `tests/unit/policy-trace-recorder.test.ts`
- Create: `tests/unit/policy-response-hashes.test.ts`

**Interfaces:**
- Consumes: catalog and schema types from Task 1.
- Produces: `PolicyRuntime`, `PolicyTraceRecorder`, `transitionFinding`, `mergePolicyEffects`, `OrderedResponseHashes`.

- [ ] **Step 1: Write recorder tests for every terminal result**

```ts
const warnFinding: Finding = {
  id: "F-001",
  signature: "sig-confidence",
  severity: "WARN",
  category: "quality",
  rule_id: "naming",
  file: "src/x.ts",
  line_start: 1,
  line_end: 1,
  message: "name is unclear",
  details: "rename the value",
  reviewer: { provider: "codex", model: "m", persona: "quality" },
  confidence: 0.2,
  consensus: "singleton",
};
const runtime = PolicyTraceRecorder.start({ runId: "run-1", iter: 1, ablated: [] });
const after = transitionFinding({
  runtime,
  passId: "judgment.confidence",
  finding: warnFinding,
  opportunity: true,
  matched: true,
  reasonCode: "below-confidence-floor",
  action: "demoted",
  proposed: () => ({ ...warnFinding, severity: "INFO", low_confidence: true }),
});
expect(after?.severity).toBe("INFO");
expect(runtime.summary("judgment.confidence")).toMatchObject({
  considered: 1,
  opportunities: 1,
  would_apply: 1,
  applied: 1,
  protected: 0,
  blocking_removed: 1,
  blocking_preserved: 0,
  dropped: 0,
});
```

Also assert `no-opportunity`, `no-match`, `protected`, `would-apply`, applied drop, applied re-anchor, deduplicated effects, ascending order, and final-signature linking.

- [ ] **Step 2: Verify the recorder tests fail**

Run: `bun test tests/unit/policy-trace-recorder.test.ts tests/unit/policy-response-hashes.test.ts`

Expected: FAIL because recorder classes do not exist.

- [ ] **Step 3: Implement a mutation-first transition helper**

The helper calculates the existing proposed result outside telemetry error handling. A recorder exception marks telemetry failed but returns the same proposed finding production would have returned; only an explicit internal ablation returns the original matched finding.

```ts
export interface TransitionInput {
  runtime?: PolicyRuntime;
  passId: PolicyPassId;
  finding: Finding;
  opportunity: boolean;
  matched: boolean;
  reasonCode: PolicyReasonCode;
  action: PolicyEffectAction;
  protectedBy?: PolicyProtectionCode;
  proposed: () => Finding | null;
}

export function transitionFinding(input: TransitionInput): Finding | null {
  if (!input.runtime) return input.matched && !input.protectedBy ? input.proposed() : input.finding;
  return input.runtime.transition(input);
}
```

`PolicyRuntime.transition` must catch only recorder/effect attachment failures, keep the pre-existing mutation result, record `telemetryError`, and never catch a predicate or proposal error that existing code would already surface.

- [ ] **Step 4: Implement deterministic response hashing**

`OrderedResponseHashes.record(kind, ordinal, rawText)` stores only `sha256(Buffer.from(rawText, "utf8"))` in deterministic logical-call order. Empty successful output hashes as SHA-256 of the empty byte string; thrown calls add no response.

- [ ] **Step 5: Run focused tests and mutation checks**

Mutate the helper to apply an ablated transition, omit an opportunity increment, swap effect order, and return the original on recorder failure. Each mutation must fail a specific test.

- [ ] **Step 6: Commit**

```bash
git add src/core/policy/trace.ts src/core/policy/response-hashes.ts tests/unit/policy-trace-recorder.test.ts tests/unit/policy-response-hashes.test.ts
git commit -m "feat(policy): add fail-open transition recorder"
```

### Task 3: Instrument the Five Pre-Aggregation Passes

**Files:**
- Modify: `src/core/fact-check.ts`
- Modify: `src/core/self-refutation.ts`
- Modify: `src/core/hypothetical-demote.ts`
- Modify: `src/core/grounding.ts`
- Modify: `src/core/critic.ts`
- Modify: `tests/unit/fact-check.test.ts`
- Modify: `tests/unit/fact-check-reanchor.test.ts`
- Modify: `tests/unit/self-refutation.test.ts`
- Modify: `tests/unit/hypothetical-demote.test.ts`
- Modify: `tests/unit/grounding.test.ts`
- Modify: `tests/unit/grounding-judge.test.ts`
- Modify: `tests/unit/critic-runner.test.ts`
- Create: `tests/unit/policy-preaggregation-contracts.test.ts`

**Interfaces:**
- Consumes: optional final `runtime?: PolicyRuntime` parameter on each pure pass.
- Produces: contract rows 10–50 and raw judge/critic response hashes.

- [ ] **Step 1: Add failing active/ablated/protected tests for orders 10–50**

For each of the first five matrix rows, call the existing exported function twice with identical inputs: a normal runtime and a runtime ablating only that pass. Strip `policy_effects` and assert the normal result equals the existing legacy fixture while the ablated result retains its starting severity.

```ts
const criticalQualityFinding: Finding = {
  id: "F-001",
  signature: "sig-grounding",
  severity: "CRITICAL",
  category: "quality",
  rule_id: "missing-token",
  file: "src/x.ts",
  line_start: 1,
  line_end: 1,
  message: "`theme.missingToken` is referenced",
  details: "the token is absent",
  reviewer: { provider: "codex", model: "m", persona: "quality" },
  confidence: 0.9,
  consensus: "singleton",
};
const activeRuntime = PolicyTraceRecorder.start({ runId: "active", iter: 1, ablated: [] });
const ablatedRuntime = PolicyTraceRecorder.start({
  runId: "ablated",
  iter: 1,
  ablated: ["evidence.grounding-token"],
});
const active = groundFindings([criticalQualityFinding], "export const present = true", activeRuntime);
const ablated = groundFindings([criticalQualityFinding], "export const present = true", ablatedRuntime);
expect(active[0]).toMatchObject({
  severity: "WARN",
  grounding_demoted: true,
  demoted_from_critical: true,
});
expect(ablated[0]).toMatchObject({ severity: "CRITICAL" });
expect(activeRuntime.summary("evidence.grounding-token")).toMatchObject({
  considered: 1, opportunities: 1, would_apply: 1, applied: 1, protected: 0,
  blocking_removed: 0, blocking_preserved: 1, dropped: 0,
});
```

- [ ] **Step 2: Verify red failures**

Run: `bun test tests/unit/policy-preaggregation-contracts.test.ts`

Expected: FAIL because the helpers cannot accept a policy runtime.

- [ ] **Step 3: Route existing predicates through `transitionFinding`**

Keep filesystem containment, regexes, prompts, parse logic, notes, marker fields, and call order unchanged. Extend signatures only at the final optional position:

```ts
validateFindingFacts(findings, repoRoot, deletedPaths, runtime?)
demoteSelfRefuting(findings, enabled, runtime?)
demoteHypotheticalCriticals(findings, enabled, runtime?)
groundFindings(findings, corpus, runtime?)
applyGroundingJudgeVerdicts(findings, map, runtime?)
```

Return raw response SHA-256 from `judgeGrounding` and `runCritic` as optional additive result fields; do not persist response text in the policy trace.

- [ ] **Step 4: Run all affected legacy and contract tests**

Run: `bun test tests/unit/fact-check.test.ts tests/unit/fact-check-reanchor.test.ts tests/unit/self-refutation.test.ts tests/unit/hypothetical-demote.test.ts tests/unit/grounding.test.ts tests/unit/grounding-judge.test.ts tests/unit/critic-runner.test.ts tests/unit/policy-preaggregation-contracts.test.ts`

Expected: PASS with legacy assertions unchanged after telemetry stripping.

- [ ] **Step 5: Mutation-prove and commit**

Mutate one security/correctness protection, one re-anchor action, and one raw-response hash return. Restore after each named test fails.

```bash
git add src/core/fact-check.ts src/core/self-refutation.ts src/core/hypothetical-demote.ts src/core/grounding.ts src/core/critic.ts tests/unit/fact-check.test.ts tests/unit/fact-check-reanchor.test.ts tests/unit/self-refutation.test.ts tests/unit/hypothetical-demote.test.ts tests/unit/grounding.test.ts tests/unit/grounding-judge.test.ts tests/unit/critic-runner.test.ts tests/unit/policy-preaggregation-contracts.test.ts
git commit -m "feat(policy): trace pre-aggregation decisions"
```

### Task 4: Instrument Redaction, Clustering, Critic, and Scope Passes

**Files:**
- Modify: `src/core/aggregator.ts`
- Modify: `tests/unit/aggregator-redaction-demote.test.ts`
- Modify: `tests/unit/aggregator-members.test.ts`
- Modify: `tests/unit/aggregator-critic.test.ts`
- Modify: `tests/unit/aggregator-scope.test.ts`
- Modify: `tests/unit/aggregator-claude-scope.test.ts`
- Modify: `tests/unit/aggregator-foreign-session.test.ts`
- Create: `tests/unit/policy-aggregator-first-half.test.ts`

**Interfaces:**
- Modify `AggregateInput` with optional `policyRuntime?: PolicyRuntime`.
- Produce orders 60–100 plus `aggregation.cluster` stage rows and final lineage links.

- [ ] **Step 1: Add failing matrix tests for orders 60–100 and cluster lineage**

Use one finding per numeric case so each expected tuple is exact. Add a two-reviewer cluster where one member was redaction-demoted before clustering; the final representative must carry the member effect with `source_signatures`, and both input signatures must link to the same `final_signature`.

- [ ] **Step 2: Verify red failures**

Run: `bun test tests/unit/policy-aggregator-first-half.test.ts`

Expected: FAIL because `AggregateInput` has no runtime and no effects/stages are emitted.

- [ ] **Step 3: Instrument without extracting policy into new pass modules**

Preserve the current sequence:

```text
redaction → normalize/sort → cluster → claimed-fixed pin → critic → diff scope → delta scope → session scope
```

Each existing branch supplies explicit `opportunity`, `matched`, applied reason, protection, action, and lazy `proposed` mutation to `transitionFinding`. Do not derive opportunity from whether a marker appeared afterward.

- [ ] **Step 4: Merge effects and record cluster stages deterministically**

The internal cluster accumulator keeps a separate `effects: PolicyEffect[]`; `mergePolicyEffects` sorts/deduplicates them before assigning the final representative. Record one `aggregation.cluster` stage row per output cluster, including singletons, then call `runtime.linkFinal(inputSignatures, representative.signature)`.

- [ ] **Step 5: Run affected aggregator suites**

Run: `bun test tests/unit/aggregator-redaction-demote.test.ts tests/unit/aggregator-members.test.ts tests/unit/aggregator-critic.test.ts tests/unit/aggregator-scope.test.ts tests/unit/aggregator-claude-scope.test.ts tests/unit/aggregator-foreign-session.test.ts tests/unit/policy-aggregator-first-half.test.ts`

Expected: PASS.

- [ ] **Step 6: Mutation-prove and commit**

Mutate critic drop attribution, scope protection, and member-effect propagation. Confirm each targeted test goes red, restore, and commit.

```bash
git add src/core/aggregator.ts tests/unit/aggregator-redaction-demote.test.ts tests/unit/aggregator-members.test.ts tests/unit/aggregator-critic.test.ts tests/unit/aggregator-scope.test.ts tests/unit/aggregator-claude-scope.test.ts tests/unit/aggregator-foreign-session.test.ts tests/unit/policy-aggregator-first-half.test.ts
git commit -m "feat(policy): trace clustering and scope decisions"
```

### Task 5: Instrument History, Confidence, Reputation, Category Caps, and Verdict

**Files:**
- Modify: `src/core/aggregator.ts`
- Modify: `tests/unit/aggregator-fp.test.ts`
- Modify: `tests/unit/aggregator-cycle-rejected.test.ts`
- Modify: `tests/unit/aggregator-fp-cluster.test.ts`
- Modify: `tests/unit/aggregator-confidence.test.ts`
- Modify: `tests/unit/aggregator-reputation.test.ts`
- Modify: `tests/unit/aggregator-region-rejected.test.ts`
- Modify: `tests/unit/aggregator-test-severity.test.ts`
- Modify: `tests/unit/aggregator-docs-cap.test.ts`
- Modify: `tests/unit/aggregator-protect-high-precision.test.ts`
- Create: `tests/unit/policy-aggregator-second-half.test.ts`

**Interfaces:**
- Consumes: Task 4 runtime threading.
- Produces: orders 110–180 and exactly one `verdict.compute` stage row.

- [ ] **Step 1: Add failing matrix tests for orders 110–180**

Encode every tuple from the matrix, including the protected cases and these blocking-preserving variants: low-confidence CRITICAL clamp, reputation CRITICAL quality clamp, reputation CRITICAL correctness corroboration clamp, and docs CRITICAL cap.

- [ ] **Step 2: Verify red failures**

Run: `bun test tests/unit/policy-aggregator-second-half.test.ts`

Expected: FAIL because no second-half trace rows exist.

- [ ] **Step 3: Instrument in the exact current order**

```text
FP signature → cycle rejection → FP cluster → confidence → reputation → region rejection → test security → docs cap → lone-critical tag → verdict
```

Protection is recorded on the attempted pass itself. Render-only `lone_critical_uncorroborated` remains outside the outcome-changing catalog.

- [ ] **Step 4: Record the verdict stage**

Emit one `verdict.compute` row after counts are final with sorted blocking signatures and one closed reason: `hard-critical`, `corroborated-warn`, `claimed-fixed-recurrence`, `blocking-present`, or `no-blocking-findings`.

- [ ] **Step 5: Run affected suites**

Run: `bun test tests/unit/aggregator-fp.test.ts tests/unit/aggregator-cycle-rejected.test.ts tests/unit/aggregator-fp-cluster.test.ts tests/unit/aggregator-confidence.test.ts tests/unit/aggregator-reputation.test.ts tests/unit/aggregator-region-rejected.test.ts tests/unit/aggregator-test-severity.test.ts tests/unit/aggregator-docs-cap.test.ts tests/unit/aggregator-protect-high-precision.test.ts tests/unit/policy-aggregator-second-half.test.ts`

Expected: PASS.

- [ ] **Step 6: Mutation-prove and commit**

Mutate FP-cluster attribution, the G0 clamp, a high-precision protection, and verdict reason selection; verify named failures and restore.

```bash
git add src/core/aggregator.ts tests/unit/aggregator-fp.test.ts tests/unit/aggregator-cycle-rejected.test.ts tests/unit/aggregator-fp-cluster.test.ts tests/unit/aggregator-confidence.test.ts tests/unit/aggregator-reputation.test.ts tests/unit/aggregator-region-rejected.test.ts tests/unit/aggregator-test-severity.test.ts tests/unit/aggregator-docs-cap.test.ts tests/unit/aggregator-protect-high-precision.test.ts tests/unit/policy-aggregator-second-half.test.ts
git commit -m "feat(policy): trace history and judgment decisions"
```

### Task 6: Orchestrator Lifecycle and Behavior-Neutral Equivalence

**Files:**
- Modify: `src/core/orchestrator.ts`
- Modify: `src/core/run-summary.ts`
- Create: `src/core/policy/replay.ts`
- Create: `tests/unit/orchestrator-policy-trace.test.ts`
- Create: `tests/integration/policy-trace-equivalence.test.ts`
- Modify: `tests/integration/run-summary-orchestrator.test.ts`

**Interfaces:**
- Add internal `PolicyExecutionOptions` with `trace: "off" | "memory" | "persist"`, `policyAblations: ReadonlySet<PolicyPassId>`, `authoritative: boolean`, and optional isolated state metadata.
- Add optional `policyTrace` and `policySummary` to `IterationResult`; these are server-owned and absent on legacy/non-policy paths.
- Add optional policy runtime parameters to `buildRunSummary` without changing legacy defaults.

- [ ] **Step 1: Write a failing trace-on/trace-off integration test**

Run the same deterministic adapter twice from byte-identical temporary repos. One uses `trace:"memory"`, one uses `trace:"off"`. Assert equal provider calls, raw response hashes, verdict, counts, order, legacy markers, and JSON after recursively stripping only `policy_effects`, `policy_summary`, and policy trace fields. Assert both rendered Markdown files are byte-identical.

- [ ] **Step 2: Verify the equivalence test fails**

Run: `bun test tests/integration/policy-trace-equivalence.test.ts`

Expected: FAIL because Orchestrator cannot construct/finalize a policy runtime.

- [ ] **Step 3: Create and thread one runtime on the full-panel path**

Create the recorder immediately before `validateFindingFacts`, pass it through all prepasses and `aggregate`, append reviewer hashes in configured slot order plus grounding/critic response hashes in logical call order, finalize after final findings/counts are known, and expose the validated trace in `IterationResult`.

Mode selection is closed and deterministic: omitted options plus an `AuditLogger` means `persist`
(the production Gate path); omitted options without an audit logger means `off` (legacy direct unit
construction); Bench/Rig explicitly request `memory` or `persist`. A memory-only run exposes the
full trace in `IterationResult` but omits `policy_summary` from its one-shot pending artifact until
Bench/Rig writes a real trace ref/hash of its own.

Every early skip/cache/check/error return uses `policy_trace_status:"not-run"` and emits no artifact reference. No trace fields enter cache keys or cached values.

- [ ] **Step 4: Enforce internal-only ablation plumbing**

`src/cli/commands/gate.ts`, `src/cli/commands/config.ts`, `src/cli/commands/setup.ts`, config schemas, and environment parsing must contain no mapping into `policyAblations`. Add a source-level guard test over those files and a runtime test showing ordinary gate construction uses an empty set.

- [ ] **Step 5: Run orchestrator and equivalence suites**

Run: `bun test tests/unit/orchestrator-policy-trace.test.ts tests/integration/policy-trace-equivalence.test.ts tests/integration/run-summary-orchestrator.test.ts tests/unit/orchestrator.test.ts tests/unit/orchestrator-raw-reviews.test.ts`

Expected: PASS.

- [ ] **Step 6: Mutation-prove and commit**

Mutate raw-response ordering, add a trace field to the cache key, and let a recorder error change one severity. Each named equivalence assertion must fail.

```bash
git add src/core/orchestrator.ts src/core/run-summary.ts src/core/policy/replay.ts tests/unit/orchestrator-policy-trace.test.ts tests/integration/policy-trace-equivalence.test.ts tests/integration/run-summary-orchestrator.test.ts
git commit -m "feat(policy): wire trace lifecycle through orchestration"
```

### Task 7: Content-Addressed Audit Persistence and Verification

**Files:**
- Create: `src/audit/canonical.ts`
- Create: `src/audit/policy-trace-store.ts`
- Modify: `src/audit/logger.ts`
- Modify: `src/audit/verifier.ts`
- Modify: `src/core/orchestrator.ts`
- Modify: `src/core/report-writer.ts`
- Modify: `src/core/loop-driver.ts`
- Create: `tests/unit/policy-trace-store.test.ts`
- Modify: `tests/unit/audit-logger.test.ts`
- Modify: `tests/unit/audit-logger-retention.test.ts`
- Modify: `tests/unit/audit-verify-corruption.test.ts`
- Modify: `tests/unit/report-writer.test.ts`

**Interfaces:**
- Produce `canonicalJson(value): string`, `writePolicyTrace(input): PolicyTraceWriteResult`, and `verifyPolicyTraceReference(input): PolicyTraceVerification`.
- `AuditLogger.writePolicyTrace` returns `{status, ref?, sha256?}` and never throws into verdict code.

- [ ] **Step 1: Write failing persistence, overflow, traversal, and tamper tests**

```ts
const stored = writePolicyTrace({ auditDir, trace, maxBytes: 1_048_576, now });
expect(stored).toMatchObject({ status: "complete", sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
expect(stored.ref).toMatch(/^2026\/08\/10\/policy\/[0-9a-f]{12}-i1-[0-9a-f]{12}\.json$/);
expect(verifyPolicyTraceReference({ auditDir, ref: stored.ref!, sha256: stored.sha256! }).ok).toBe(true);
```

Also assert a `1_048_577`-byte canonical artifact produces `overflow`, creates no policy file/temp file, and leaves ref/hash absent; a run ID of `../../escape` cannot affect the path; byte tampering fails verification.

- [ ] **Step 2: Verify red failures**

Run: `bun test tests/unit/policy-trace-store.test.ts tests/unit/audit-verify-corruption.test.ts`

Expected: FAIL because the store and reference verifier do not exist.

- [ ] **Step 3: Extract canonical JSON and implement atomic storage**

Move the identical sorted-key canonicalizer out of logger/verifier into `src/audit/canonical.ts`. Derive `run-sha12` from `sha256(run_id)`, derive `content-sha12` from canonical bytes, use the logger's UTC day partition, and write with `writeFileAtomic(destinationPath, canonicalBytes, { mode: 0o600 })` only after the complete size check.

- [ ] **Step 4: Bind trace status/ref/hash into pending and run.complete**

Persist before `writeReport`, attach the same compact `PolicySummary` to pending JSON, pass fields into `buildRunSummary`, and let LoopDriver's existing best-effort `run.complete` append bind them into the hash chain. Existing badge copy must be derived only for already-existing badge variants; legacy marker fallback remains and Markdown fixtures stay byte-identical.

- [ ] **Step 5: Extend chain verification and retention tests**

`verifyChain` validates any complete policy reference relative to the audit root, rejects missing/hash-mismatched/escaping files, and continues accepting legacy events. Day-partition deletion must remove its `policy/` child with no special case.

- [ ] **Step 6: Verify the 1 MiB limit with a worst-case synthetic trace**

Construct maximum-length allowed signatures and one evaluation for every configured pass across enough findings to cross the boundary. Assert the largest under-limit fixture is complete and the next evaluation causes overflow; record the exact evaluated byte sizes in the test names/output.

- [ ] **Step 7: Run focused suites and commit**

Run: `bun test tests/unit/policy-trace-store.test.ts tests/unit/audit-logger.test.ts tests/unit/audit-logger-retention.test.ts tests/unit/audit-verify-corruption.test.ts tests/unit/report-writer.test.ts tests/unit/pending-report.test.ts`

```bash
git add src/audit/canonical.ts src/audit/policy-trace-store.ts src/audit/logger.ts src/audit/verifier.ts src/core/orchestrator.ts src/core/report-writer.ts src/core/loop-driver.ts tests/unit/policy-trace-store.test.ts tests/unit/audit-logger.test.ts tests/unit/audit-logger-retention.test.ts tests/unit/audit-verify-corruption.test.ts tests/unit/report-writer.test.ts
git commit -m "feat(policy): persist and verify audit traces"
```

### Task 8: Exact Bench Ablation on Captured Responses

**Files:**
- Modify: `src/bench/runner.ts`
- Modify: `src/cli/commands/bench.ts`
- Modify: `src/schemas/bench-result.ts`
- Modify: `src/bench/report.ts`
- Modify: `tests/unit/bench-runner.test.ts`
- Modify: `tests/unit/bench-matrix.test.ts`
- Modify: `tests/unit/bench-result-schema.test.ts`
- Modify: `tests/unit/bench-report.test.ts`
- Modify: `tests/unit/bench-preregistration.test.ts`

**Interfaces:**
- `RunBenchCaseInput` gains internal `policyExecution?: PolicyExecutionOptions`.
- Matrix pass names resolve to catalog IDs; legacy aliases `critic`, `confidence-floor`, `reputation`, and `scope-to-diff` remain accepted and normalize to their catalog IDs.
- Produce `validateAuthoritativeTracePair(baseline, counterfactual)` returning exact invalidity reasons.

- [ ] **Step 1: Replace the confidence toggle test with a true internal ablation test**

The baseline and variant must use byte-identical effective config, including a still-enabled confidence floor. Only `policyAblations = new Set(["judgment.confidence"])` differs. Assert the same metric delta as the current test and identical ordered raw response hashes.

- [ ] **Step 2: Add authoritative invalidity tests**

Table-test missing pass row, missing trace, `error`, `overflow`, content hash mismatch, catalog mismatch, and raw response mismatch. Every case must return exit `4`, include the precise cause, and never turn missing counters into zero.

- [ ] **Step 3: Verify red failures**

Run: `bun test tests/unit/bench-matrix.test.ts tests/unit/bench-result-schema.test.ts`

Expected: FAIL because matrix still changes public suppressor config instead of ablating the production transition.

- [ ] **Step 4: Capture and replay every provider response once**

Extend the current capture wrappers to record both `review` and `complete` results. Baseline is the only live call path. Every variant replays exact stored raw text/result objects, recomputes request identity, and fails before scoring on a request or response mismatch. Do not run the critic live per variant.

- [ ] **Step 5: Persist trace provenance with matrix artifacts**

Each variant carries catalog version, normalized ablated pass ID, trace status/ref/hash, and ordered response hashes. Keep the existing immutable output checks and result SHA-256 references.

- [ ] **Step 6: Run Bench suites and mutation checks**

Run: `bun test tests/unit/bench-runner.test.ts tests/unit/bench-matrix.test.ts tests/unit/bench-result-schema.test.ts tests/unit/bench-report.test.ts tests/unit/bench-preregistration.test.ts`

Mutate the response comparison, configured-pass completeness check, and catalog comparison; each authoritative test must fail.

- [ ] **Step 7: Commit**

```bash
git add src/bench/runner.ts src/cli/commands/bench.ts src/schemas/bench-result.ts src/bench/report.ts tests/unit/bench-runner.test.ts tests/unit/bench-matrix.test.ts tests/unit/bench-result-schema.test.ts tests/unit/bench-report.test.ts tests/unit/bench-preregistration.test.ts
git commit -m "feat(bench): run exact policy ablations"
```

### Task 9: Rig Trace Validation and Branch-Isolated Replay

**Files:**
- Create: `src/schemas/policy-replay.ts`
- Create: `src/core/policy/replay-capture.ts`
- Modify: `src/schemas/rig-manifest.ts`
- Modify: `src/schemas/rig-result.ts`
- Modify: `src/cli/commands/gate.ts`
- Modify: `src/rig/driver.ts`
- Modify: `src/rig/harvest.ts`
- Modify: `src/rig/replay.ts`
- Modify: `src/rig/ablate.ts`
- Modify: `src/cli/commands/rig.ts`
- Create: `src/rig/policy-replay-state.ts`
- Modify: `tests/unit/rig-driver.test.ts`
- Modify: `tests/unit/rig-harvest.test.ts`
- Modify: `tests/unit/rig-replay.test.ts`
- Modify: `tests/unit/rig-ablate.test.ts`
- Create: `tests/unit/policy-replay-capture.test.ts`

**Interfaces:**
- Add optional manifest `policyReplay` metadata: catalog version, source commit, initial state snapshot ref/hash, and cassette hash.
- Add per-turn policy trace refs/statuses to RigResult without changing old artifact parsing.
- Produce strict `PolicyReplayEnvelopeSchema` with run/iteration identity, exact reviewed diff, policy-input findings, grounding corpus, aggregate inputs, state digest, ordered response hashes, and `lossless:boolean`.
- Produce `createReplayBranches(input)` returning separate baseline/counterfactual temporary checkouts with equal starting-state digests.

- [ ] **Step 1: Write failing branch-isolation tests**

Create a production-like repo with FP-ledger and reputation files. Build a baseline/counterfactual pair, mutate each branch independently, and assert the source repo bytes never change, initial digests match, later branch digests may diverge, and neither branch path aliases the source `.reviewgate/` directory.

- [ ] **Step 2: Add Rig invalidity tests**

Harvest/replay must exit `4` for missing/corrupt/overflow/cross-catalog traces and state-digest mismatch. Legacy runs remain harvestable but are explicitly non-authoritative for policy ablation rather than counted as zero opportunities.

- [ ] **Step 3: Verify red failures**

Run: `bun test tests/unit/policy-replay-capture.test.ts tests/unit/rig-replay.test.ts tests/unit/rig-harvest.test.ts`

Expected: FAIL because Rig currently checks only post-hoc determinism and four heuristic layers.

- [ ] **Step 4: Capture one exact envelope per gate iteration outside the measured repo**

`runRigRun` creates `<outDir>/policy-replay/`, realpath-confirms it is beneath the Rig output directory, and exports only `REVIEWGATE_RIG_REPLAY_DIR` to the driven agent process. Gate may use that variable solely to construct a capture sink; it never reads pass IDs or ablation controls from the environment. Orchestrator writes `<run-sha12>-i<iter>.json` mode `0600` containing the exact diff, post-review/pre-policy findings, grounding corpus, aggregate input sets/maps as sorted arrays, state digest, and response hashes.

Run every string leaf through the cassette's entropy redactor before persistence and compare pre/post canonical bytes. When redaction changes any policy-relevant byte, set `lossless:false`; Rig preserves the artifact for diagnosis but authoritative replay exits `4` rather than pretending it is exact. The envelope carries no credentials, raw environment, prompt text, config code, or free-form filesystem path.

- [ ] **Step 5: Record immutable replay identity without writing measured state**

At Rig start, copy the initial `.reviewgate` state into the result directory, hash it, record the source commit/catalog/cassette hash, and never write into the measured repo from replay code. Per turn, preserve the trace-bearing audit snapshot already copied by the driver.

- [ ] **Step 6: Implement isolated replay branches**

Use two temporary checkouts hydrated from the same source commit and each envelope's exact iteration diff, never the final turn diff as a substitute. Copy the same initial/previous-turn state snapshot into each branch, verify its digest, route all learning writes into that branch, and delete branches after use. Feed the envelope's exact policy inputs through the production pass functions; cassette responses are matched by ordered raw hash and no provider method may execute live. Baseline and counterfactual retain their own writes across a multi-turn sequence so downstream causal state divergence is measured rather than erased.

- [ ] **Step 7: Replace heuristic pass labels with catalog IDs**

Keep lore reporting separate because it is additive, not a demoter. Preserve the old four-layer output only as explicitly non-authoritative legacy analysis; exact policy rows come from validated traces and internal replay.

- [ ] **Step 8: Run Rig suites and mutation checks**

Run: `bun test tests/unit/policy-replay-capture.test.ts tests/unit/rig-driver.test.ts tests/unit/rig-harvest.test.ts tests/unit/rig-replay.test.ts tests/unit/rig-ablate.test.ts tests/unit/rig-preregistration.test.ts`

Mutate capture-path containment, lossless enforcement, exact iteration-diff selection, source-state containment, starting digest equality, and missing-trace handling; each test must fail.

- [ ] **Step 9: Commit**

```bash
git add src/schemas/policy-replay.ts src/core/policy/replay-capture.ts src/schemas/rig-manifest.ts src/schemas/rig-result.ts src/cli/commands/gate.ts src/rig/driver.ts src/rig/harvest.ts src/rig/replay.ts src/rig/ablate.ts src/cli/commands/rig.ts src/rig/policy-replay-state.ts tests/unit/policy-replay-capture.test.ts tests/unit/rig-driver.test.ts tests/unit/rig-harvest.test.ts tests/unit/rig-replay.test.ts tests/unit/rig-ablate.test.ts
git commit -m "feat(rig): validate and replay policy traces"
```

### Task 10: Cross-Pass Contract Harness and Completeness Mutations

**Files:**
- Create: `tests/fixtures/policy-pass-contracts.ts`
- Create: `tests/unit/policy-pass-contract-matrix.test.ts`
- Create: `tests/integration/policy-trace-offline-replay.test.ts`
- Create: `docs/dev/2026-08-10-policy-trace-mutation-evidence.md`

**Interfaces:**
- Produce `POLICY_PASS_CONTRACTS`, one fixture builder per catalogued pass, consumed only by tests.
- Consume the production transition path and Bench/Rig replay APIs; no shadow policy implementation is permitted in fixtures.

- [ ] **Step 1: Encode all 18 rows before touching any remaining production behavior**

```ts
for (const contract of POLICY_PASS_CONTRACTS) {
  it(`${contract.passId}: numeric contract`, async () => {
    const result = await contract.run();
    expect(result.noOpportunity).toEqual(contract.expected.noOpportunity);
    expect(result.noMatch).toEqual(contract.expected.noMatch);
    expect(result.active).toEqual(contract.expected.active);
    expect(result.ablated).toEqual(contract.expected.ablated);
    if (contract.expected.protected) expect(result.protected).toEqual(contract.expected.protected);
    expect(result.activeBlocking).toBe(contract.expected.activeBlocking);
    expect(result.ablatedBlocking).toBe(contract.expected.ablatedBlocking);
  });
}
```

The expected tuples and blocking results are copied literally from this plan's matrix; fixture builders call exported production passes/aggregate rather than reproducing predicates.

- [ ] **Step 2: Add four-class offline replay acceptance**

Use one deterministic evidence pass, value-judgment pass, scope pass, and stateful history pass. Assert complete traces, identical raw response hashes, correct active/ablated verdicts, no live provider calls in counterfactual runs, and no production-state writes.

- [ ] **Step 3: Run the complete contract tests**

Run: `bun test tests/unit/policy-pass-contract-matrix.test.ts tests/integration/policy-trace-offline-replay.test.ts`

Expected: PASS for all 18 pass IDs and both explanatory stages.

- [ ] **Step 4: Execute the required mutation dossier**

In disposable copies, perform and restore each mutation: remove a catalog entry; mutate without recording; omit opportunity increment; swap effect order; let ablated severity change; drop a member effect; skip raw hash comparison; accept tampered hash; coerce missing trace to zero; let persistence failure alter verdict. Record command, failing test name, and restored clean result in `docs/dev/2026-08-10-policy-trace-mutation-evidence.md`.

- [ ] **Step 5: Commit**

```bash
git add tests/fixtures/policy-pass-contracts.ts tests/unit/policy-pass-contract-matrix.test.ts tests/integration/policy-trace-offline-replay.test.ts docs/dev/2026-08-10-policy-trace-mutation-evidence.md
git commit -m "test(policy): prove all pass contracts and mutations"
```

### Task 11: Documentation, Full Verification, and Independent Review

**Files:**
- Modify: `docs/architecture.md`
- Modify: `TEST_PLAN.md`
- Modify: `NEXT_SESSION.md`
- Modify: `docs/superpowers/specs/2026-08-09-policy-accountability-trace-design.md`
- Modify: `AGENTS.md` only if entry-point paths changed materially

**Interfaces:**
- Document catalog ownership, trace location/status, authoritative-versus-production failure semantics, internal ablation boundary, and Slice-2 measurement limits.

- [ ] **Step 1: Update durable repository documentation**

Mark Slice 1 implemented with its final commit/test evidence. State explicitly that zero opportunities is not evidence of uselessness, Lore is excluded, stateful passes require seeded sequences, and no pass has yet been deleted.

- [ ] **Step 2: Run focused source-runtime tests once more**

```bash
bun test tests/unit/policy-catalog.test.ts tests/unit/policy-trace-schema.test.ts tests/unit/policy-trace-recorder.test.ts tests/unit/policy-pass-contract-matrix.test.ts tests/integration/policy-trace-equivalence.test.ts tests/integration/policy-trace-offline-replay.test.ts tests/unit/bench-matrix.test.ts tests/unit/rig-replay.test.ts tests/unit/audit-verify-corruption.test.ts
```

Expected: all pass, zero fail.

- [ ] **Step 3: Run mandatory repository verification**

```bash
bunx tsc --noEmit
bun run lint
bun test
```

Expected: Typecheck and lint clean; full suite has zero failures.

- [ ] **Step 4: Build and smoke the compiled CLI paths**

```bash
bun run build
./dist/reviewgate bench matrix --help
./dist/reviewgate rig replay --help
./dist/reviewgate audit --help
```

Expected: build succeeds and each affected command exits normally with usage text. Do not run a live provider benchmark in this verification step.

- [ ] **Step 5: Run the repository's independent review pipeline**

Review the complete implementation diff against the approved spec and this plan. Resolve every CRITICAL/WARN through the normal Reviewgate decision protocol; require a final PASS before completion.

- [ ] **Step 6: Update Brain and commit the handoff**

Persist final commit, exact suite counts, mutation evidence, remaining Slice-2 work, and any measured limit change in `/Users/markus/Documents/Brain/02 Projekte/Aktiv/ReviewGate.md` plus the current daily note.

```bash
git add docs/architecture.md TEST_PLAN.md NEXT_SESSION.md docs/superpowers/specs/2026-08-09-policy-accountability-trace-design.md AGENTS.md
git commit -m "docs: hand off policy trace slice one"
```

Do not stage `AGENTS.md` if it did not require a real entry-point change. Do not push.

## Execution Handoff

This plan is deliberately sequential: Tasks 1–7 establish the trusted trace, Task 8 makes Bench authoritative, Task 9 makes Rig state-safe, and Tasks 10–11 prove completeness. Execute one task per fresh review gate and stop if either prerequisite reliability fix is still absent.
