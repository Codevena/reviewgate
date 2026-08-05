// src/schemas/rig-result.ts
// `reviewgate.rig.result.v1` — what the harvester folds a driver run's per-turn snapshots
// into, and the single artifact the reporter (Task 5) and the write-up (Task 6) are allowed
// to read. Metric DEFINITIONS live in `src/rig/harvest.ts`; this file pins their SHAPES so a
// number can never be persisted without the context that makes it readable.
//
// Two nullable fields carry the design decisions this schema exists to enforce:
//   * `caught` is null on a clean turn — NOT false. A clean turn has nothing to catch, and
//     folding it in as a miss would deflate recall with turns that were never scored.
//   * `fpBurden` is null on a turn with zero findings — NOT 0. `0/0` is NaN, and a 0 would
//     read as "no false positives on a turn that had findings", a different and flattering
//     claim. 7 of the 12 pilot turns are clean, so this is the common case.
import { z } from "zod";
import { MetricSchema, SpreadStatSchema } from "./bench-result.ts";
import { FindingSchema } from "./finding.ts";

/**
 * M6 — which suppression layer removed or demoted how many findings.
 *
 * A fixed key set, not a free-form record: these are exactly the four layers Task 5's
 * ablation toggles, and an open record lets a typo invent a silently-empty layer.
 *
 * `lore` is counted honestly and is NOT a demotion: lore never lowers a severity. It ADDS
 * synthetic verdict-neutral INFO findings (a stale-canon reminder, a draft→canon promotion
 * guard), so its number is "lore findings emitted", i.e. the decision cost the layer imposed
 * on the agent. Naming it a demote count would be a category error the reporter would inherit.
 */
export const RigSuppressionCountsSchema = z
  .object({
    /** critic returned `likely_fp` (a `keep` verdict is not a demotion) */
    critic: z.number().int().nonnegative(),
    /** reviewer-reputation demote */
    reputation: z.number().int().nonnegative(),
    /** FP-ledger signature match OR derived FP cluster, counted only when `suppressed` */
    fp_ledger: z.number().int().nonnegative(),
    /** synthetic lore findings emitted (additive, verdict-neutral — see above) */
    lore: z.number().int().nonnegative(),
  })
  .strict();

export const RigTurnRecordSchema = z
  .object({
    index: z.number().int().positive(),
    /** the seeded defect's id, or null on a clean turn */
    seededId: z.string().nullable(),
    /** M1 — `run.complete` events attributable to this turn. 0 = the gate never reviewed it. */
    iterations: z.number().int().nonnegative(),
    /** distinct finding SIGNATURES across every `pending.json` archived during the turn */
    findingsTotal: z.number().int().nonnegative(),
    blockingTotal: z.number().int().nonnegative(),
    /** M2 numerator — decisions bucketed `fp` (rejected + reviewer_was_wrong) */
    rejectedAsFp: z.number().int().nonnegative(),
    /** M2 — rejectedAsFp / findingsTotal; null (never 0) at zero findings */
    fpBurden: z.number().nullable(),
    /** M3 — a blocking finding in THIS turn matched the seeded label; null on a clean turn */
    caught: z.boolean().nullable(),
    /** M4 — the seeded defect was never flagged in this turn or any later one; null when clean */
    escaped: z.boolean().nullable(),
    /**
     * Did the seeded defect actually reach the code? `true`/`false` when the script supplied a
     * `landedPattern` and the turn recorded a `diff.patch`; `null` = UNKNOWN (clean turn, no
     * pattern, or no recorded diff) — never a guess.
     *
     * `false` turns are EXCLUDED from the recall and escape denominators. pilot-01 is why:
     * turn 9 directed a hardcoded token, the agent wrote the env-var version, and a run with
     * nothing to catch scored the reviewer with a miss and the study's only escape.
     */
    seedLanded: z.boolean().nullable().optional(),
    /** M5 — summed `run.complete.cost_usd` for this turn */
    costUsd: z.number().nonnegative(),
    /** M5 — summed `run.complete.duration_ms` for this turn (gate time, not agent wall-clock) */
    durationMs: z.number().nonnegative(),
    /** from the manifest: non-zero means the agent turn itself failed */
    agentExitCode: z.number().int(),
    wallMs: z.number().int().nonnegative(),
    suppressed: RigSuppressionCountsSchema,
    /**
     * The distinct findings the gate showed the agent during this turn, deduped by signature.
     *
     * Carried in the artifact — not merely counted — so `ablate()` can be a PURE function of
     * `(result, layer)` with no `.reviewgate/` reads, which is what makes its Δ attributable
     * to the layer and nothing else. It also makes the result self-contained: a published run
     * can be re-analysed under a definition that did not exist when it was harvested, without
     * the snapshots and without re-spending agent quota.
     *
     * These are POST-aggregation findings. What that costs is stated precisely in
     * `src/rig/ablate.ts` — it is the reason two of the four layers can only be bounded.
     */
    findings: z.array(FindingSchema),
  })
  .strict()
  // The two null contracts, enforced rather than documented: a future edit that computes
  // `caught` for a clean turn or `0` for a zero-finding turn fails validation here instead of
  // publishing a number whose meaning silently changed.
  .superRefine((t, ctx) => {
    if ((t.seededId === null) !== (t.caught === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "caught must be null exactly on clean turns (seededId === null)",
        path: ["caught"],
      });
    }
    if ((t.seededId === null) !== (t.escaped === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "escaped must be null exactly on clean turns (seededId === null)",
        path: ["escaped"],
      });
    }
    if (t.findingsTotal === 0 && t.fpBurden !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "fpBurden must be null when the turn produced zero findings",
        path: ["fpBurden"],
      });
    }
    if (t.findingsTotal > 0 && t.fpBurden === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "fpBurden must be defined when the turn produced findings",
        path: ["fpBurden"],
      });
    }
    if (t.blockingTotal > t.findingsTotal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "blockingTotal must be <= findingsTotal",
        path: ["blockingTotal"],
      });
    }
  });

/**
 * M2's headline number. `slope` is an ordinary-least-squares fit of per-turn FP burden
 * against turn index over the non-null points only, and it is **null below 5 of them** — the
 * reporter prints `insufficient data (n=<k>)` rather than a number. An OLS slope over a
 * handful of noisy points is a shape, not an effect size, and a bare number invites exactly
 * the overclaim this rig exists to avoid. `n` therefore travels with it, always.
 */
export const RigSlopeSchema = z
  .object({
    slope: z.number().nullable(),
    n: z.number().int().nonnegative(),
  })
  .strict();

export const RigMetricsSchema = z
  .object({
    /** M1 — over the turns the gate actually reviewed (iterations > 0); `samples` says how many */
    iterations: z.object({ median: z.number().nullable(), spread: SpreadStatSchema }).strict(),
    /** M2 */
    fpBurdenSlope: RigSlopeSchema,
    /** M3 — seeded turns caught in their own turn, over seeded turns HARVESTED */
    recall: MetricSchema,
    /** M4 — seeded turns never flagged in their own or any later turn */
    escapeRate: MetricSchema,
    /** M5 — totals over every harvested turn; the spread is over reviewed turns only */
    cost: z
      .object({
        totalUsd: z.number().nonnegative(),
        totalDurationMs: z.number().nonnegative(),
        perTurnUsd: SpreadStatSchema,
      })
      .strict(),
    /** M6 — summed across turns */
    suppression: RigSuppressionCountsSchema,
  })
  .strict();

/**
 * Provenance. A rig number is only comparable against another run with the same panel and
 * the same script, so both are recorded — "a different panel is a different system".
 *
 * `panel` is derived from the archived reports rather than from a config file, because the
 * roster that actually ran is the roster that produced the numbers (a reviewer that was
 * configured but quota-capped never contributed).
 */
export const RigProvenanceSchema = z
  .object({
    reviewgate_version: z.string(),
    harvested_at: z.string(),
    run_id: z.string(),
    script_id: z.string(),
    script_path: z.string(),
    manifest_path: z.string(),
    turn_count: z
      .object({
        /** turns present in the manifest — the denominator every rate here uses */
        harvested: z.number().int().nonnegative(),
        seeded: z.number().int().nonnegative(),
        clean: z.number().int().nonnegative(),
        /** turns the script defines; > harvested when the run was capped or died early */
        script_total: z.number().int().positive(),
      })
      .strict(),
    panel: z.array(
      z.object({ provider: z.string(), model: z.string(), persona: z.string() }).strict(),
    ),
    host_os: z.string(),
  })
  .strict();

export const RigResultSchema = z
  .object({
    schema: z.literal("reviewgate.rig.result.v1"),
    runId: z.string().min(1),
    provenance: RigProvenanceSchema,
    turns: z.array(RigTurnRecordSchema),
    metrics: RigMetricsSchema,
    /**
     * Everything that failed, was skipped, or could not be read — one line each.
     * Task 6's honesty rule ("a run with three timed-out turns that reports only the nine
     * good ones is not a measurement") needs a machine-readable carrier, not a footnote the
     * reporter can forget to print.
     */
    warnings: z.array(z.string()),
  })
  .strict();

export type RigSuppressionCounts = z.infer<typeof RigSuppressionCountsSchema>;
export type RigTurnRecord = z.infer<typeof RigTurnRecordSchema>;
export type RigSlope = z.infer<typeof RigSlopeSchema>;
export type RigMetrics = z.infer<typeof RigMetricsSchema>;
export type RigProvenance = z.infer<typeof RigProvenanceSchema>;
export type RigResult = z.infer<typeof RigResultSchema>;
