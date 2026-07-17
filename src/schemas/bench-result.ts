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

const OpenRouterRoutingSnapshotSchema = z
  .object({
    only: z.array(z.string()).optional(),
    order: z.array(z.string()).optional(),
    allowFallbacks: z.boolean().optional(),
  })
  .strict();

const CriticProvenanceSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    openrouter_provider: OpenRouterRoutingSnapshotSchema.nullable(),
    // Additive for Alpha.12 Attempt 02; optional keeps older published artifacts valid.
    max_attempts: z.number().int().positive().optional(),
  })
  .strict();

const IntegrityProvenanceSchema = z
  .object({
    source_commit: z.string(),
    repository_dirty: z.boolean(),
    runner_sha256: z.string(),
    runner_kind: z.enum(["compiled", "source-runtime", "test"]),
    preregistration_sha256: z.string().nullable(),
    authoritative_requested: z.boolean(),
    max_provider_calls: z.number().int().positive().nullable(),
    provider_calls_used: z.number().int().nonnegative(),
    max_output_tokens: z.number().int().positive().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.max_provider_calls !== null && value.provider_calls_used > value.max_provider_calls) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provider_calls_used must not exceed max_provider_calls",
        path: ["provider_calls_used"],
      });
    }
  });

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
    // Alpha.12 additive provenance. Optional so published v1 artifacts from older
    // releases continue to parse byte-for-byte.
    case_run_count: z
      .object({
        seeded: z.number().int().nonnegative(),
        clean: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    critic: CriticProvenanceSchema.nullable().optional(),
    integrity: IntegrityProvenanceSchema.optional(),
  })
  .strict();

export const CaseCriticSchema = z
  .object({
    provider: z.string(),
    eligible: z.boolean(),
    status: z.enum(["not-eligible", "ran", "error", "empty", "misconfigured", "skipped-budget"]),
    verdicts: z.number().int().nonnegative(),
    demoted: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.eligible !== (value.status !== "not-eligible")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "eligible must agree with critic status",
        path: ["eligible"],
      });
    }
  });

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
    // Which repeat (1..K) this case-run belongs to under `--repeat K`. Absent ⇒ 1.
    repeat: z.number().int().positive().optional(),
    latency_ms: z.number().nonnegative().nullable(),
    error: z.string().nullable(),
    critic: CaseCriticSchema.optional(),
  })
  .strict();

// One metric's spread across the K repeats (spec §10#3). `stddev` is the population
// standard deviation; stats are null when no repeat had a defined value (den=0).
export const SpreadStatSchema = z
  .object({
    mean: z.number().nullable(),
    stddev: z.number().min(0).nullable(),
    min: z.number().nullable(),
    max: z.number().nullable(),
    samples: z.number().int().nonnegative(),
  })
  .strict();

// Run-to-run stability under `--repeat K` — the mean ± spread of each headline
// metric across the K repeats, so a lucky/unlucky single run isn't mistaken for
// signal. Null on a single run (repeat=1).
export const StabilitySchema = z
  .object({
    repeats: z.number().int().positive(),
    precision: SpreadStatSchema,
    recall: SpreadStatSchema,
    clean_fp_rate: SpreadStatSchema,
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
    // null means the provider/CLI did not expose trustworthy accounting. Never
    // coerce unknown usage or billing to a misleading numeric zero.
    tokens_in: z.number().int().nonnegative().nullable(),
    tokens_out: z.number().int().nonnegative().nullable(),
    billed_usd: z.number().nonnegative().nullable(),
    oauth_quota_calls: z.number().int().nonnegative(),
  })
  .strict();

export const CriticResultSchema = z
  .object({
    provider: z.string(),
    eligible: z.number().int().nonnegative(),
    ran: z.number().int().nonnegative(),
    coverage: MetricSchema,
    authoritative: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.ran > value.eligible ||
      value.coverage.num !== value.ran ||
      value.coverage.den !== value.eligible
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "critic coverage must equal ran/eligible",
        path: ["coverage"],
      });
    }
  });

// The run's own quality-gate outcome, stamped into the artifact so a saved
// result is SELF-DESCRIBING. Trustworthiness was previously knowable only from
// the process exit code (ephemeral) or by digging into per-provider coverage;
// a consumer collecting baselines could mistake a quota-degraded run (a
// reviewer at 0% coverage → de-facto single-provider panel) for an authoritative
// one. `authoritative` mirrors the runner's exit-0 decision; `gate_exit_code`
// is 0 (clean) | 3 (provider outage) | 4 (benchmark-invalid); `reasons` lists
// the blocking gate reasons. Optional for backward-compat with result files
// written before this field — `isAuthoritative()` re-derives when it is absent.
// Reason strings are rendered VERBATIM into terminal reports (`reviewgate bench
// report <path>` accepts an arbitrary file). Reject ASCII control/escape bytes at
// the parse boundary so a crafted artifact cannot smuggle ANSI/VT100 sequences
// (cursor moves, screen clears) that rewrite surrounding output. Runner-produced
// reasons are plain sentences. (No control-char regex literal — biome flags those.)
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // C0 (<0x20) + DEL (0x7f) + C1 (0x80–0x9f). C1 matters because U+009B is the
    // 8-bit CSI — terminals in 8-bit mode treat it as ESC+"[", so it can drive
    // the same VT100 sequences as an ESC.
    if (c < 0x20 || c === 0x7f || (c >= 0x80 && c <= 0x9f)) return true;
  }
  return false;
}

export const BenchVerdictSchema = z
  .object({
    authoritative: z.boolean(),
    // 0 (clean) | 3 (provider outage) | 4 (benchmark-invalid) — the only exit
    // codes under which a result file is written.
    gate_exit_code: z.union([z.literal(0), z.literal(3), z.literal(4)]),
    reasons: z.array(
      z.string().refine((s) => !hasControlChar(s), "reasons must not contain control characters"),
    ),
  })
  .strict()
  // Invariants the runner always upholds; enforced at the schema boundary so a
  // crafted/buggy artifact carrying a contradictory verdict fails validation
  // instead of silently passing.
  .refine((v) => v.authoritative === (v.gate_exit_code === 0), {
    message: "authoritative must equal (gate_exit_code === 0)",
    path: ["authoritative"],
  })
  // A non-authoritative verdict must state WHY (else the report shows a bare
  // "NON-AUTHORITATIVE" banner with no cause — a misleading audit trail); an
  // authoritative one carries no reasons. `authoritative ⟺ reasons empty`.
  .refine((v) => v.authoritative === (v.reasons.length === 0), {
    message: "a non-authoritative verdict must state reasons; an authoritative one must have none",
    path: ["reasons"],
  });

export const BenchResultSchema = z
  .object({
    schema: z.literal("reviewgate.bench.result.v1"),
    provenance: ProvenanceSchema,
    cases: z.array(CaseResultSchema),
    // Per-provider RAW-layer metrics (see ProviderResultSchema). Distinct from
    // `aggregate`, which is the post-suppression panel.
    providers: z.array(ProviderResultSchema),
    cost: z.array(CostSchema),
    critic: CriticResultSchema.nullable().optional(),
    aggregate: z
      .object({
        precision: MetricSchema,
        recall: MetricSchema,
        clean_fp_rate: MetricSchema,
      })
      .strict(),
    // Present (object) only under `--repeat K` (K>1); null/absent for a single run.
    stability: StabilitySchema.nullable().optional(),
    verdict: BenchVerdictSchema.optional(),
  })
  .strict();

// reviewgate bench matrix (spec §8) — the ablation Δ table. One variant per row:
// the baseline (full suppression) plus one row per ablated layer, each carrying
// its point metrics and the signed delta vs. baseline.
export const MatrixVariantSchema = z
  .object({
    label: z.string(),
    /** the ablated layer ("" for the baseline row). */
    ablation: z.string(),
    /** A = post-review suppressor (aggregated layer only); B = input/prompt-stage. */
    class: z.enum(["A", "B", "baseline"]),
    precision: MetricSchema,
    recall: MetricSchema,
    clean_fp_rate: MetricSchema,
    /** baseline − variant per metric (null on the baseline row). */
    delta: z
      .object({
        precision: z.number(),
        recall: z.number(),
        clean_fp_rate: z.number(),
      })
      .strict()
      .nullable(),
    authoritative: z.boolean().optional(),
    result_ref: z.string().optional(),
    result_sha256: z.string().optional(),
  })
  .strict();

const MatrixArtifactRefSchema = z.object({ path: z.string(), sha256: z.string() }).strict();

export const BenchMatrixSchema = z
  .object({
    schema: z.literal("reviewgate.bench.matrix.v1"),
    provenance: ProvenanceSchema,
    variants: z.array(MatrixVariantSchema),
    authoritative: z.boolean().optional(),
    artifacts: z
      .object({
        baseline: MatrixArtifactRefSchema,
        variants: z.array(MatrixArtifactRefSchema),
        reviewer_responses: MatrixArtifactRefSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

export type Metric = z.infer<typeof MetricSchema>;
export type MatrixVariant = z.infer<typeof MatrixVariantSchema>;
export type BenchMatrix = z.infer<typeof BenchMatrixSchema>;
export type PhasesSnapshot = z.infer<typeof PhasesSnapshotSchema>;
export type Provenance = z.infer<typeof ProvenanceSchema>;
export type CaseResult = z.infer<typeof CaseResultSchema>;
export type SpreadStat = z.infer<typeof SpreadStatSchema>;
export type Stability = z.infer<typeof StabilitySchema>;
export type ProviderResult = z.infer<typeof ProviderResultSchema>;
export type Cost = z.infer<typeof CostSchema>;
export type BenchVerdict = z.infer<typeof BenchVerdictSchema>;
export type BenchResult = z.infer<typeof BenchResultSchema>;
