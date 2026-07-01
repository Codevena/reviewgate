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

// The result-affecting slice of the effective config, snapshotted into provenance
// (spec §12) so a published number carries the exact suppression posture it was
// measured under. `ablations` names the class-A/B toggles applied for THIS run
// (empty for a plain `bench run`); the individual booleans are the resolved state
// of each layer the metrics depend on.
export const PhasesSnapshotSchema = z
  .object({
    critic: z.boolean(),
    reputation: z.boolean(),
    fp_ledger: z.boolean(),
    confidence_floor: z.number().min(0).max(1).nullable(),
    scope_to_diff: z.boolean(),
    ablations: z.array(z.string()),
  })
  .strict();

export const ProvenanceSchema = z
  .object({
    reviewgate_version: z.string(),
    corpus_commit: z.string(),
    corpus_dirty: z.boolean(),
    // The resolved reviewer roster: provider + upstream model + CLI version + the
    // persona each slot ran under (persona changes what the reviewer looks for, so
    // a number is only comparable against a run with the same roster+persona).
    providers: z.array(
      z
        .object({
          id: z.string(),
          cli_version: z.string(),
          model: z.string(),
          persona: z.string(),
        })
        .strict(),
    ),
    config_hash: z.string(),
    window: z.number().int().nonnegative(),
    repeat: z.number().int().positive(),
    include_advisory: z.boolean(),
    temperature: z.number().nullable(),
    stores: z.enum(["per-case-fresh", "accumulated"]),
    cache: z.enum(["cold", "warm"]),
    // Whether reviewers saw the full hydrated changed-file content ("full") or only
    // the diff ("diff-only"). Guards against silently pooling numbers from a future
    // diff-only fallback with hydrated ones (they are not comparable).
    file_context: z.enum(["full", "diff-only"]),
    phases: PhasesSnapshotSchema,
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
    // Per-case aggregate-panel coverage: how many configured reviewers actually
    // returned an OK result vs. how many were configured. A case scored on a
    // degraded panel (panel_ok < panel_configured) is recorded so the run-level
    // quality gate can flag it rather than silently averaging it in.
    panel_ok: z.number().int().nonnegative(),
    panel_configured: z.number().int().nonnegative(),
    file_context: z.enum(["full", "diff-only"]),
    latency_ms: z.number().nonnegative().nullable(),
    error: z.string().nullable(),
  })
  .strict();

// Per-provider RAW-layer results (spec §5.1/§12): each reviewer scored on its own
// pre-aggregation findings, distinct from the aggregated panel. `coverage` is the
// fraction of scored cases the provider returned an OK result on; `authoritative`
// is false when coverage is too low to trust the number — and a provider can never
// be authoritative on an undefined (den=0) coverage.
export const ProviderResultSchema = z
  .object({
    provider: z.string(),
    coverage: MetricSchema,
    precision: MetricSchema,
    recall: MetricSchema,
    authoritative: z.boolean(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.authoritative && p.coverage.value === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "authoritative requires a defined (den>0) coverage",
        path: ["authoritative"],
      });
    }
  });

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
    // Per-provider RAW-layer metrics (see ProviderResultSchema). Distinct from
    // `aggregate`, which is the post-suppression panel.
    providers: z.array(ProviderResultSchema),
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
export type PhasesSnapshot = z.infer<typeof PhasesSnapshotSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type CaseResult = z.infer<typeof CaseResultSchema>;
export type ProviderResult = z.infer<typeof ProviderResultSchema>;
export type Cost = z.infer<typeof CostSchema>;
export type BenchResult = z.infer<typeof BenchResultSchema>;
