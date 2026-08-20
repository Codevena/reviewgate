import { z } from "zod";
import {
  POLICY_CATALOG_VERSION,
  POLICY_PASS_IDS,
  type PolicyPassId,
} from "../core/policy/catalog.ts";
import {
  POLICY_MEASUREMENT_INTERACTIONS,
  POLICY_MEASUREMENT_THRESHOLDS,
} from "../core/policy/measurement-contract.ts";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/i);
const PolicyPassIdSchema = z.enum(POLICY_PASS_IDS);
const PositiveBoundedAttemptsSchema = z.number().int().min(1).max(3);
const PositiveBoundedOutputSchema = z.number().int().min(1).max(32_768);
const ProviderCallCeilingSchema = z.number().int().min(1).max(1_000_000);

/** Runtime equivalent of OpenRouterProviderRouting, persisted without provider-specific defaults. */
export const OpenRouterProviderRoutingSchema = z
  .object({
    only: z.array(z.string().min(1)).min(1).optional(),
    order: z.array(z.string().min(1)).min(1).optional(),
    allowFallbacks: z.boolean().optional(),
  })
  .strict()
  .superRefine((route, ctx) => {
    if (route.only === undefined && route.order === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "OpenRouter route requires a non-empty only or order route",
      });
    }
    for (const [key, values] of [
      ["only", route.only],
      ["order", route.order],
    ] as const) {
      if (values !== undefined && new Set(values).size !== values.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} must be unique`,
        });
      }
    }
  });

const RoutedProviderSchema = z
  .object({
    provider: z.string().min(1),
    model: z.string().min(1),
    persona: z.string().min(1),
    openrouter_provider: OpenRouterProviderRoutingSchema.nullable(),
  })
  .strict()
  .superRefine((provider, ctx) => {
    if ((provider.provider === "openrouter") !== (provider.openrouter_provider !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["openrouter_provider"],
        message: "OpenRouter routing is present exactly for an OpenRouter provider",
      });
    }
  });

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasExactGroups(
  actual: readonly (readonly string[])[],
  expected: readonly (readonly string[])[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((group, index) => {
      const expectedGroup = expected[index];
      return expectedGroup !== undefined && sameStringList(group, expectedGroup);
    })
  );
}

function isRepoRelativeDescendant(path: string, root: string): boolean {
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return false;
  }
  return path.startsWith(`${root}/`);
}

export const PolicyMeasurementPreregistrationSchema = z
  .object({
    schema: z.literal("reviewgate.policy-measurement.preregistration.v1"),
    registered_at: z.string().min(1),
    release: z.string().min(1),
    attempt: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    source: z
      .object({
        ref: z.string().min(1),
        runner: z.literal("dist/reviewgate"),
        require_exact_clean_head_containing_this_file: z.literal(true),
        require_compiled_runner_sha256: z.literal(true),
      })
      .strict(),
    catalog_version: z.literal(POLICY_CATALOG_VERSION),
    pass_ids: z.array(PolicyPassIdSchema),
    corpus: z
      .object({
        path: z.string().min(1),
        unique_cases: z.literal(30),
        clean: z.literal(16),
        seeded_bug: z.literal(14),
        repeats: z.literal(POLICY_MEASUREMENT_THRESHOLDS.repeats),
        manifest_sha256: Sha256Schema,
        content_sha256: z.record(Sha256Schema),
      })
      .strict(),
    roster: z
      .object({
        reviewers: z.array(RoutedProviderSchema).min(1),
        critic: RoutedProviderSchema.nullable(),
        substitution_allowed: z.literal(false),
      })
      .strict(),
    execution: z
      .object({
        reviewer_max_attempts: PositiveBoundedAttemptsSchema,
        critic_max_attempts: PositiveBoundedAttemptsSchema,
        max_output_tokens: PositiveBoundedOutputSchema,
      })
      .strict(),
    profiles: z
      .object({
        singleton: z.array(z.array(PolicyPassIdSchema)),
        interactions: z.array(z.array(PolicyPassIdSchema)),
      })
      .strict(),
    stateful: z
      .object({
        manifest_ref: z.string().min(1),
        manifest_sha256: Sha256Schema,
        min_sequences_per_pass: z.literal(POLICY_MEASUREMENT_THRESHOLDS.statefulSequences),
        min_opportunity_turns: z.literal(POLICY_MEASUREMENT_THRESHOLDS.opportunityTurnsPerSequence),
      })
      .strict(),
    dogfood: z
      .object({
        since: z.string().min(1),
        until: z.string().min(1),
        input_manifest_ref: z.string().min(1),
        input_manifest_sha256: Sha256Schema,
        attestation_ref: z.string().min(1),
        attestation_sha256: Sha256Schema,
        min_dispositions: z.literal(POLICY_MEASUREMENT_THRESHOLDS.dogfoodDispositions),
        min_runs: z.literal(POLICY_MEASUREMENT_THRESHOLDS.dogfoodRuns),
      })
      .strict(),
    analysis: z
      .object({
        stateless_min_cases: z.literal(POLICY_MEASUREMENT_THRESHOLDS.statelessCases),
        stateless_min_signatures: z.literal(POLICY_MEASUREMENT_THRESHOLDS.statelessSignatures),
        bootstrap_resamples: z.literal(POLICY_MEASUREMENT_THRESHOLDS.bootstrapResamples),
        seed: z.number().int(),
        primary: z.literal("ground_truth_error"),
        interval: z.literal("percentile-bootstrap-95"),
        correction: z
          .object({ singleton: z.literal("holm-18"), interaction: z.literal("holm-4") })
          .strict(),
        candidate_rules: z.literal("safety-first-two-phase-v1"),
        vetoes: z.tuple([
          z.literal("unique-prevented-fp"),
          z.literal("unique-preserved-tp"),
          z.literal("required-backstop"),
        ]),
      })
      .strict(),
    hard_gates: z
      .object({
        maximum_provider_calls: ProviderCallCeilingSchema,
        maximum_failed_fraction: z.literal(0),
        reviewer_coverage: z.literal(1),
        eligible_critic_coverage: z.literal(1),
        immutable_artifacts: z.literal(true),
        no_variant_provider_calls: z.literal(true),
      })
      .strict(),
    outputs: z
      .object({
        attempt_dir: z.string().min(1),
        bench_bundle: z.string().min(1),
        rig_bundle: z.string().min(1),
        dogfood_snapshot: z.string().min(1),
        result_json: z.string().min(1),
        report_md: z.string().min(1),
      })
      .strict(),
    commands: z
      .object({
        bench: z.array(z.string().min(1)).min(1),
        stats: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    rerun_policy: z
      .object({
        failed_attempts_are_preserved: z.literal(true),
        overwrite_allowed: z.literal(false),
        favorable_repeat_selection_allowed: z.literal(false),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    if (!sameStringList(value.pass_ids, POLICY_PASS_IDS)) {
      issue(["pass_ids"], "pass_ids must be the exact ordered policy catalog inventory");
    }
    const expectedCaseRefs = [
      ...Array.from(
        { length: 16 },
        (_, index) => `cases/clean-${String(index + 1).padStart(2, "0")}.json`,
      ),
      ...Array.from(
        { length: 14 },
        (_, index) => `cases/seeded-${String(index + 1).padStart(2, "0")}.json`,
      ),
    ];
    if (!sameStringList(Object.keys(value.corpus.content_sha256).sort(), expectedCaseRefs.sort())) {
      issue(
        ["corpus", "content_sha256"],
        "content hashes must bind exactly the 16 clean and 14 seeded canonical cases",
      );
    }
    const singleton = POLICY_PASS_IDS.map((passId) => [passId]);
    if (!hasExactGroups(value.profiles.singleton, singleton)) {
      issue(
        ["profiles", "singleton"],
        "singleton profiles must be one ordered row per catalog pass",
      );
    }
    if (!hasExactGroups(value.profiles.interactions, POLICY_MEASUREMENT_INTERACTIONS)) {
      issue(
        ["profiles", "interactions"],
        "interaction profiles must match the registered groups exactly",
      );
    }
    if (value.dogfood.until !== value.registered_at) {
      issue(["dogfood", "until"], "dogfood cutoff must equal registered_at");
    }
    const root = `bench/results/policy-measurement/${value.attempt}`;
    if (value.outputs.attempt_dir !== root) {
      issue(["outputs", "attempt_dir"], "attempt_dir must be the registered measurement root");
    }
    const outputEntries = Object.entries(value.outputs);
    if (
      outputEntries.some(
        ([name, path]) => name !== "attempt_dir" && !isRepoRelativeDescendant(path, root),
      )
    ) {
      issue(
        ["outputs"],
        "every output must be a repo-relative descendant of the attempt directory",
      );
    }
    if (new Set(outputEntries.map(([, path]) => path)).size !== outputEntries.length) {
      issue(["outputs"], "measurement outputs must have unique paths");
    }
  });

export type PolicyMeasurementPreregistration = z.infer<
  typeof PolicyMeasurementPreregistrationSchema
>;
export type PolicyMeasurementPreregisteredPassId = PolicyPassId;
