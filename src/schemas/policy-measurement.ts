import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../audit/canonical.ts";
import { POLICY_CATALOG_VERSION, POLICY_PASSES, POLICY_PASS_IDS } from "../core/policy/catalog.ts";
import {
  baselineProtectionEventKey,
  identityDirectionFromEvents,
  identityEventKey,
  identityOutcomesFromEvents,
  isStableWorsening,
  singletonIdentityDirectionFromEvents,
  singletonIdentityEventKey,
} from "../core/policy/identity-events.ts";
import {
  POLICY_MEASUREMENT_INTERACTIONS,
  POLICY_MEASUREMENT_LANES,
  POLICY_MEASUREMENT_STATEFUL_PASS_IDS,
  type PolicyClassification,
  type PolicyMeasurementLane,
} from "../core/policy/measurement-contract.ts";
import { classifyPolicyPasses } from "../stats/policy/classify.ts";
import {
  BenchPolicyProfileArtifactBindingSchema,
  PolicyBenchProfileArtifactSchema,
} from "./bench-result.ts";
import { PolicyProtectionCodeSchema } from "./policy-trace.ts";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/i);
const PolicyPassIdSchema = z.enum(POLICY_PASS_IDS);
const StatefulPolicyPassIdSchema = z.enum(POLICY_MEASUREMENT_STATEFUL_PASS_IDS);
const PolicyMeasurementLaneSchema = z.enum([
  "stateless-bench",
  "stateful-rig",
] as const satisfies readonly PolicyMeasurementLane[]);
const PolicyEvidenceLaneSchema = z.enum(["stateless-bench", "stateful-rig", "dogfood"]);
const PolicyClassificationValueSchema = z.enum([
  "retain",
  "delete-candidate",
  "harmful-candidate",
  "inconclusive",
] as const satisfies readonly PolicyClassification[]);
const ArtifactRefSchema = z
  .string()
  .min(1)
  .refine(
    (value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."),
  );

const ArtifactBindingSchema = z.object({ ref: ArtifactRefSchema, sha256: Sha256Schema }).strict();
/**
 * The exact preregistered paired comparison used to corroborate one singleton identity.  This is
 * deliberately a binding closure rather than a self-declared outcome label: the enclosing
 * measurement schema re-derives the registered group and every raw reference from interactions.
 */
const PolicyGroupComparisonSchema = z
  .object({
    pass_ids: z.array(PolicyPassIdSchema).min(2),
    artifact: ArtifactBindingSchema,
    raw_evidence: z.array(ArtifactBindingSchema).min(1),
  })
  .strict();
const PolicyIdentityDirectionSchema = z
  .object({
    lane: z.enum(["stateless-bench", "stateful-rig"]),
    units: z.number().int().nonnegative(),
    worsened: z.number().int().nonnegative(),
    improved: z.number().int().nonnegative(),
  })
  .strict();
const PolicyBaselineProtectionSchema = z
  .object({
    evidence: ArtifactBindingSchema,
    reason_code: z.string().min(1),
    protected_by: PolicyProtectionCodeSchema,
    before: z.enum(["INFO", "WARN", "ERROR", "CRITICAL"]),
  })
  .strict();
const PolicyIdentityEventSchema = z
  .object({
    lane: z.enum(["stateless-bench", "stateful-rig"]),
    unit: z.string().min(1),
    identity: z.string().min(1),
    direction: z.enum(["worsened", "improved"]),
    count: z.number().int().positive(),
    source: ArtifactBindingSchema,
    member_pass_id: PolicyPassIdSchema.optional(),
  })
  .strict();
const PolicySingletonIdentityEventSchema = z
  .object({
    lane: z.enum(["stateless-bench", "stateful-rig"]),
    unit: z.string().min(1),
    identity: z.string().min(1),
    direction: z.enum(["worsened", "improved"]),
    count: z.number().int().positive(),
    pass_id: PolicyPassIdSchema,
    source: ArtifactBindingSchema,
  })
  .strict();
const PolicyBaselineProtectionEventSchema = z
  .object({
    lane: z.enum(["stateless-bench", "stateful-rig"]),
    unit: z.string().min(1),
    identity: z.string().min(1),
    pass_id: PolicyPassIdSchema,
    result: z.literal("protected"),
    source: ArtifactBindingSchema,
    reason_code: z.string().min(1),
    protected_by: PolicyProtectionCodeSchema,
    before: z.enum(["INFO", "WARN", "ERROR", "CRITICAL"]),
  })
  .strict();
const PolicySingletonIdentityInventorySchema = z
  .object({
    raw_evidence: z.array(ArtifactBindingSchema).min(1),
    events: z.array(PolicySingletonIdentityEventSchema),
    protection_events: z.array(PolicyBaselineProtectionEventSchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    let previousEvent = "";
    for (const [index, event] of value.events.entries()) {
      const key = singletonIdentityEventKey(event);
      if (key <= previousEvent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["events", index],
          message: "singleton identity events must be code-unit sorted and unique",
        });
      }
      previousEvent = key;
    }
    let previousProtection = "";
    for (const [index, event] of value.protection_events.entries()) {
      const key = baselineProtectionEventKey(event);
      if (key <= previousProtection) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["protection_events", index],
          message: "baseline protection events must be code-unit sorted and unique",
        });
      }
      previousProtection = key;
    }
  });
const PolicyInteractionIdentityInventorySchema = z
  .object({
    raw_evidence: z.array(ArtifactBindingSchema).min(1),
    events: z.array(PolicyIdentityEventSchema),
    outcomes: z.array(
      z
        .object({
          identity: z.string().min(1),
          worsened: z.number().int().nonnegative(),
          improved: z.number().int().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    let previousEvent = "";
    for (const [index, event] of value.events.entries()) {
      const key = identityEventKey(event);
      if (key <= previousEvent) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["events", index],
          message: "interaction identity events must be code-unit sorted and unique",
        });
      }
      previousEvent = key;
    }
    let previous = "";
    for (const [index, outcome] of value.outcomes.entries()) {
      if (outcome.identity <= previous || (outcome.worsened === 0 && outcome.improved === 0)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["outcomes", index],
          message:
            "interaction identity outcomes must be code-unit sorted, unique, and non-vacuous",
        });
      }
      previous = outcome.identity;
    }
    if (canonicalJson(value.outcomes) !== canonicalJson(identityOutcomesFromEvents(value.events))) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcomes"],
        message: "interaction identity outcomes must be the exact projection of unit-level events",
      });
    }
  });
const LaneEligibilitySchema = z
  .object({ stateless: z.boolean(), stateful: z.boolean(), dogfood: z.boolean() })
  .strict();
const LaneAuthoritySchema = z
  .object({ stateless: z.boolean(), stateful: z.boolean(), dogfood: z.boolean() })
  .strict();
const CatalogSnapshotSchema = z
  .object({
    order: z.number().int().positive(),
    class: z.enum(["evidence", "value-judgment", "scope", "history"]),
    overlaps_with: z.array(PolicyPassIdSchema),
    opportunity_sha256: Sha256Schema,
  })
  .strict();
const OpportunitySchema = z
  .object({
    cases: z.number().int().nonnegative(),
    signatures: z.number().int().nonnegative(),
    turns: z.number().int().nonnegative(),
    runs: z.number().int().nonnegative(),
  })
  .strict();
const ExclusionSchema = z
  .object({
    lane: z.enum(["stateless", "stateful", "dogfood", "artifact"]),
    code: z.enum([
      "missing-decision",
      "incomplete-trace",
      "ambiguous-run-iter",
      "signature-absent-lineage",
      "historical-unsigned-decision",
      "post-registered-at",
      "not-run",
      "artifact-mismatch",
    ]),
    count: z.number().int().nonnegative(),
  })
  .strict();
const TruthCountsSchema = z
  .object({
    blocking_fp: z.number().int().nonnegative(),
    blocking_fn: z.number().int().nonnegative(),
    blocking_tp: z.number().int().nonnegative(),
  })
  .strict();
const TruthEffectsSchema = z
  .object({ baseline: TruthCountsSchema, ablated: TruthCountsSchema, error_reduction: z.number() })
  .strict();
const TraceTotalsSchema = z
  .object({
    applied: z.number().int().nonnegative(),
    would_apply: z.number().int().nonnegative(),
    protected: z.number().int().nonnegative(),
    no_opportunity: z.number().int().nonnegative(),
  })
  .strict();
const StatisticsSchema = z
  .object({
    raw_effects: z.array(z.number()),
    interval: z.object({ lo: z.number(), hi: z.number() }).strict(),
    p_value: z.number().min(0).max(1),
    adjusted_p_value: z.number().min(0).max(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.adjusted_p_value < value.p_value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["adjusted_p_value"],
        message: "adjusted p-value cannot be below raw p-value",
      });
    }
  });
function isCodeUnitSortedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => {
    const previous = values[index - 1];
    return index === 0 || (previous !== undefined && previous < value);
  });
}
function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameBindingList(
  left: readonly { ref: string; sha256: string }[],
  right: readonly { ref: string; sha256: string }[],
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (binding, index) =>
        binding.ref === right[index]?.ref && binding.sha256 === right[index]?.sha256,
    )
  );
}
function codeUnitSortedUnion(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}
function requireEligibleLaneAuthority(
  eligibility: z.infer<typeof LaneEligibilitySchema>,
  authority: z.infer<typeof LaneAuthoritySchema>,
  ctx: z.RefinementCtx,
  path: readonly (string | number)[],
): void {
  for (const lane of ["stateless", "stateful", "dogfood"] as const) {
    if (eligibility[lane] && !authority[lane]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, lane],
        message: "every eligible lane requires authoritative evidence",
      });
    }
  }
}
const CodeUnitSortedUniqueStrings = z.array(z.string().min(1)).superRefine((values, ctx) => {
  for (const [index, value] of values.entries()) {
    const previous = values[index - 1];
    if (previous !== undefined && previous >= value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [index],
        message: "values must be code-unit sorted and unique",
      });
    }
  }
});

const PolicyLaneSummarySchema = z
  .object({
    lane: PolicyEvidenceLaneSchema,
    primary: z.boolean(),
    descriptive: z.boolean(),
    eligible: z.literal(true),
    authoritative: z.literal(true),
    opportunities: OpportunitySchema,
    exclusions: z.array(ExclusionSchema),
    truth_effects: TruthEffectsSchema,
    trace_totals: TraceTotalsSchema,
    statistics: StatisticsSchema,
    raw_evidence_refs: CodeUnitSortedUniqueStrings,
  })
  .strict();

type PolicyLaneSummary = z.infer<typeof PolicyLaneSummarySchema>;

function expectedPassSummaryLanes(primaryLane: z.infer<typeof PolicyMeasurementLaneSchema>) {
  return primaryLane === "stateful-rig"
    ? (["stateless-bench", "stateful-rig", "dogfood"] as const)
    : (["stateless-bench", "dogfood"] as const);
}

function expectedInteractionPrimaryLane(
  passIds: readonly z.infer<typeof PolicyPassIdSchema>[],
): z.infer<typeof PolicyMeasurementLaneSchema> | undefined {
  const registered = POLICY_MEASUREMENT_INTERACTIONS.find((group) =>
    sameStringList(group, passIds),
  );
  if (registered === undefined) return undefined;
  return registered.every((passId) => POLICY_MEASUREMENT_LANES[passId] === "stateful-rig")
    ? "stateful-rig"
    : "stateless-bench";
}

function expectedInteractionSummaryLanes(primaryLane: z.infer<typeof PolicyMeasurementLaneSchema>) {
  return primaryLane === "stateful-rig"
    ? (["stateless-bench", "stateful-rig"] as const)
    : (["stateless-bench"] as const);
}

function requireLaneSummaries(input: {
  summaries: readonly PolicyLaneSummary[];
  primaryLane: z.infer<typeof PolicyMeasurementLaneSchema>;
  expectedLanes: readonly z.infer<typeof PolicyEvidenceLaneSchema>[];
  ctx: z.RefinementCtx;
  path: readonly (string | number)[];
}): void {
  if (
    input.summaries.length !== input.expectedLanes.length ||
    input.summaries.some((summary, index) => summary.lane !== input.expectedLanes[index])
  ) {
    input.ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...input.path],
      message: "lane summaries must be complete, unique, and in canonical lane order",
    });
    return;
  }
  for (const [index, summary] of input.summaries.entries()) {
    const primary = summary.lane === input.primaryLane;
    if (summary.primary !== primary || summary.descriptive === primary) {
      input.ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...input.path, index],
        message: "exactly the declared primary lane may be non-descriptive",
      });
    }
  }
}

export const PolicyDogfoodAdjudicationSchema = z
  .object({
    run_id: z.string().min(1),
    iter: z.number().int().positive(),
    finding_signature: z.string().min(1),
    disposition: z.enum(["tp", "fp"]),
  })
  .strict();

const DogfoodEvaluationResultSchema = z.enum([
  "no-opportunity",
  "no-match",
  "would-apply",
  "protected",
  "applied",
]);
const DogfoodSeveritySchema = z.enum(["CRITICAL", "WARN", "INFO"]);
const DogfoodEffectSchema = z.enum(["suppressed", "preserved", "none"]);

export function policyDogfoodEvaluationEffect(input: {
  result: z.infer<typeof DogfoodEvaluationResultSchema>;
  before: z.infer<typeof DogfoodSeveritySchema>;
  after: z.infer<typeof DogfoodSeveritySchema> | null;
}): z.infer<typeof DogfoodEffectSchema> {
  if (input.result === "protected") return "preserved";
  if (input.result !== "applied") return "none";
  if (input.after === null) return "suppressed";
  if (input.before === "CRITICAL" && input.after !== "CRITICAL") return "suppressed";
  if (input.before === "WARN" && input.after === "INFO") return "suppressed";
  return "none";
}

export const PolicyDogfoodInputManifestSchema = z
  .object({
    schema: z.literal("reviewgate.policy-dogfood-input-manifest.v1"),
    since: z.string().min(1),
    until: z.string().min(1),
    entries: z.array(
      z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("audit"),
            ref: ArtifactRefSchema,
            sha256: Sha256Schema,
            bytes: z.number().int().positive(),
            runs: z
              .array(
                z
                  .object({
                    run_id: z.string().min(1),
                    iter: z.number().int().positive(),
                    trace_ref: ArtifactRefSchema,
                    trace_sha256: Sha256Schema,
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
        z
          .object({
            kind: z.literal("trace"),
            ref: ArtifactRefSchema,
            audit_ref: ArtifactRefSchema,
            trace_ref: ArtifactRefSchema,
            sha256: Sha256Schema,
            bytes: z.number().int().positive(),
            run_id: z.string().min(1),
            iter: z.number().int().positive(),
          })
          .strict(),
      ]),
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = new Set<string>();
    let previous = "";
    for (const [index, entry] of value.entries.entries()) {
      if (entry.ref <= previous || keys.has(`${entry.kind}:${entry.ref}`)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries", index],
          message: "entries must be code-unit sorted and unique",
        });
      }
      previous = entry.ref;
      keys.add(`${entry.kind}:${entry.ref}`);
    }
    const traces = new Map<string, { sha256: string; runId: string; iter: number }>();
    const auditedRuns = new Map<
      string,
      {
        auditRef: string;
        traceRef: string;
        sha256: string;
        runId: string;
        iter: number;
      }
    >();
    for (const entry of value.entries) {
      if (entry.kind === "trace") {
        const key = `${entry.audit_ref}\u0000${entry.trace_ref}`;
        if (traces.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["entries"],
            message: "trace run identities must be unique",
          });
        }
        traces.set(key, { sha256: entry.sha256, runId: entry.run_id, iter: entry.iter });
      } else {
        let previousRun = "";
        const seenRuns = new Set<string>();
        for (const run of entry.runs) {
          const key = `${run.run_id}\u0000${run.iter}`;
          if (key <= previousRun || seenRuns.has(key) || auditedRuns.has(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["entries"],
              message: "audit run identities must be code-unit sorted and unique",
            });
          }
          previousRun = key;
          seenRuns.add(key);
          auditedRuns.set(key, {
            auditRef: entry.ref,
            traceRef: run.trace_ref,
            sha256: run.trace_sha256,
            runId: run.run_id,
            iter: run.iter,
          });
        }
      }
    }
    for (const [key, binding] of auditedRuns) {
      const trace = traces.get(`${binding.auditRef}\u0000${binding.traceRef}`);
      if (
        trace === undefined ||
        trace.sha256 !== binding.sha256 ||
        trace.runId !== binding.runId ||
        trace.iter !== binding.iter
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries"],
          message:
            "every audited run needs its exact unique trace inventory binding with the same run_id and iter",
        });
      }
    }
    for (const [traceKey] of traces) {
      if (
        ![...auditedRuns.values()].some(
          (binding) => `${binding.auditRef}\u0000${binding.traceRef}` === traceKey,
        )
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["entries"],
          message: "every trace needs an audit run binding",
        });
      }
    }
  });

export const PolicyDogfoodAttestationSchema = z
  .object({
    schema: z.literal("reviewgate.policy-dogfood-attestation.v1"),
    actor: z.string().min(1),
    attested_at: z.string().min(1),
    challenge_sha256: Sha256Schema,
    input_manifest_sha256: Sha256Schema,
    rows: z.array(PolicyDogfoodAdjudicationSchema).min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = new Set<string>();
    for (const [index, row] of value.rows.entries()) {
      const key = `${row.run_id}\u0000${row.iter}\u0000${row.finding_signature}`;
      if (keys.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rows", index],
          message: "adjudication rows must be unique",
        });
      }
      keys.add(key);
    }
  });

export const PolicyDogfoodSnapshotSchema = z
  .object({
    schema: z.literal("reviewgate.policy-dogfood-snapshot.v1"),
    input_manifest: ArtifactBindingSchema,
    attestation: ArtifactBindingSchema,
    labels: z.array(
      z
        .object({
          pass_id: PolicyPassIdSchema,
          run_id: z.string().min(1),
          iter: z.number().int().positive(),
          finding_signature: z.string().min(1),
          disposition: z.enum(["tp", "fp"]),
          evaluation_result: DogfoodEvaluationResultSchema,
          before: DogfoodSeveritySchema,
          after: DogfoodSeveritySchema.nullable(),
          protected_by: PolicyProtectionCodeSchema.optional(),
          effect: DogfoodEffectSchema,
          source_signatures: z
            .array(z.string().min(1))
            .min(1)
            .superRefine((values, ctx) => {
              for (let index = 1; index < values.length; index += 1) {
                if (!isCodeUnitSortedUnique(values)) {
                  ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: [index],
                    message: "values must be code-unit sorted and unique",
                  });
                }
              }
            }),
        })
        .strict()
        .superRefine((label, ctx) => {
          if ((label.evaluation_result === "protected") !== (label.protected_by !== undefined)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["protected_by"],
              message: "only a protected evaluation requires its exact protection authority",
            });
          }
          if (
            label.evaluation_result !== "applied" &&
            (label.after === null || label.after !== label.before)
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["after"],
              message: "a non-applied evaluation must preserve severity",
            });
          }
          if (
            label.effect !==
            policyDogfoodEvaluationEffect({
              result: label.evaluation_result,
              before: label.before,
              after: label.after,
            })
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["effect"],
              message: "dogfood effect must be derived from the exact verified evaluation",
            });
          }
        }),
    ),
    exclusions: z.record(z.number().int().nonnegative()),
  })
  .strict();

export const PolicyRigScenarioManifestSchema = z
  .object({
    schema: z.literal("reviewgate.policy-rig-scenarios.v1"),
    scenarios: z.array(
      z
        .object({
          id: z.string().min(1),
          pass_id: StatefulPolicyPassIdSchema,
          manifest: ArtifactBindingSchema,
          result: ArtifactBindingSchema,
          script: ArtifactBindingSchema,
          initial_state: ArtifactBindingSchema,
          expected_opportunity_turns: z.number().int().min(2),
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = new Set<string>();
    const artifactRefs = new Set<string>();
    const artifactHashes = new Set<string>();
    const counts = new Map<string, number>();
    for (const [index, scenario] of value.scenarios.entries()) {
      if (ids.has(scenario.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["scenarios", index, "id"],
          message: "scenario ids must be unique",
        });
      }
      ids.add(scenario.id);
      counts.set(scenario.pass_id, (counts.get(scenario.pass_id) ?? 0) + 1);
      for (const field of ["manifest", "result", "script"] as const) {
        const ref = scenario[field].ref;
        if (artifactRefs.has(ref)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["scenarios", index, field, "ref"],
            message: "independent scenarios must not reuse manifest, result, or script refs",
          });
        }
        artifactRefs.add(ref);
        const hash = scenario[field].sha256;
        if (artifactHashes.has(hash)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["scenarios", index, field, "sha256"],
            message: "independent scenarios must not reuse manifest, result, or script content",
          });
        }
        artifactHashes.add(hash);
      }
    }
    if (
      value.scenarios.length !== POLICY_MEASUREMENT_STATEFUL_PASS_IDS.length * 3 ||
      POLICY_MEASUREMENT_STATEFUL_PASS_IDS.some((passId) => counts.get(passId) !== 3) ||
      [...counts.keys()].some(
        (passId) => !POLICY_MEASUREMENT_STATEFUL_PASS_IDS.includes(passId as never),
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scenarios"],
        message: "manifest requires exactly three unique scenarios for each stateful pass",
      });
    }
  });

const PolicyRigOpportunitySchema = z
  .object({
    summary: z.number().int().nonnegative(),
    evaluations: z.number().int().nonnegative(),
    stages: z.number().int().nonnegative(),
    observed: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const observed = value.summary + value.evaluations + value.stages > 0;
    if (value.observed !== observed) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observed"],
        message: "opportunity observation must come from a summary, evaluation, or stage carrier",
      });
    }
  });

const PolicyRigStateEvidenceSchema = z
  .object({
    digest: Sha256Schema,
    implicit_outcomes: z.number().int().nonnegative(),
    history_reads: z.number().int().nonnegative(),
    history_writes: z.number().int().nonnegative(),
  })
  .strict();

const PolicyRigErrorIdentitySchema = z
  .object({
    kind: z.enum(["blocking-fp", "blocking-fn"]),
    identity: z.string().min(1),
  })
  .strict();

const PolicyRigErrorIdentitiesSchema = z
  .array(PolicyRigErrorIdentitySchema)
  .superRefine((rows, ctx) => {
    const keys = rows.map((row) => `${row.kind}\u0000${row.identity}`);
    if (!isCodeUnitSortedUnique(keys)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Rig error identities must be code-unit sorted and unique",
      });
    }
  });

const PolicyRigTurnEvidenceSchema = z
  .object({
    turn_index: z.number().int().positive(),
    opportunity: PolicyRigOpportunitySchema,
    baseline: z
      .object({
        truth: TruthCountsSchema,
        errors: PolicyRigErrorIdentitiesSchema,
        state: PolicyRigStateEvidenceSchema,
      })
      .strict(),
    counterfactual: z
      .object({
        truth: TruthCountsSchema,
        errors: PolicyRigErrorIdentitiesSchema,
        state: PolicyRigStateEvidenceSchema,
      })
      .strict(),
  })
  .strict();

const CATALOG_HISTORY_INTERACTION = POLICY_PASS_IDS.filter((passId) =>
  POLICY_MEASUREMENT_INTERACTIONS[2].includes(passId as never),
);

function sumTruthCounts(
  turns: readonly z.infer<typeof PolicyRigTurnEvidenceSchema>[],
  branch: "baseline" | "counterfactual",
): z.infer<typeof TruthCountsSchema> {
  return turns.reduce(
    (total, turn) => ({
      blocking_fp: total.blocking_fp + turn[branch].truth.blocking_fp,
      blocking_fn: total.blocking_fn + turn[branch].truth.blocking_fn,
      blocking_tp: total.blocking_tp + turn[branch].truth.blocking_tp,
    }),
    { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
  );
}

function refineRigProfile(
  value: {
    opportunity_turns: number;
    truth_effects: z.infer<typeof TruthEffectsSchema>;
    turns: z.infer<typeof PolicyRigTurnEvidenceSchema>[];
  },
  ctx: z.RefinementCtx,
): void {
  const opportunities = value.turns.filter((turn) => turn.opportunity.observed).length;
  if (opportunities !== value.opportunity_turns) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["opportunity_turns"],
      message: "opportunity turn count must equal the real trace carriers",
    });
  }
  const baseline = sumTruthCounts(value.turns, "baseline");
  const ablated = sumTruthCounts(value.turns, "counterfactual");
  const errorReduction =
    ablated.blocking_fp + ablated.blocking_fn - baseline.blocking_fp - baseline.blocking_fn;
  if (
    JSON.stringify(value.truth_effects.baseline) !== JSON.stringify(baseline) ||
    JSON.stringify(value.truth_effects.ablated) !== JSON.stringify(ablated) ||
    value.truth_effects.error_reduction !== errorReduction
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["truth_effects"],
      message: "profile truth effects must be the exact sum of its turn evidence",
    });
  }
  const indices = value.turns.map((turn) => turn.turn_index);
  if (!isCodeUnitSortedUnique(indices.map((index) => String(index).padStart(12, "0")))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["turns"],
      message: "turn evidence must be ordered and unique",
    });
  }
}

const PolicyRigInteractionEvidenceSchema = z
  .object({
    pass_ids: z.array(PolicyPassIdSchema),
    opportunity_turns: z.number().int().min(2),
    truth_effects: TruthEffectsSchema,
    turns: z.array(PolicyRigTurnEvidenceSchema).min(2),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!sameStringList(value.pass_ids, CATALOG_HISTORY_INTERACTION)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["pass_ids"],
        message: "history interaction evidence requires all four passes in catalog order",
      });
    }
    refineRigProfile(value, ctx);
  });

export const PolicyBenchBundleSchema = z
  .object({
    schema: z.literal("reviewgate.policy-bench-bundle.v1"),
    preregistration: ArtifactBindingSchema,
    profiles: z.array(
      z
        .object({
          id: z.string().min(1),
          ablated_pass_ids: z.array(PolicyPassIdSchema),
          artifact: BenchPolicyProfileArtifactBindingSchema,
          data: PolicyBenchProfileArtifactSchema,
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    const expected = [
      [] as string[],
      ...POLICY_PASS_IDS.map((passId) => [passId]),
      ...POLICY_MEASUREMENT_INTERACTIONS.map((group) => [...group]),
    ];
    if (
      bundle.profiles.length !== expected.length ||
      bundle.profiles.some((profile, index) => {
        const expectedAblations = expected[index];
        return (
          expectedAblations === undefined ||
          profile.ablated_pass_ids.length !== expectedAblations.length ||
          profile.ablated_pass_ids.some(
            (passId, passIndex) => passId !== expectedAblations[passIndex],
          )
        );
      })
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["profiles"],
        message: "bundle must contain the closed baseline/singleton/interaction profile inventory",
      });
    }
    const artifactHashes = new Set<string>();
    for (const [index, profile] of bundle.profiles.entries()) {
      const expectedId =
        index === 0
          ? "baseline"
          : index <= POLICY_PASS_IDS.length
            ? `single:${POLICY_PASS_IDS[index - 1]}`
            : `interaction:${index - POLICY_PASS_IDS.length}`;
      const canonicalData = canonicalJson(profile.data);
      const dataSha256 = createHash("sha256").update(canonicalData).digest("hex");
      if (
        profile.id !== expectedId ||
        profile.data.profile_id !== profile.id ||
        !sameStringList(profile.data.ablated_pass_ids, profile.ablated_pass_ids)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profiles", index],
          message: "profile id and ablation identity must match the closed schedule",
        });
      }
      if (
        profile.artifact.sha256 !== dataSha256 ||
        profile.artifact.ref !== `artifacts/policy-profiles/${dataSha256}.json` ||
        artifactHashes.has(dataSha256)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["profiles", index, "artifact"],
          message: "every profile requires one unique content-addressed immutable artifact",
        });
      }
      artifactHashes.add(dataSha256);
    }
    for (const repeatIndex of [0, 1, 2]) {
      const baseline = bundle.profiles[0]?.data.repeats[repeatIndex];
      for (const [profileIndex, profile] of bundle.profiles.entries()) {
        const repeat = profile.data.repeats[repeatIndex];
        if (
          baseline === undefined ||
          repeat === undefined ||
          repeat.response_manifest.ref !== baseline.response_manifest.ref ||
          repeat.response_manifest.sha256 !== baseline.response_manifest.sha256 ||
          repeat.policy_trace_set.ref !== baseline.policy_trace_set.ref ||
          repeat.policy_trace_set.sha256 !== baseline.policy_trace_set.sha256 ||
          !sameStringList(repeat.ordered_response_sha256, baseline.ordered_response_sha256) ||
          repeat.cases.some((row, caseIndex) => {
            const baselineCase = baseline.cases[caseIndex];
            return (
              baselineCase === undefined ||
              row.case_id !== baselineCase.case_id ||
              row.repeat !== baselineCase.repeat ||
              row.content_sha256 !== baselineCase.content_sha256
            );
          })
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["profiles", profileIndex, "data", "repeats", repeatIndex],
            message:
              "all profiles in one repeat must bind the same cases, ordered responses, and trace set",
          });
        }
      }
    }
  });

export const PolicyRigEvidenceSchema = z
  .object({
    schema: z.literal("reviewgate.policy-rig-evidence.v1"),
    scenario_manifest: ArtifactBindingSchema,
    manifest: PolicyRigScenarioManifestSchema,
    authoritative: z.literal(true),
    source_commit: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/),
    artifacts: z.array(
      ArtifactBindingSchema.extend({ kind: z.enum(["rig", "cassette", "trace", "state"]) }),
    ),
    artifact_inventory_sha256: Sha256Schema,
    sequences: z.array(
      z
        .object({
          scenario_id: z.string().min(1),
          pass_id: StatefulPolicyPassIdSchema,
          authoritative: z.literal(true),
          opportunity_turns: z.number().int().min(2),
          truth_effects: TruthEffectsSchema,
          turns: z.array(PolicyRigTurnEvidenceSchema).min(2),
          history_interaction: PolicyRigInteractionEvidenceSchema.nullable(),
          manifest: ArtifactBindingSchema,
          result: ArtifactBindingSchema,
          script: ArtifactBindingSchema,
          initial_state: ArtifactBindingSchema,
        })
        .strict(),
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      createHash("sha256").update(canonicalJson(value.artifacts)).digest("hex") !==
      value.artifact_inventory_sha256
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifact_inventory_sha256"],
        message: "Rig artifact inventory digest must bind the exact closed inventory",
      });
    }
    const artifactRefs = new Map<string, (typeof value.artifacts)[number]>();
    let previousArtifactRef = "";
    for (const [index, artifact] of value.artifacts.entries()) {
      if (artifact.ref <= previousArtifactRef || artifactRefs.has(artifact.ref)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["artifacts", index],
          message: "Rig artifact inventory must be code-unit sorted and unique",
        });
      }
      previousArtifactRef = artifact.ref;
      artifactRefs.set(artifact.ref, artifact);
    }
    const required = [
      { ...value.scenario_manifest, kind: "rig" as const },
      ...value.manifest.scenarios.flatMap((scenario) => [
        { ...scenario.manifest, kind: "rig" as const },
        { ...scenario.result, kind: "rig" as const },
        { ...scenario.script, kind: "rig" as const },
        { ...scenario.initial_state, kind: "state" as const },
      ]),
    ];
    for (const binding of required) {
      const artifact = artifactRefs.get(binding.ref);
      if (
        artifact === undefined ||
        artifact.sha256 !== binding.sha256 ||
        artifact.kind !== binding.kind
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["artifacts"],
          message: `Rig artifact inventory omits or changes ${binding.ref}`,
        });
      }
    }
    const declared = new Map(value.manifest.scenarios.map((scenario) => [scenario.id, scenario]));
    const ids = new Set<string>();
    for (const [index, sequence] of value.sequences.entries()) {
      const scenario = declared.get(sequence.scenario_id);
      if (
        ids.has(sequence.scenario_id) ||
        scenario === undefined ||
        sequence.pass_id !== scenario.pass_id ||
        sequence.manifest.ref !== scenario.manifest.ref ||
        sequence.manifest.sha256 !== scenario.manifest.sha256 ||
        sequence.result.ref !== scenario.result.ref ||
        sequence.result.sha256 !== scenario.result.sha256 ||
        sequence.script.ref !== scenario.script.ref ||
        sequence.script.sha256 !== scenario.script.sha256 ||
        sequence.initial_state.ref !== scenario.initial_state.ref ||
        sequence.initial_state.sha256 !== scenario.initial_state.sha256
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sequences", index],
          message:
            "sequence evidence must bind one declared scenario, pass, manifest, result, script, and initial state",
        });
      }
      const requiresInteraction = CATALOG_HISTORY_INTERACTION.includes(sequence.pass_id);
      if (requiresInteraction !== (sequence.history_interaction !== null)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sequences", index, "history_interaction"],
          message: "every applicable history sequence requires the four-pass interaction replay",
        });
      }
      refineRigProfile(sequence, ctx);
      ids.add(sequence.scenario_id);
    }
    if (
      value.sequences.length !== value.manifest.scenarios.length ||
      value.manifest.scenarios.some((scenario) => !ids.has(scenario.id))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sequences"],
        message: "evidence must cover the complete declared scenario manifest",
      });
    }
  });

const PolicyClassificationReasonSchema = z.enum([
  "unique-prevented-fp",
  "unique-preserved-tp",
  "required-backstop",
  "interaction-removal-harm",
  "two-ground-truth-harms",
  "ground-truth-plus-dogfood-harm",
  "sufficient-covered-zero-unique-benefit",
  "insufficient-opportunities",
  "incomplete-authority",
  "direction-conflict",
  "uncovered-benefit",
  "dogfood-only",
]);

export const PolicyPassEvidenceSchema = z
  .object({
    pass_id: PolicyPassIdSchema,
    lane: PolicyMeasurementLaneSchema,
    catalog_snapshot: CatalogSnapshotSchema,
    eligibility: LaneEligibilitySchema,
    authority: LaneAuthoritySchema,
    opportunities: OpportunitySchema,
    exclusions: z.array(ExclusionSchema),
    truth_effects: TruthEffectsSchema,
    trace_totals: TraceTotalsSchema,
    statistics: StatisticsSchema,
    unique_contributions: z.array(
      z
        .object({
          identity: z.string().min(1),
          kind: z.enum(["prevented-blocking-fp", "preserved-blocking-tp", "required-backstop"]),
          evidence: ArtifactBindingSchema,
          singleton_direction: PolicyIdentityDirectionSchema,
          group_direction: PolicyIdentityDirectionSchema,
          baseline_protection: PolicyBaselineProtectionSchema.optional(),
          group_comparison: PolicyGroupComparisonSchema,
        })
        .strict(),
    ),
    raw_evidence_refs: CodeUnitSortedUniqueStrings,
    lane_summaries: z.array(PolicyLaneSummarySchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    const pass = POLICY_PASSES.find((entry) => entry.id === value.pass_id);
    if (
      pass === undefined ||
      value.catalog_snapshot.order !== pass.order ||
      value.catalog_snapshot.class !== pass.class ||
      !sameStringList(value.catalog_snapshot.overlaps_with, pass.overlaps_with) ||
      value.catalog_snapshot.opportunity_sha256 !==
        createHash("sha256").update(pass.opportunity).digest("hex")
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["catalog_snapshot"],
        message: "pass evidence must carry the exact catalog authority snapshot",
      });
    }
    requireEligibleLaneAuthority(value.eligibility, value.authority, ctx, ["authority"]);
    const expectedPrimaryLane = POLICY_MEASUREMENT_LANES[value.pass_id];
    if (value.lane !== expectedPrimaryLane) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lane"],
        message: "pass primary lane must equal the catalog-derived measurement lane",
      });
    }
    requireLaneSummaries({
      summaries: value.lane_summaries,
      primaryLane: expectedPrimaryLane,
      expectedLanes: expectedPassSummaryLanes(expectedPrimaryLane),
      ctx,
      path: ["lane_summaries"],
    });
    requirePrimaryPassSummaryParity(value, expectedPrimaryLane, ctx);
    requireDogfoodSupplementaryOwnership(value, ctx);
    requirePassLaneRawRefDisjointness(value, ctx);
  });

const PolicyInteractionEvidenceSchema = z
  .object({
    authoritative: z.boolean(),
    eligibility: LaneEligibilitySchema,
    authority: LaneAuthoritySchema,
    opportunities: OpportunitySchema,
    exclusions: z.array(ExclusionSchema),
    truth_effects: TruthEffectsSchema,
    statistics: StatisticsSchema,
    raw_evidence_refs: CodeUnitSortedUniqueStrings,
  })
  .strict()
  .superRefine((value, ctx) => {
    requireEligibleLaneAuthority(value.eligibility, value.authority, ctx, ["authority"]);
  });

function requirePrimaryPassSummaryParity(
  value: z.infer<typeof PolicyPassEvidenceSchema>,
  expectedPrimaryLane: z.infer<typeof PolicyMeasurementLaneSchema>,
  ctx: z.RefinementCtx,
): void {
  const summary = value.lane_summaries.find((row) => row.lane === expectedPrimaryLane);
  if (summary === undefined) return;
  const directionsMatch =
    summary.primary === true &&
    summary.descriptive === false &&
    summary.lane === expectedPrimaryLane;
  // Dogfood runs and exclusions are deliberately supplementary to the selected Bench/Rig
  // classification evidence. Every other shared opportunity field is an exact projection.
  const opportunitiesMatch =
    summary.opportunities.cases === value.opportunities.cases &&
    summary.opportunities.signatures === value.opportunities.signatures &&
    summary.opportunities.turns === value.opportunities.turns;
  const measurementsMatch =
    canonicalJson(summary.truth_effects) === canonicalJson(value.truth_effects) &&
    canonicalJson(summary.trace_totals) === canonicalJson(value.trace_totals) &&
    canonicalJson(summary.statistics) === canonicalJson(value.statistics);
  if (!directionsMatch || !opportunitiesMatch || !measurementsMatch) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["lane_summaries"],
      message: "the catalog-selected primary summary must exactly project primary evidence",
    });
  }
}

function requireDogfoodSupplementaryOwnership(
  value: z.infer<typeof PolicyPassEvidenceSchema>,
  ctx: z.RefinementCtx,
): void {
  const dogfood = value.lane_summaries.find((summary) => summary.lane === "dogfood");
  if (dogfood === undefined) return;
  for (const [index, summary] of value.lane_summaries.entries()) {
    if (
      summary.lane !== "dogfood" &&
      (summary.opportunities.runs !== 0 || summary.exclusions.length !== 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lane_summaries", index],
        message: "only the Dogfood lane may carry supplementary runs or exclusions",
      });
    }
  }
  if (
    value.exclusions.some((exclusion) => exclusion.lane !== "dogfood") ||
    dogfood.opportunities.runs !== value.opportunities.runs ||
    canonicalJson(dogfood.exclusions) !== canonicalJson(value.exclusions)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["lane_summaries"],
      message: "the Dogfood lane must exactly own supplementary runs and exclusions",
    });
  }
}

function requirePassLaneRawRefDisjointness(
  value: z.infer<typeof PolicyPassEvidenceSchema>,
  ctx: z.RefinementCtx,
): void {
  // Bench, Rig, and Dogfood summaries originate from distinct closed artifact authorities. There
  // is intentionally no persisted shared-lane reference exception; interaction refs are aggregated
  // only in the enclosing top-level pass reference list.
  const owners = new Map<string, number>();
  for (const [summaryIndex, summary] of value.lane_summaries.entries()) {
    for (const ref of summary.raw_evidence_refs) {
      const owner = owners.get(ref);
      if (owner !== undefined && owner !== summaryIndex) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lane_summaries", summaryIndex, "raw_evidence_refs"],
          message: "pass lane summaries must not share raw evidence references",
        });
        continue;
      }
      owners.set(ref, summaryIndex);
    }
  }
}

function requirePrimaryInteractionSummaryParity(input: {
  evidence: z.infer<typeof PolicyInteractionEvidenceSchema>;
  summaries: readonly PolicyLaneSummary[];
  expectedPrimaryLane: z.infer<typeof PolicyMeasurementLaneSchema>;
  ctx: z.RefinementCtx;
}): void {
  const summary = input.summaries.find((row) => row.lane === input.expectedPrimaryLane);
  if (summary === undefined) return;
  const directionsMatch =
    summary.primary === true &&
    summary.descriptive === false &&
    summary.lane === input.expectedPrimaryLane;
  const opportunitiesMatch =
    canonicalJson(summary.opportunities) === canonicalJson(input.evidence.opportunities);
  const measurementsMatch =
    canonicalJson(summary.truth_effects) === canonicalJson(input.evidence.truth_effects) &&
    canonicalJson(summary.statistics) === canonicalJson(input.evidence.statistics) &&
    sameStringList(summary.raw_evidence_refs, input.evidence.raw_evidence_refs);
  if (!directionsMatch || !opportunitiesMatch || !measurementsMatch) {
    input.ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["lane_summaries"],
      message: "the registered primary interaction summary must exactly project its authority",
    });
  }
}

export const PolicyPassClassificationSchema = z
  .object({
    pass_id: PolicyPassIdSchema,
    classification: PolicyClassificationValueSchema,
    reasons: z.array(PolicyClassificationReasonSchema).min(1),
    vetoes: z.array(z.enum(["unique-prevented-fp", "unique-preserved-tp", "required-backstop"])),
    harm_observed: z.boolean(),
    evidence_refs: CodeUnitSortedUniqueStrings,
    evidence: PolicyPassEvidenceSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.pass_id !== value.evidence.pass_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence", "pass_id"],
        message: "classification evidence must bind its pass",
      });
    }
    if (!sameStringList(value.evidence_refs, value.evidence.raw_evidence_refs)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidence_refs"],
        message: "classification references must equal its evidence references",
      });
    }
  });

export const PolicyMeasurementInvalidityCodeSchema = z.enum([
  "source-not-clean",
  "preregistration-mismatch",
  "catalog-mismatch",
  "corpus-mismatch",
  "bench-profile-mismatch",
  "response-pair-mismatch",
  "trace-mismatch",
  "rig-state-mismatch",
  "rig-not-authoritative",
  "dogfood-mismatch",
  "correction-mismatch",
  "artifact-ref-invalid",
  "partial-inventory",
]);

export const PolicyMeasurementSchema = z
  .object({
    schema: z.literal("reviewgate.policy-measurement.v1"),
    preregistration: ArtifactBindingSchema,
    catalog_version: z.literal(POLICY_CATALOG_VERSION),
    passes: z.array(PolicyPassClassificationSchema),
    interactions: z.array(
      z
        .object({
          pass_ids: z.array(PolicyPassIdSchema),
          artifact: ArtifactBindingSchema,
          primary_lane: PolicyMeasurementLaneSchema,
          evidence: PolicyInteractionEvidenceSchema,
          lane_summaries: z.array(PolicyLaneSummarySchema),
          identity_inventory: PolicyInteractionIdentityInventorySchema,
        })
        .strict()
        .superRefine((value, ctx) => {
          const expectedPrimaryLane = expectedInteractionPrimaryLane(value.pass_ids);
          if (expectedPrimaryLane === undefined) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["pass_ids"],
              message: "interaction evidence must bind one registered interaction authority",
            });
            return;
          }
          if (value.primary_lane !== expectedPrimaryLane) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["primary_lane"],
              message: "interaction primary lane must equal its registered authority",
            });
          }
          requireLaneSummaries({
            summaries: value.lane_summaries,
            primaryLane: expectedPrimaryLane,
            expectedLanes: expectedInteractionSummaryLanes(expectedPrimaryLane),
            ctx,
            path: ["lane_summaries"],
          });
          requirePrimaryInteractionSummaryParity({
            evidence: value.evidence,
            summaries: value.lane_summaries,
            expectedPrimaryLane,
            ctx,
          });
        }),
    ),
    identity_evidence: z.array(
      z
        .object({
          pass_id: PolicyPassIdSchema,
          singleton_inventory: PolicySingletonIdentityInventorySchema,
          ground_truth_harms: z.array(
            z.object({ identity: z.string().min(1), evidence_ref: z.string().min(1) }).strict(),
          ),
          dogfood_dispositions: z.array(
            z
              .object({
                identity: z.string().min(1),
                run_id: z.string().min(1),
                iter: z.number().int().positive(),
                disposition: z.enum(["tp", "fp"]),
                effect: z.enum(["suppressed", "preserved", "none"]),
                evidence_ref: z.string().min(1),
              })
              .strict(),
          ),
          beneficial_effects: z.array(
            z
              .object({
                identity: z.string().min(1),
                evidence_ref: z.string().min(1),
                singleton_evidence: ArtifactBindingSchema,
                singleton_direction: PolicyIdentityDirectionSchema,
                group_direction: PolicyIdentityDirectionSchema,
                baseline_protection: PolicyBaselineProtectionSchema.optional(),
                group_comparison: PolicyGroupComparisonSchema.optional(),
                reproduced_by_pass_ids: z.array(PolicyPassIdSchema),
                reproducer_facts: z.array(
                  z
                    .object({
                      pass_id: PolicyPassIdSchema,
                      singleton_evidence: ArtifactBindingSchema,
                      singleton_direction: PolicyIdentityDirectionSchema,
                      group_direction: PolicyIdentityDirectionSchema,
                    })
                    .strict(),
                ),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
    artifacts: z
      .object({
        authoritative: z.literal(true),
        sources: z.array(ArtifactBindingSchema).min(1),
        exclusions: z.array(ExclusionSchema),
        evidence: z.array(ArtifactBindingSchema).min(1),
        inventory: z.array(ArtifactBindingSchema).min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((result, ctx) => {
    if (
      result.passes.length !== POLICY_PASS_IDS.length ||
      result.passes.some((row, index) => row.pass_id !== POLICY_PASS_IDS[index])
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["passes"],
        message: "authoritative measurements require every catalog pass in order",
      });
    }
    if (
      result.interactions.length !== POLICY_MEASUREMENT_INTERACTIONS.length ||
      result.interactions.some((row, index) => {
        const expectedGroup = POLICY_MEASUREMENT_INTERACTIONS[index];
        return (
          expectedGroup === undefined ||
          row.pass_ids.length !== expectedGroup.length ||
          row.pass_ids.some((passId, passIndex) => passId !== expectedGroup[passIndex])
        );
      })
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["interactions"],
        message: "authoritative measurements require every registered interaction",
      });
    }
    if (
      result.identity_evidence.length !== POLICY_PASS_IDS.length ||
      result.identity_evidence.some((row, index) => row.pass_id !== POLICY_PASS_IDS[index])
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["identity_evidence"],
        message: "identity evidence must cover every catalog pass in order",
      });
    }
    const inventory = new Map<string, (typeof result.artifacts.inventory)[number]>();
    let previous = "";
    for (const [index, artifact] of result.artifacts.inventory.entries()) {
      if (artifact.ref <= previous || inventory.has(artifact.ref)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["artifacts", "inventory", index],
          message: "global artifact inventory must be code-unit sorted and unique",
        });
      }
      previous = artifact.ref;
      inventory.set(artifact.ref, artifact);
    }
    const exactInventoryBinding = (binding: { ref: string; sha256: string }): boolean =>
      inventory.get(binding.ref)?.sha256 === binding.sha256;
    if (
      result.artifacts.sources.length !== result.artifacts.inventory.length ||
      result.artifacts.sources.some(
        (artifact, index) =>
          artifact.ref !== result.artifacts.inventory[index]?.ref ||
          artifact.sha256 !== result.artifacts.inventory[index]?.sha256,
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["artifacts", "sources"],
        message: "source artifacts must equal the exact closed global inventory",
      });
    }
    if (!exactInventoryBinding(result.preregistration)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["preregistration"],
        message: "preregistration binding must be present exactly in the global inventory",
      });
    }
    for (const [index, artifact] of result.artifacts.evidence.entries()) {
      if (!exactInventoryBinding(artifact)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["artifacts", "evidence", index],
          message: "evidence artifact must be present exactly in the global inventory",
        });
      }
    }
    for (const [index, interaction] of result.interactions.entries()) {
      if (!exactInventoryBinding(interaction.artifact)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["interactions", index, "artifact"],
          message: "interaction artifact must be present exactly in the global inventory",
        });
      }
      const expectedIdentityRefs = codeUnitSortedUnion([
        interaction.artifact.ref,
        ...interaction.evidence.raw_evidence_refs,
        ...interaction.lane_summaries.flatMap((summary) => summary.raw_evidence_refs),
      ]);
      const expectedIdentityBindings = expectedIdentityRefs.map((ref) => inventory.get(ref));
      if (
        expectedIdentityBindings.some((binding) => binding === undefined) ||
        !sameBindingList(
          interaction.identity_inventory.raw_evidence,
          expectedIdentityBindings.filter(
            (binding): binding is { ref: string; sha256: string } => binding !== undefined,
          ),
        )
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["interactions", index, "identity_inventory", "raw_evidence"],
          message:
            "interaction identity inventory must bind the exact sorted paired-comparison raw closure",
        });
      }
      for (const [eventIndex, event] of interaction.identity_inventory.events.entries()) {
        const source = inventory.get(event.source.ref);
        const sourceBound =
          source?.sha256 === event.source.sha256 &&
          interaction.identity_inventory.raw_evidence.some(
            (binding) => binding.ref === event.source.ref && binding.sha256 === event.source.sha256,
          );
        const laneValid = event.lane === interaction.primary_lane;
        const memberValid =
          event.lane === "stateful-rig"
            ? event.member_pass_id !== undefined &&
              interaction.pass_ids.includes(event.member_pass_id)
            : event.member_pass_id === undefined;
        if (!sourceBound || !laneValid || !memberValid) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["interactions", index, "identity_inventory", "events", eventIndex],
            message:
              "identity event must bind its exact closed primary-lane source and applicable member",
          });
        }
      }
      const outcomeDelta = interaction.identity_inventory.outcomes.reduce(
        (total, outcome) => total + outcome.worsened - outcome.improved,
        0,
      );
      const truthDelta =
        interaction.evidence.truth_effects.ablated.blocking_fp +
        interaction.evidence.truth_effects.ablated.blocking_fn -
        interaction.evidence.truth_effects.baseline.blocking_fp -
        interaction.evidence.truth_effects.baseline.blocking_fn;
      if (outcomeDelta !== truthDelta) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["interactions", index, "identity_inventory", "outcomes"],
          message:
            "interaction identity outcomes must exactly close the paired group ground-truth error delta",
        });
      }
    }
    for (const [index, facts] of result.identity_evidence.entries()) {
      const pass = result.passes.find((candidate) => candidate.pass_id === facts.pass_id);
      if (pass === undefined) continue;
      const expectedSingletonRefs = codeUnitSortedUnion(
        pass.evidence.lane_summaries
          .filter((summary) => summary.lane === pass.evidence.lane)
          .flatMap((summary) => summary.raw_evidence_refs),
      );
      const expectedSingletonBindings = expectedSingletonRefs.map((ref) => inventory.get(ref));
      if (
        expectedSingletonBindings.some((binding) => binding === undefined) ||
        !sameBindingList(
          facts.singleton_inventory.raw_evidence,
          expectedSingletonBindings.filter(
            (binding): binding is { ref: string; sha256: string } => binding !== undefined,
          ),
        )
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["identity_evidence", index, "singleton_inventory", "raw_evidence"],
          message: "singleton identity inventory must bind the exact primary-lane source closure",
        });
      }
      for (const [eventIndex, event] of facts.singleton_inventory.events.entries()) {
        const source = inventory.get(event.source.ref);
        if (
          event.pass_id !== facts.pass_id ||
          event.lane !== pass.evidence.lane ||
          source?.sha256 !== event.source.sha256 ||
          !facts.singleton_inventory.raw_evidence.some(
            (binding) => binding.ref === event.source.ref && binding.sha256 === event.source.sha256,
          )
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["identity_evidence", index, "singleton_inventory", "events", eventIndex],
            message:
              "singleton identity event must bind its exact pass, primary lane, and closed source",
          });
        }
      }
      const catalog = POLICY_PASSES.find((candidate) => candidate.id === facts.pass_id);
      for (const [eventIndex, event] of facts.singleton_inventory.protection_events.entries()) {
        const source = inventory.get(event.source.ref);
        if (
          event.pass_id !== facts.pass_id ||
          event.lane !== pass.evidence.lane ||
          source?.sha256 !== event.source.sha256 ||
          !facts.singleton_inventory.raw_evidence.some(
            (binding) => binding.ref === event.source.ref && binding.sha256 === event.source.sha256,
          ) ||
          !catalog?.protection_rules.some(
            (rule) =>
              rule.reason_code === event.reason_code &&
              rule.protected_by === event.protected_by &&
              rule.before === event.before,
          )
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [
              "identity_evidence",
              index,
              "singleton_inventory",
              "protection_events",
              eventIndex,
            ],
            message:
              "baseline protection event must bind an exact catalog protection in the primary-lane source",
          });
        }
      }
    }
    for (const [passIndex, pass] of result.passes.entries()) {
      const expectedRefs = codeUnitSortedUnion([
        ...pass.evidence.lane_summaries.flatMap((summary) => summary.raw_evidence_refs),
        ...result.interactions
          .filter((interaction) => interaction.pass_ids.includes(pass.pass_id))
          .flatMap((interaction) => [
            interaction.artifact.ref,
            ...interaction.evidence.raw_evidence_refs,
            ...interaction.lane_summaries.flatMap((summary) => summary.raw_evidence_refs),
          ]),
      ]);
      if (!sameStringList(pass.evidence.raw_evidence_refs, expectedRefs)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["passes", passIndex, "evidence", "raw_evidence_refs"],
          message:
            "top-level pass references must equal the exact union of lane and applicable interaction references",
        });
      }
    }
    const rawEvidenceRefs = [
      ...result.passes.flatMap((pass) => pass.evidence.raw_evidence_refs),
      ...result.passes.flatMap((pass) =>
        pass.evidence.lane_summaries.flatMap((summary) => summary.raw_evidence_refs),
      ),
      ...result.interactions.flatMap((interaction) => interaction.evidence.raw_evidence_refs),
      ...result.interactions.flatMap((interaction) =>
        interaction.lane_summaries.flatMap((summary) => summary.raw_evidence_refs),
      ),
    ];
    for (const [index, ref] of rawEvidenceRefs.entries()) {
      if (!inventory.has(ref)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["artifacts", "inventory"],
          message: `raw evidence ref is absent from the global artifact inventory: ${ref}`,
        });
      }
    }
    const comparisonBindings = (interaction: (typeof result.interactions)[number]) => {
      const refs = codeUnitSortedUnion([
        interaction.artifact.ref,
        ...interaction.evidence.raw_evidence_refs,
        ...interaction.lane_summaries.flatMap((summary) => summary.raw_evidence_refs),
      ]);
      const bindings = refs.map((ref) => inventory.get(ref));
      return bindings.some((binding) => binding === undefined)
        ? undefined
        : (bindings as Array<{ ref: string; sha256: string }>);
    };
    const sameComparison = (
      left: z.infer<typeof PolicyGroupComparisonSchema>,
      right: z.infer<typeof PolicyGroupComparisonSchema>,
    ): boolean =>
      sameStringList(left.pass_ids, right.pass_ids) &&
      left.artifact.ref === right.artifact.ref &&
      left.artifact.sha256 === right.artifact.sha256 &&
      sameBindingList(left.raw_evidence, right.raw_evidence);
    for (const [index, row] of result.identity_evidence.entries()) {
      for (const facts of [
        row.ground_truth_harms,
        row.dogfood_dispositions,
        row.beneficial_effects,
      ]) {
        let previousIdentity = "";
        for (const fact of facts) {
          if (fact.identity <= previousIdentity || !inventory.has(fact.evidence_ref)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["identity_evidence", index],
              message: "identity facts must be sorted, unique, and inventory-bound",
            });
            break;
          }
          previousIdentity = fact.identity;
        }
      }
      const pass = POLICY_PASSES.find((candidate) => candidate.id === row.pass_id);
      const measuredPass = result.passes.find((candidate) => candidate.pass_id === row.pass_id);
      const interaction = result.interactions.find((candidate) =>
        candidate.pass_ids.includes(row.pass_id),
      );
      for (const [benefitIndex, benefit] of row.beneficial_effects.entries()) {
        const comparison = benefit.group_comparison;
        const expectedBindings =
          interaction === undefined ? undefined : comparisonBindings(interaction);
        const expectedGroupDirection =
          interaction === undefined
            ? undefined
            : identityDirectionFromEvents({
                events: interaction.identity_inventory.events,
                identity: benefit.identity,
                lane: interaction.primary_lane,
                ...(interaction.primary_lane === "stateful-rig"
                  ? { memberPassId: row.pass_id }
                  : {}),
              });
        const expectedSingletonDirection = singletonIdentityDirectionFromEvents({
          events: row.singleton_inventory.events,
          identity: benefit.identity,
          lane: measuredPass?.evidence.lane ?? POLICY_MEASUREMENT_LANES[row.pass_id],
          passId: row.pass_id,
        });
        const singletonEvidenceValid =
          exactInventoryBinding(benefit.singleton_evidence) &&
          (benefit.reproduced_by_pass_ids.length === 0
            ? isStableWorsening(expectedSingletonDirection) &&
              row.singleton_inventory.events.some(
                (event) =>
                  event.identity === benefit.identity &&
                  event.pass_id === row.pass_id &&
                  event.source.ref === benefit.singleton_evidence.ref &&
                  event.source.sha256 === benefit.singleton_evidence.sha256,
              )
            : !isStableWorsening(expectedSingletonDirection) &&
              row.singleton_inventory.raw_evidence.some(
                (binding) =>
                  binding.ref === benefit.singleton_evidence.ref &&
                  binding.sha256 === benefit.singleton_evidence.sha256,
              ));
        const matchingProtection = row.singleton_inventory.protection_events.find(
          (event) =>
            event.identity === benefit.identity &&
            event.pass_id === row.pass_id &&
            event.lane === expectedSingletonDirection.lane,
        );
        const protectionValid =
          benefit.baseline_protection === undefined
            ? matchingProtection === undefined
            : pass !== undefined &&
              exactInventoryBinding(benefit.baseline_protection.evidence) &&
              matchingProtection !== undefined &&
              benefit.baseline_protection.evidence.ref === matchingProtection.source.ref &&
              benefit.baseline_protection.evidence.sha256 === matchingProtection.source.sha256 &&
              benefit.baseline_protection.reason_code === matchingProtection.reason_code &&
              benefit.baseline_protection.protected_by === matchingProtection.protected_by &&
              benefit.baseline_protection.before === matchingProtection.before &&
              pass.protection_rules.some(
                (rule) =>
                  rule.reason_code === benefit.baseline_protection?.reason_code &&
                  rule.protected_by === benefit.baseline_protection?.protected_by &&
                  rule.before === benefit.baseline_protection?.before,
              );
        const comparisonInvalid =
          (interaction !== undefined && comparison === undefined) ||
          (comparison !== undefined &&
            (interaction === undefined ||
              !singletonEvidenceValid ||
              benefit.evidence_ref !== benefit.singleton_evidence.ref ||
              !exactInventoryBinding(comparison.artifact) ||
              !sameStringList(comparison.pass_ids, interaction.pass_ids) ||
              comparison.artifact.ref !== interaction.artifact.ref ||
              comparison.artifact.sha256 !== interaction.artifact.sha256 ||
              expectedBindings === undefined ||
              !sameBindingList(comparison.raw_evidence, expectedBindings) ||
              expectedGroupDirection === undefined ||
              canonicalJson(benefit.singleton_direction) !==
                canonicalJson(expectedSingletonDirection) ||
              canonicalJson(benefit.group_direction) !== canonicalJson(expectedGroupDirection) ||
              benefit.singleton_direction.lane !== POLICY_MEASUREMENT_LANES[row.pass_id] ||
              !isStableWorsening(benefit.group_direction) ||
              !protectionValid));
        if (comparisonInvalid) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["identity_evidence", index, "beneficial_effects", benefitIndex],
            message:
              "benefit attribution must bind the exact singleton and applicable registered group comparison closure",
          });
        }
        const reproduced = benefit.reproduced_by_pass_ids;
        if (
          !sameStringList(
            benefit.reproducer_facts.map((fact) => fact.pass_id),
            reproduced,
          ) ||
          pass === undefined ||
          comparison === undefined ||
          reproduced.some((passId, passIndex) => {
            const reproducer = result.passes.find((candidate) => candidate.pass_id === passId);
            const contribution = reproducer?.evidence.unique_contributions.find(
              (candidate) => candidate.identity === benefit.identity,
            );
            return (
              (passIndex > 0 && passId <= (reproduced[passIndex - 1] ?? "")) ||
              !(pass.overlaps_with as readonly string[]).includes(passId) ||
              contribution === undefined ||
              !sameComparison(contribution.group_comparison, comparison) ||
              reproducer?.classification !== "retain" ||
              !isStableWorsening(contribution.singleton_direction) ||
              !isStableWorsening(contribution.group_direction) ||
              canonicalJson(benefit.reproducer_facts.find((fact) => fact.pass_id === passId)) !==
                canonicalJson({
                  pass_id: passId,
                  singleton_evidence: contribution.evidence,
                  singleton_direction: contribution.singleton_direction,
                  group_direction: contribution.group_direction,
                })
            );
          })
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["identity_evidence", index, "beneficial_effects", benefitIndex],
            message:
              "reproduction pass ids must be sorted, overlapping, and bind a retained singleton contribution in the same group comparison",
          });
        }
      }
      if (interaction !== undefined && measuredPass !== undefined) {
        const singletonIdentities = new Set(
          row.singleton_inventory.events.map((event) => event.identity),
        );
        for (const identity of singletonIdentities) {
          const singletonDirection = singletonIdentityDirectionFromEvents({
            events: row.singleton_inventory.events,
            identity,
            lane: measuredPass.evidence.lane,
            passId: row.pass_id,
          });
          const groupDirection = identityDirectionFromEvents({
            events: interaction.identity_inventory.events,
            identity,
            lane: interaction.primary_lane,
            ...(interaction.primary_lane === "stateful-rig" ? { memberPassId: row.pass_id } : {}),
          });
          if (
            isStableWorsening(singletonDirection) &&
            isStableWorsening(groupDirection) &&
            !row.beneficial_effects.some((benefit) => benefit.identity === identity)
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["identity_evidence", index, "beneficial_effects"],
              message:
                "every stable singleton loss corroborated by its registered group must remain source-bound in the identity dossier",
            });
          }
        }
      }
    }
    for (const [passIndex, pass] of result.passes.entries()) {
      for (const [
        contributionIndex,
        contribution,
      ] of pass.evidence.unique_contributions.entries()) {
        const facts = result.identity_evidence.find((row) => row.pass_id === pass.pass_id);
        const matchingBenefit = facts?.beneficial_effects.find(
          (benefit) => benefit.identity === contribution.identity,
        );
        const expectedKind =
          !isStableWorsening(contribution.singleton_direction) ||
          !isStableWorsening(contribution.group_direction)
            ? undefined
            : contribution.identity.includes(":blocking-fp:")
              ? contribution.baseline_protection === undefined
                ? "prevented-blocking-fp"
                : "required-backstop"
              : contribution.identity.includes(":blocking-fn:")
                ? "preserved-blocking-tp"
                : undefined;
        const protectionMatches =
          canonicalJson(matchingBenefit?.baseline_protection ?? null) ===
          canonicalJson(contribution.baseline_protection ?? null);
        if (
          !exactInventoryBinding(contribution.evidence) ||
          (contribution.baseline_protection !== undefined &&
            !exactInventoryBinding(contribution.baseline_protection.evidence)) ||
          expectedKind === undefined ||
          contribution.kind !== expectedKind ||
          matchingBenefit === undefined ||
          matchingBenefit.reproduced_by_pass_ids.length !== 0 ||
          matchingBenefit.evidence_ref !== contribution.evidence.ref ||
          matchingBenefit.evidence_ref !== matchingBenefit.singleton_evidence.ref ||
          canonicalJson(matchingBenefit.singleton_direction) !==
            canonicalJson(contribution.singleton_direction) ||
          canonicalJson(matchingBenefit.group_direction) !==
            canonicalJson(contribution.group_direction) ||
          !protectionMatches ||
          matchingBenefit.group_comparison === undefined ||
          !sameComparison(matchingBenefit.group_comparison, contribution.group_comparison)
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["passes", passIndex, "evidence", "unique_contributions", contributionIndex],
            message:
              "unique contribution must bind an unreproduced singleton identity and its exact group comparison",
          });
        }
      }
    }
    // The persisted recommendation is a projection, never a second authority. Re-running the
    // deterministic two-phase classifier over the closed identity facts prevents a serialized
    // retain/delete/veto/reason from changing the safety decision by declaration alone.
    const freshClassifications = classifyPolicyPasses(
      result.passes.map((row) => row.evidence),
      { passFacts: result.identity_evidence, interactions: result.interactions },
    );
    for (const [index, persisted] of result.passes.entries()) {
      const fresh = freshClassifications[index];
      if (
        fresh === undefined ||
        canonicalJson({
          classification: persisted.classification,
          reasons: persisted.reasons,
          vetoes: persisted.vetoes,
          harm_observed: persisted.harm_observed,
          evidence_refs: persisted.evidence_refs,
        }) !==
          canonicalJson({
            classification: fresh.classification,
            reasons: fresh.reasons,
            vetoes: fresh.vetoes,
            harm_observed: fresh.harm_observed,
            evidence_refs: fresh.evidence_refs,
          })
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["passes", index],
          message:
            "persisted policy classification must equal the deterministic two-phase closed-evidence result",
        });
      }
    }
  });

export type PolicyBenchBundle = z.infer<typeof PolicyBenchBundleSchema>;
export type PolicyRigScenarioManifest = z.infer<typeof PolicyRigScenarioManifestSchema>;
export type PolicyDogfoodSnapshot = z.infer<typeof PolicyDogfoodSnapshotSchema>;
export type PolicyDogfoodInputManifest = z.infer<typeof PolicyDogfoodInputManifestSchema>;
export type PolicyDogfoodAdjudication = z.infer<typeof PolicyDogfoodAdjudicationSchema>;
export type PolicyDogfoodAttestation = z.infer<typeof PolicyDogfoodAttestationSchema>;
export type PolicyRigEvidence = z.infer<typeof PolicyRigEvidenceSchema>;
export type PolicyPassEvidence = z.infer<typeof PolicyPassEvidenceSchema>;
export type PolicyPassClassification = z.infer<typeof PolicyPassClassificationSchema>;
export type PolicyMeasurementInvalidityCode = z.infer<typeof PolicyMeasurementInvalidityCodeSchema>;
export type PolicyMeasurement = z.infer<typeof PolicyMeasurementSchema>;
