import { createHash } from "node:crypto";
import { decodeTime } from "ulid";
import { z } from "zod";
import {
  POLICY_CATALOG_VERSION,
  POLICY_PASS_IDS,
  POLICY_REASON_CODES,
} from "../core/policy/catalog.ts";
import { compareCodeUnits } from "../utils/compare.ts";
import { isAuthoritativeThrowableString } from "./bench-result.ts";
import { ProviderIdSchema } from "./cassette.ts";
import { FindingCategory, FindingSchema } from "./finding.ts";
import { PolicyTraceSchema } from "./policy-trace.ts";

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const GitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const PolicyPassIdSchema = z.enum(POLICY_PASS_IDS);
const PolicyInactiveReasonSchema = z.enum(["configured-off", "stage-precondition-miss"]);
const IsoTimestampSchema = z.string().datetime({ offset: true });

export interface PolicyReplayCallIdentityInput {
  runId: string;
  iter: number;
  kind: "reviewer" | "grounding" | "critic";
  provider: string;
  method: "review" | "complete";
  key: string;
  promptSha256: string;
  ordinal: number;
  slot: number;
  attempt: number;
  occurrence: number;
}

/** Stable logical-call identity; physical cassette append order is deliberately absent. */
export function policyReplayCallId(input: PolicyReplayCallIdentityInput): string {
  return createHash("sha256")
    .update(
      [
        input.runId,
        String(input.iter),
        input.kind,
        input.provider,
        input.method,
        input.key,
        input.promptSha256,
        String(input.ordinal),
        String(input.slot),
        String(input.attempt),
        String(input.occurrence),
      ].join("\0"),
    )
    .digest("hex");
}

const ResponseCallSchema = z
  .object({
    call_id: Sha256Schema,
    kind: z.enum(["reviewer", "grounding", "critic"]),
    provider: ProviderIdSchema,
    method: z.enum(["review", "complete"]),
    key: z.string().min(1),
    prompt_sha256: Sha256Schema,
    ordinal: z.number().int().nonnegative(),
    slot: z.number().int().nonnegative(),
    attempt: z.number().int().positive(),
    occurrence: z.number().int().nonnegative(),
    response_sha256: Sha256Schema,
  })
  .strict();

const DisabledHistoryStoreSchema = z.object({ enabled: z.literal(false) }).strict();
const HistoryInputsSchema = z
  .object({
    fp_ledger: z.discriminatedUnion("enabled", [
      DisabledHistoryStoreSchema,
      z
        .object({
          enabled: z.literal(true),
          active_at: IsoTimestampSchema,
          clusters_at: IsoTimestampSchema,
        })
        .strict(),
    ]),
    reputation: z.discriminatedUnion("enabled", [
      DisabledHistoryStoreSchema,
      z
        .object({
          enabled: z.literal(true),
          observed_at: IsoTimestampSchema,
          min_samples: z.number().int().nonnegative(),
          trust_floor: z.number().min(0).max(1),
          half_life_days: z.number().positive(),
        })
        .strict(),
    ]),
    cycle_state: z
      .object({
        source: z.literal("state.json"),
        region_rejected_enabled: z.boolean(),
      })
      .strict(),
    implicit_outcomes: z.discriminatedUnion("enabled", [
      DisabledHistoryStoreSchema,
      z
        .object({
          enabled: z.literal(true),
          cap: z.number().int().positive(),
          created_at: IsoTimestampSchema,
        })
        .strict(),
    ]),
  })
  .strict();

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
    response_calls: z.array(ResponseCallSchema),
    history: HistoryInputsSchema,
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

export function isFormalPolicyReplayUlid(value: string): boolean {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(value)) return false;
  try {
    decodeTime(value);
    return true;
  } catch {
    return false;
  }
}

export function isTrustedPolicyReplayRunIdString(input: {
  value: string;
  path: readonly (string | number)[];
  runId: string;
  policyTraceRunId: string;
}): boolean {
  if (
    input.runId !== input.policyTraceRunId ||
    input.value !== input.runId ||
    !isFormalPolicyReplayUlid(input.runId)
  ) {
    return false;
  }
  return (
    (input.path.length === 1 && input.path[0] === "run_id") ||
    (input.path.length === 2 && input.path[0] === "policy_trace" && input.path[1] === "run_id")
  );
}

export const PolicyReplayEnvelopeSchema = PolicyReplayEnvelopeBaseSchema.superRefine(
  (value, ctx) => {
    if (value.lossless) {
      visitStrings(value, (stringValue, path) => {
        if (
          !isAuthoritativeThrowableString(stringValue) &&
          !isTrustedPolicyReplayRunIdString({
            value: stringValue,
            path,
            runId: value.run_id,
            policyTraceRunId: value.policy_trace.run_id,
          })
        ) {
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
    if (
      value.response_calls.length !== value.raw_response_sha256.length ||
      value.response_calls.some(
        (call, index) =>
          call.response_sha256 !== value.raw_response_sha256[index] ||
          (index > 0 && call.ordinal <= (value.response_calls[index - 1]?.ordinal ?? -1)),
      )
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["response_calls"],
        message: "response calls must bind every ordered response hash to its logical slot",
      });
    }
    const seenCallIds = new Set<string>();
    for (const [index, call] of value.response_calls.entries()) {
      const expectedMethod = call.kind === "reviewer" ? "review" : "complete";
      const expectedCallId = policyReplayCallId({
        runId: value.run_id,
        iter: value.iter,
        kind: call.kind,
        provider: call.provider,
        method: call.method,
        key: call.key,
        promptSha256: call.prompt_sha256,
        ordinal: call.ordinal,
        slot: call.slot,
        attempt: call.attempt,
        occurrence: call.occurrence,
      });
      if (
        call.method !== expectedMethod ||
        call.call_id !== expectedCallId ||
        seenCallIds.has(call.call_id)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["response_calls", index],
          message: "response call identity, method, ordinal, or call id is invalid",
        });
      }
      seenCallIds.add(call.call_id);
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
