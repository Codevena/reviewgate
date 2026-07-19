import { z } from "zod";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/i);

const OpenRouterRouteSchema = z
  .object({
    only: z.array(z.string()).optional(),
    order: z.array(z.string()).optional(),
    allowFallbacks: z.boolean().optional(),
  })
  .strict();

export const BenchPreregistrationSchema = z
  .object({
    schema: z.literal("reviewgate.bench.preregistration.v1"),
    registered_at: z.string(),
    release: z.string(),
    attempt: z.string().min(1),
    command: z.array(z.string()).min(3),
    roster: z
      .object({
        reviewers: z.array(
          z
            .object({
              provider: z.string(),
              model: z.string(),
              persona: z.string(),
            })
            .strict(),
        ),
        critic: z
          .object({
            provider: z.string(),
            model: z.string(),
            persona: z.string(),
            openrouter_provider: OpenRouterRouteSchema.nullable(),
          })
          .strict(),
        substitution_allowed: z.literal(false),
      })
      .strict(),
    corpus: z
      .object({
        path: z.string(),
        unique_cases: z.number().int().positive(),
        clean: z.number().int().positive(),
        seeded_bug: z.number().int().positive(),
        repeats: z.number().int().positive(),
        correlated_case_runs: z.number().int().positive(),
        manifest_sha256: Sha256Schema,
        content_sha256: z.record(Sha256Schema),
      })
      .strict(),
    hard_gates: z
      .object({
        maximum_provider_calls: z.number().int().positive(),
        // Optional for backwards compatibility with the already-frozen Attempt 01;
        // absent resolves to the historical single critic attempt.
        maximum_critic_attempts_per_eligible_case: z.number().int().positive().optional(),
        // Optional for backwards compatibility with attempts that allowed exactly
        // one physical reviewer invocation per configured reviewer/case.
        maximum_reviewer_attempts_per_case: z.number().int().positive().optional(),
        maximum_openrouter_output_tokens_per_call: z.number().int().positive(),
        maximum_failed_fraction: z.number().min(0).max(1),
        reviewer_coverage: z.literal(1),
        eligible_critic_coverage: z.literal(1),
        clean_repository_and_corpus: z.literal(true),
        immutable_artifacts: z.literal(true),
      })
      .strict(),
    rerun_policy: z
      .object({
        failed_attempts_are_preserved: z.literal(true),
        overwrite_allowed: z.literal(false),
        next_attempt_after_failure: z.string().min(1),
        favorable_repeat_selection_allowed: z.literal(false),
        alternative_rosters_require_separate_preregistration: z.literal(true),
      })
      .strict(),
  })
  // Descriptive estimands and source metadata may grow without weakening the
  // runtime-locked fields above.
  .passthrough();

export type BenchPreregistration = z.infer<typeof BenchPreregistrationSchema>;
