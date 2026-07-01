import { z } from "zod";

// reviewgate bench — result schema (spec §5, §7.2). What `bench run` writes and
// `bench report` reads. Every rate carries its raw numerator/denominator + a Wilson
// CI (§5.2), and the provenance block pins the run so results are comparable (§7.2).

/** A rate reported with its raw counts and a Wilson 95% CI; value/CI are null when den=0. */
export const MetricSchema = z
  .object({
    num: z.number().int().nonnegative(),
    den: z.number().int().nonnegative(),
    value: z.number().min(0).max(1).nullable(),
    ci_lo: z.number().min(0).max(1).nullable(),
    ci_hi: z.number().min(0).max(1).nullable(),
  })
  .strict()
  // Reject internally inconsistent rates so an invalid headline number can never
  // pass validation: num≤den; den=0 ⇒ value/CI all null; den>0 ⇒ value/CI all
  // present, value=num/den, and ci_lo≤value≤ci_hi.
  .superRefine((m, ctx) => {
    if (m.num > m.den) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "num must be <= den", path: ["num"] });
    }
    if (m.den === 0) {
      if (m.value !== null || m.ci_lo !== null || m.ci_hi !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "den=0 requires null value/ci_lo/ci_hi",
          path: ["value"],
        });
      }
      return;
    }
    if (m.value === null || m.ci_lo === null || m.ci_hi === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "den>0 requires non-null value/ci_lo/ci_hi",
        path: ["value"],
      });
      return;
    }
    if (Math.abs(m.value - m.num / m.den) > 1e-9) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "value must equal num/den",
        path: ["value"],
      });
    }
    if (m.ci_lo > m.value || m.ci_hi < m.value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ci_lo <= value <= ci_hi required",
        path: ["ci_lo"],
      });
    }
  });

export const ProvenanceSchema = z
  .object({
    reviewgate_version: z.string(),
    corpus_commit: z.string(),
    corpus_dirty: z.boolean(),
    providers: z.array(
      z.object({ id: z.string(), cli_version: z.string(), model: z.string() }).strict(),
    ),
    config_hash: z.string(),
    window: z.number().int().nonnegative(),
    repeat: z.number().int().positive(),
    include_advisory: z.boolean(),
    temperature: z.number().nullable(),
    stores: z.enum(["per-case-fresh", "accumulated"]),
    cache: z.enum(["cold", "warm"]),
    host_os: z.string(),
    timestamp: z.string(),
    case_count: z
      .object({ seeded: z.number().int().nonnegative(), clean: z.number().int().nonnegative() })
      .strict(),
  })
  .strict();

export const CaseResultSchema = z
  .object({
    id: z.string(),
    kind: z.enum(["seeded-bug", "clean"]),
    // scored = counted; review-error = a provider failed on this case; invalid = malformed case.json
    status: z.enum(["scored", "review-error", "invalid"]),
    content_hash: z.string(),
    counts: z
      .object({
        tp: z.number().int().nonnegative(),
        fp: z.number().int().nonnegative(),
        fn: z.number().int().nonnegative(),
        neutral: z.number().int().nonnegative(),
      })
      .strict(),
    latency_ms: z.number().nonnegative().nullable(),
    error: z.string().nullable(),
  })
  .strict();

export const CostSchema = z
  .object({
    provider: z.string(),
    calls: z.number().int().nonnegative(),
    cache_hits: z.number().int().nonnegative(),
    tokens_in: z.number().int().nonnegative(),
    tokens_out: z.number().int().nonnegative(),
    billed_usd: z.number().nonnegative(),
    oauth_quota_calls: z.number().int().nonnegative(),
  })
  .strict();

export const BenchResultSchema = z
  .object({
    schema: z.literal("reviewgate.bench.result.v1"),
    provenance: ProvenanceSchema,
    cases: z.array(CaseResultSchema),
    cost: z.array(CostSchema),
    aggregate: z
      .object({
        precision: MetricSchema,
        recall: MetricSchema,
        clean_fp_rate: MetricSchema,
      })
      .strict(),
  })
  .strict();

export type Metric = z.infer<typeof MetricSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type CaseResult = z.infer<typeof CaseResultSchema>;
export type Cost = z.infer<typeof CostSchema>;
export type BenchResult = z.infer<typeof BenchResultSchema>;
