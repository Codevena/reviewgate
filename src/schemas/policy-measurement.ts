import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson } from "../audit/canonical.ts";
import { POLICY_CATALOG_VERSION, POLICY_PASSES, POLICY_PASS_IDS } from "../core/policy/catalog.ts";
import {
  POLICY_MEASUREMENT_INTERACTIONS,
  POLICY_MEASUREMENT_STATEFUL_PASS_IDS,
  type PolicyClassification,
  type PolicyMeasurementLane,
} from "../core/policy/measurement-contract.ts";
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
    trace_totals: z
      .object({
        applied: z.number().int().nonnegative(),
        would_apply: z.number().int().nonnegative(),
        protected: z.number().int().nonnegative(),
        no_opportunity: z.number().int().nonnegative(),
      })
      .strict(),
    statistics: StatisticsSchema,
    unique_contributions: z.array(
      z
        .object({
          kind: z.enum(["prevented-blocking-fp", "preserved-blocking-tp", "required-backstop"]),
          evidence: ArtifactBindingSchema,
        })
        .strict(),
    ),
    raw_evidence_refs: CodeUnitSortedUniqueStrings,
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
          evidence: PolicyInteractionEvidenceSchema,
        })
        .strict(),
    ),
    identity_evidence: z.array(
      z
        .object({
          pass_id: PolicyPassIdSchema,
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
                reproduced_by_pass_ids: z.array(PolicyPassIdSchema),
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
    }
    const rawEvidenceRefs = [
      ...result.passes.flatMap((pass) => pass.evidence.raw_evidence_refs),
      ...result.interactions.flatMap((interaction) => interaction.evidence.raw_evidence_refs),
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
      for (const benefit of row.beneficial_effects) {
        const reproduced = benefit.reproduced_by_pass_ids;
        const pass = POLICY_PASSES.find((candidate) => candidate.id === row.pass_id);
        if (
          pass === undefined ||
          reproduced.some((passId, passIndex) => {
            const reproducer = result.identity_evidence.find(
              (candidate) => candidate.pass_id === passId,
            );
            return (
              (passIndex > 0 && passId <= (reproduced[passIndex - 1] ?? "")) ||
              !(pass.overlaps_with as readonly string[]).includes(passId) ||
              !reproducer?.beneficial_effects.some(
                (candidate) => candidate.identity === benefit.identity,
              )
            );
          })
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["identity_evidence", index, "beneficial_effects"],
            message: "reproduction pass ids must be sorted, overlapping, and identity-corroborated",
          });
        }
      }
    }
    for (const [passIndex, pass] of result.passes.entries()) {
      for (const [
        contributionIndex,
        contribution,
      ] of pass.evidence.unique_contributions.entries()) {
        if (!exactInventoryBinding(contribution.evidence)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["passes", passIndex, "evidence", "unique_contributions", contributionIndex],
            message: "unique contribution must bind exact global inventory bytes",
          });
        }
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
