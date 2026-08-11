import { z } from "zod";
import {
  POLICY_CATALOG_VERSION,
  POLICY_PASS_IDS,
  POLICY_REASON_CODES,
} from "../core/policy/catalog.ts";
import { compareCodeUnits } from "../utils/compare.ts";
import { isAuthoritativeThrowableString } from "./bench-result.ts";
import { FindingCategory, FindingSchema } from "./finding.ts";
import { PolicyTraceSchema } from "./policy-trace.ts";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const GitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const PolicyPassIdSchema = z.enum(POLICY_PASS_IDS);
const PolicyInactiveReasonSchema = z.enum(["configured-off", "stage-precondition-miss"]);

const ChangedRangeSchema = z
  .object({ start: z.number().int().nonnegative(), end: z.number().int().positive() })
  .strict()
  .refine((value) => value.end > value.start, "range end must be greater than start");

const ChangedRangesSchema = z
  .array(
    z
      .object({
        file: z.string().min(1),
        ranges: z.array(ChangedRangeSchema),
      })
      .strict()
      .superRefine((value, ctx) => {
        for (let index = 1; index < value.ranges.length; index += 1) {
          const previous = value.ranges[index - 1];
          const current = value.ranges[index];
          if (
            previous !== undefined &&
            current !== undefined &&
            (previous.start > current.start ||
              (previous.start === current.start && previous.end >= current.end))
          ) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["ranges", index],
              message: "changed ranges must be uniquely sorted",
            });
          }
        }
      }),
  )
  .superRefine((value, ctx) => {
    for (let index = 1; index < value.length; index += 1) {
      if (compareCodeUnits(value[index - 1]?.file ?? "", value[index]?.file ?? "") >= 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "file"],
          message: "changed-range files must be uniquely sorted",
        });
      }
    }
  });

function uniquelySortedBy<T>(
  values: T[],
  key: (value: T) => string,
  ctx: z.RefinementCtx,
  path: Array<string | number>,
): void {
  for (let index = 1; index < values.length; index += 1) {
    if (compareCodeUnits(key(values[index - 1] as T), key(values[index] as T)) >= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index],
        message: "entries must be uniquely sorted",
      });
    }
  }
}

const CriticEntrySchema = z
  .object({
    signature: z.string().min(1),
    verdict: z.enum(["keep", "likely_fp"]),
    reason: z.string().optional(),
  })
  .strict();

const AggregateInputsSchema = z
  .object({
    findings: z.array(FindingSchema),
    reviewers_total: z.number().int().nonnegative(),
    changed_ranges: ChangedRangesSchema,
    scope_to_diff: z.boolean(),
    out_of_diff_blocking: z.array(FindingCategory),
    confidence_floor: z.number().min(0).max(1),
    demote_correctness: z.boolean(),
    corroborate_critical: z.boolean(),
    demote_test_security: z.boolean(),
    cap_docs_severity: z.boolean(),
    critic: z.array(CriticEntrySchema),
    fp_active: z.array(z.object({ signature: z.string(), id: z.string() }).strict()),
    fp_active_clusters: z.array(
      z
        .object({ key: z.string(), member_ids: z.array(z.string()) })
        .strict()
        .superRefine((value, ctx) => uniquelySortedBy(value.member_ids, (entry) => entry, ctx, [])),
    ),
    rep_unreliable: z.array(z.string()),
    protected_reviewers: z.array(z.string()),
    foreign_files: z.array(z.string()),
    cycle_rejected: z.array(z.string()),
    claimed_fixed: z.array(
      z.object({ signature: z.string(), iter: z.number().int().positive() }).strict(),
    ),
    delta_scope: z.array(z.string()),
    rejected_regions: z.array(
      z
        .object({
          file: z.string(),
          start_line: z.number().int().positive(),
          end_line: z.number().int().positive(),
          severity: z.enum(["CRITICAL", "WARN", "INFO"]),
          categories: z.array(FindingCategory),
          reason: z.string(),
          distinct_count: z.number().int().positive(),
        })
        .strict(),
    ),
    policy_inactive: z.array(
      z.object({ pass_id: PolicyPassIdSchema, reason_code: PolicyInactiveReasonSchema }).strict(),
    ),
  })
  .strict()
  .superRefine((value, ctx) => {
    uniquelySortedBy(value.critic, (entry) => entry.signature, ctx, ["critic"]);
    uniquelySortedBy(value.fp_active, (entry) => entry.signature, ctx, ["fp_active"]);
    uniquelySortedBy(value.fp_active_clusters, (entry) => entry.key, ctx, ["fp_active_clusters"]);
    uniquelySortedBy(value.rep_unreliable, (entry) => entry, ctx, ["rep_unreliable"]);
    uniquelySortedBy(value.protected_reviewers, (entry) => entry, ctx, ["protected_reviewers"]);
    uniquelySortedBy(value.foreign_files, (entry) => entry, ctx, ["foreign_files"]);
    uniquelySortedBy(value.cycle_rejected, (entry) => entry, ctx, ["cycle_rejected"]);
    uniquelySortedBy(value.claimed_fixed, (entry) => entry.signature, ctx, ["claimed_fixed"]);
    uniquelySortedBy(value.delta_scope, (entry) => entry, ctx, ["delta_scope"]);
    uniquelySortedBy(
      value.rejected_regions,
      (entry) =>
        `${entry.file}\u0000${String(entry.start_line).padStart(12, "0")}\u0000${String(entry.end_line).padStart(12, "0")}`,
      ctx,
      ["rejected_regions"],
    );
    uniquelySortedBy(value.policy_inactive, (entry) => entry.pass_id, ctx, ["policy_inactive"]);
  });

const GroundingVerdictSchema = z
  .object({ signature: z.string(), grounded: z.boolean(), reason: z.string().optional() })
  .strict();

const PolicyReplayEnvelopeBaseSchema = z
  .object({
    schema: z.literal("reviewgate.policy-replay-envelope.v1"),
    catalog_version: z.literal(POLICY_CATALOG_VERSION),
    run_id: z.string().min(1),
    iter: z.number().int().positive(),
    source_commit: GitObjectIdSchema,
    exact_diff: z.string(),
    pre_policy_findings: z.array(FindingSchema),
    grounding: z
      .object({
        corpus: z.string(),
        verdicts: z.array(GroundingVerdictSchema),
        llm_status: z.enum(["ran", "not-run", "error"]),
      })
      .strict()
      .superRefine((value, ctx) =>
        uniquelySortedBy(value.verdicts, (entry) => entry.signature, ctx, ["verdicts"]),
      ),
    aggregate: AggregateInputsSchema,
    /** Aggregate output before additive Lore findings; Lore remains non-ablatable. */
    policy_final_findings: z.array(FindingSchema),
    pre_policy: z
      .object({ self_refutation_enabled: z.boolean(), hypothetical_enabled: z.boolean() })
      .strict(),
    state_sha256: Sha256Schema,
    raw_response_sha256: z.array(Sha256Schema),
    /** Original production trace; replay must reproduce it byte-for-byte before ablation. */
    policy_trace: PolicyTraceSchema,
    lossless: z.boolean(),
  })
  .strict();

function visitStrings(
  value: unknown,
  visit: (value: string, path: Array<string | number>) => void,
): void {
  const walk = (candidate: unknown, path: Array<string | number>) => {
    if (typeof candidate === "string") {
      visit(candidate, path);
      return;
    }
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => walk(entry, [...path, index]));
      return;
    }
    if (candidate !== null && typeof candidate === "object") {
      for (const [key, entry] of Object.entries(candidate as Record<string, unknown>)) {
        walk(entry, [...path, key]);
      }
    }
  };
  walk(value, []);
}

export const PolicyReplayEnvelopeSchema = PolicyReplayEnvelopeBaseSchema.superRefine(
  (value, ctx) => {
    if (value.lossless) {
      visitStrings(value, (stringValue, path) => {
        if (!isAuthoritativeThrowableString(stringValue)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path,
            message: "lossless replay envelope contains unsafe string data",
          });
        }
      });
    }
    if (value.grounding.llm_status !== "ran" && value.grounding.verdicts.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["grounding", "verdicts"],
        message: "grounding verdicts require a ran LLM stage",
      });
    }
    if (
      value.policy_trace.run_id !== value.run_id ||
      value.policy_trace.iter !== value.iter ||
      value.policy_trace.catalog_version !== value.catalog_version
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["policy_trace"],
        message: "policy trace identity must match its replay envelope",
      });
    }
    if (
      value.raw_response_sha256.length !== value.policy_trace.raw_response_sha256.length ||
      value.raw_response_sha256.some(
        (hash, index) => hash !== value.policy_trace.raw_response_sha256[index],
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["raw_response_sha256"],
        message: "ordered response hashes must match the production policy trace",
      });
    }
    for (const row of value.aggregate.policy_inactive) {
      if (!POLICY_REASON_CODES.includes(row.reason_code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["aggregate", "policy_inactive"],
          message: "policy inactive reason must be catalogued",
        });
      }
    }
  },
);

/** Structural input accepted only at the in-memory capture boundary, before redaction. */
export const PolicyReplayEnvelopeInputSchema = PolicyReplayEnvelopeBaseSchema;

export type PolicyReplayEnvelope = z.infer<typeof PolicyReplayEnvelopeSchema>;
export type PolicyReplayEnvelopeInput = z.input<typeof PolicyReplayEnvelopeInputSchema>;
export type PolicyReplayAggregateInputs = z.infer<typeof AggregateInputsSchema>;
