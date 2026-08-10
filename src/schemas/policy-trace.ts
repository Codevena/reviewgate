import { z } from "zod";
import {
  POLICY_CATALOG_VERSION,
  POLICY_EFFECT_ACTIONS,
  POLICY_PASSES,
  POLICY_PASS_IDS,
  POLICY_PROTECTION_CODES,
  POLICY_REASON_CODES,
  POLICY_STAGES,
  POLICY_STAGE_IDS,
  type PolicyPassCatalogEntry,
  type PolicyPassId,
  type PolicySeverity,
  type PolicyStageCatalogEntry,
} from "../core/policy/catalog.ts";

export const PolicyPassIdSchema = z.enum(POLICY_PASS_IDS);
export const PolicyStageIdSchema = z.enum(POLICY_STAGE_IDS);
export const PolicyReasonCodeSchema = z.enum(POLICY_REASON_CODES);
export const PolicyProtectionCodeSchema = z.enum(POLICY_PROTECTION_CODES);
export const PolicyEffectActionSchema = z.enum(POLICY_EFFECT_ACTIONS);
export const PolicyTraceStatusSchema = z.enum(["complete", "not-run", "error", "overflow"]);
export const PolicySha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

const PolicySeveritySchema = z.enum(["CRITICAL", "WARN", "INFO"]);
const EvaluationResultSchema = z.enum([
  "no-opportunity",
  "no-match",
  "would-apply",
  "protected",
  "applied",
]);
const TraceVerdictSchema = z.enum(["PASS", "SOFT-PASS", "FAIL", "ERROR"]);
const StageVerdictSchema = z.enum(["PASS", "SOFT-PASS", "FAIL"]);

const NOT_RUN_REASON_CODES = new Set(["configured-off", "stage-precondition-miss"]);
const PASS_ERROR_REASON_CODE = "instrumentation-error" as const;
const NON_MATERIAL_REASON_CODES = new Set([
  "ineligible-starting-state",
  "predicate-miss",
  "configured-off",
  "stage-precondition-miss",
  PASS_ERROR_REASON_CODE,
]);
const LORE_FINAL_SIGNATURE = /^lore:(?:reminder|canon-promotion):[a-z0-9][a-z0-9-]*$/;
const VERDICT_BY_REASON = {
  "hard-critical": "FAIL",
  "corroborated-warn": "FAIL",
  "claimed-fixed-recurrence": "FAIL",
  "blocking-present": "SOFT-PASS",
  "no-blocking-findings": "PASS",
} as const;

function policyPass(passId: PolicyPassId): PolicyPassCatalogEntry {
  const pass: PolicyPassCatalogEntry | undefined = POLICY_PASSES.find(
    (candidate) => candidate.id === passId,
  );
  if (!pass) throw new Error(`Policy pass is missing from the static catalog: ${passId}`);
  return pass;
}

function policyStage(stageId: z.infer<typeof PolicyStageIdSchema>): PolicyStageCatalogEntry {
  const stage: PolicyStageCatalogEntry | undefined = POLICY_STAGES.find(
    (candidate) => candidate.id === stageId,
  );
  if (!stage) throw new Error(`Policy stage is missing from the static catalog: ${stageId}`);
  return stage;
}

function addIssue(ctx: z.RefinementCtx, path: Array<string | number>, message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

function isSortedUnique(values: readonly string[]): boolean {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1];
    const current = values[index];
    if (previous === undefined || current === undefined || previous >= current) return false;
  }
  return true;
}

function validateSortedUnique(
  values: readonly string[],
  ctx: z.RefinementCtx,
  path: Array<string | number>,
): void {
  if (!isSortedUnique(values)) {
    addIssue(ctx, path, "signatures must be sorted in ascending byte order and deduplicated");
  }
}

function isOrderedSubsequence(values: readonly string[], candidates: readonly string[]): boolean {
  let valueIndex = 0;
  for (const candidate of candidates) {
    if (candidate === values[valueIndex]) valueIndex += 1;
  }
  return valueIndex === values.length;
}

function passAllowsReason(pass: PolicyPassCatalogEntry, reason: string): boolean {
  return pass.reason_codes.some((candidate) => candidate === reason);
}

function passAllowsAction(pass: PolicyPassCatalogEntry, action: string): boolean {
  return pass.actions.some((candidate) => candidate === action);
}

function passAllowsProtectionRule(
  pass: PolicyPassCatalogEntry,
  rule: {
    reason_code: string;
    protected_by: string;
    before: PolicySeverity;
  },
): boolean {
  return pass.protection_rules.some(
    (candidate) =>
      candidate.reason_code === rule.reason_code &&
      candidate.protected_by === rule.protected_by &&
      candidate.before === rule.before,
  );
}

function passAllowsMaterialTransition(
  pass: PolicyPassCatalogEntry,
  transition: {
    reason_code: string;
    action?: string;
    before: PolicySeverity;
    after?: PolicySeverity | null;
  },
): boolean {
  return pass.material_transitions.some(
    (candidate) =>
      candidate.reason_code === transition.reason_code &&
      (transition.action === undefined || candidate.action === transition.action) &&
      candidate.before === transition.before &&
      (transition.after === undefined || candidate.after === transition.after),
  );
}

const NonEmptySortedSignaturesSchema = z
  .array(z.string().min(1))
  .min(1)
  .superRefine((values, ctx) => validateSortedUnique(values, ctx, []));

const UniqueSignaturesSchema = z.array(z.string().min(1)).superRefine((values, ctx) => {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (seen.has(value)) addIssue(ctx, [index], "signatures must be deduplicated");
    seen.add(value);
  }
});

const PolicyEffectObjectSchema = z
  .object({
    pass_id: PolicyPassIdSchema,
    order: z.number().int().positive(),
    action: PolicyEffectActionSchema,
    before: PolicySeveritySchema,
    after: PolicySeveritySchema.nullable(),
    reason_code: PolicyReasonCodeSchema,
    protected_by: PolicyProtectionCodeSchema.optional(),
    source_signatures: NonEmptySortedSignaturesSchema,
  })
  .strict();

export const PolicyEffectSchema = PolicyEffectObjectSchema.superRefine((effect, ctx) => {
  const pass = policyPass(effect.pass_id);

  if (effect.order !== pass.order) {
    addIssue(ctx, ["order"], `order must match ${effect.pass_id} (${pass.order})`);
  }
  if (!passAllowsAction(pass, effect.action)) {
    addIssue(ctx, ["action"], `action is not allowed for ${effect.pass_id}`);
  }
  if (
    !passAllowsReason(pass, effect.reason_code) ||
    NON_MATERIAL_REASON_CODES.has(effect.reason_code)
  ) {
    addIssue(ctx, ["reason_code"], `material reason is not allowed for ${effect.pass_id}`);
  }

  if (effect.action === "protected") {
    if (effect.protected_by === undefined) {
      addIssue(ctx, ["protected_by"], "a protected effect requires protected_by");
    } else if (
      !passAllowsProtectionRule(pass, {
        reason_code: effect.reason_code,
        protected_by: effect.protected_by,
        before: effect.before,
      })
    ) {
      addIssue(
        ctx,
        ["protected_by"],
        `protection, reason, and severity are not allowed for ${effect.pass_id}`,
      );
    }
    if (effect.after !== effect.before) {
      addIssue(ctx, ["after"], "a protected effect must preserve severity");
    }
  } else if (effect.protected_by !== undefined) {
    addIssue(ctx, ["protected_by"], "protected_by is only valid for a protected effect");
  }

  if (effect.action === "protected") {
    return;
  }
  if (!passAllowsMaterialTransition(pass, effect)) {
    addIssue(ctx, ["after"], `transition is not allowed for ${effect.pass_id}`);
  }
});

export type PolicyEffect = z.infer<typeof PolicyEffectSchema>;

export const PolicyEffectsSchema = z.array(PolicyEffectSchema).superRefine((effects, ctx) => {
  let priorOrder = -1;
  const identities = new Set<string>();

  for (const [index, effect] of effects.entries()) {
    if (effect.order < priorOrder) {
      addIssue(ctx, [index, "order"], "policy effects must remain in catalog order");
    }
    priorOrder = effect.order;

    const identity = JSON.stringify([
      effect.pass_id,
      effect.action,
      effect.before,
      effect.after,
      effect.reason_code,
      effect.protected_by ?? null,
      effect.source_signatures,
    ]);
    if (identities.has(identity)) {
      addIssue(ctx, [index], "duplicate idempotent policy effect");
    }
    identities.add(identity);
  }
});

const PolicyEvaluationObjectSchema = z
  .object({
    pass_id: PolicyPassIdSchema,
    order: z.number().int().positive(),
    result: EvaluationResultSchema,
    before: PolicySeveritySchema,
    after: PolicySeveritySchema.nullable(),
    reason_code: PolicyReasonCodeSchema,
    protected_by: PolicyProtectionCodeSchema.optional(),
    source_signatures: NonEmptySortedSignaturesSchema,
    final_signature: z.string().min(1).optional(),
  })
  .strict();

export const PolicyEvaluationSchema = PolicyEvaluationObjectSchema.superRefine(
  (evaluation, ctx) => {
    const pass = policyPass(evaluation.pass_id);

    if (evaluation.order !== pass.order) {
      addIssue(ctx, ["order"], `order must match ${evaluation.pass_id} (${pass.order})`);
    }
    if (!passAllowsReason(pass, evaluation.reason_code)) {
      addIssue(ctx, ["reason_code"], `reason is not allowed for ${evaluation.pass_id}`);
    }

    if (
      (evaluation.result === "no-opportunity" &&
        evaluation.reason_code !== "ineligible-starting-state") ||
      (evaluation.result === "no-match" && evaluation.reason_code !== "predicate-miss") ||
      ((evaluation.result === "would-apply" ||
        evaluation.result === "protected" ||
        evaluation.result === "applied") &&
        NON_MATERIAL_REASON_CODES.has(evaluation.reason_code))
    ) {
      addIssue(ctx, ["reason_code"], `reason does not match result ${evaluation.result}`);
    }

    if (evaluation.result === "protected") {
      if (evaluation.protected_by === undefined) {
        addIssue(ctx, ["protected_by"], "a protected evaluation requires protected_by");
      } else if (
        !passAllowsProtectionRule(pass, {
          reason_code: evaluation.reason_code,
          protected_by: evaluation.protected_by,
          before: evaluation.before,
        })
      ) {
        addIssue(
          ctx,
          ["protected_by"],
          `protection, reason, and severity are not allowed for ${evaluation.pass_id}`,
        );
      }
    } else if (evaluation.protected_by !== undefined) {
      addIssue(ctx, ["protected_by"], "protected_by is only valid for a protected evaluation");
    }

    if (evaluation.result !== "applied") {
      if (evaluation.after === null || evaluation.after !== evaluation.before) {
        addIssue(ctx, ["after"], `${evaluation.result} must preserve severity`);
      }
      if (
        evaluation.result === "would-apply" &&
        !passAllowsMaterialTransition(pass, {
          reason_code: evaluation.reason_code,
          before: evaluation.before,
        })
      ) {
        addIssue(ctx, ["reason_code"], `no material transition exists for ${evaluation.pass_id}`);
      }
    } else {
      if (
        !passAllowsMaterialTransition(pass, {
          reason_code: evaluation.reason_code,
          before: evaluation.before,
          after: evaluation.after,
        })
      ) {
        addIssue(ctx, ["after"], `transition is not allowed for ${evaluation.pass_id}`);
      }
      if (evaluation.after === null && evaluation.final_signature !== undefined) {
        addIssue(ctx, ["final_signature"], "a dropped lineage cannot have a final signature");
      }
    }
  },
);

export type PolicyEvaluation = z.infer<typeof PolicyEvaluationSchema>;

const RanPolicyPassSummarySchema = z
  .object({
    pass_id: PolicyPassIdSchema,
    status: z.literal("ran"),
    considered: z.number().int().nonnegative(),
    opportunities: z.number().int().nonnegative(),
    would_apply: z.number().int().nonnegative(),
    applied: z.number().int().nonnegative(),
    protected: z.number().int().nonnegative(),
    blocking_removed: z.number().int().nonnegative(),
    blocking_preserved: z.number().int().nonnegative(),
    dropped: z.number().int().nonnegative(),
  })
  .strict();

const InactivePolicyPassSummarySchema = z
  .object({
    pass_id: PolicyPassIdSchema,
    status: z.enum(["not-run", "error"]),
    reason_code: PolicyReasonCodeSchema,
  })
  .strict();

export const PolicyPassSummarySchema = z
  .discriminatedUnion("status", [RanPolicyPassSummarySchema, InactivePolicyPassSummarySchema])
  .superRefine((summary, ctx) => {
    const pass = policyPass(summary.pass_id);

    if (summary.status !== "ran") {
      if (summary.status === "not-run" && !NOT_RUN_REASON_CODES.has(summary.reason_code)) {
        addIssue(ctx, ["reason_code"], "not-run summaries require a closed inactivity reason");
      }
      if (summary.status === "error" && summary.reason_code !== PASS_ERROR_REASON_CODE) {
        addIssue(ctx, ["reason_code"], `error summaries require ${PASS_ERROR_REASON_CODE}`);
      }
      return;
    }

    const relationships: Array<[boolean, keyof typeof summary, string]> = [
      [summary.opportunities <= summary.considered, "opportunities", "opportunities > considered"],
      [summary.would_apply <= summary.opportunities, "would_apply", "would_apply > opportunities"],
      [summary.applied <= summary.would_apply, "applied", "applied > would_apply"],
      [summary.protected <= summary.would_apply, "protected", "protected > would_apply"],
      [
        summary.applied + summary.protected <= summary.would_apply,
        "protected",
        "applied + protected > would_apply",
      ],
      [
        summary.blocking_removed <= summary.applied,
        "blocking_removed",
        "blocking_removed > applied",
      ],
      [
        summary.blocking_preserved <= summary.would_apply,
        "blocking_preserved",
        "blocking_preserved > would_apply",
      ],
      [
        summary.blocking_removed + summary.blocking_preserved <= summary.would_apply,
        "blocking_preserved",
        "blocking results > would_apply",
      ],
      [summary.dropped <= summary.applied, "dropped", "dropped > applied"],
      [
        summary.blocking_removed + summary.blocking_preserved + summary.dropped <=
          summary.would_apply,
        "dropped",
        "blocking results + dropped > would_apply",
      ],
    ];
    for (const [valid, path, message] of relationships) {
      if (!valid) addIssue(ctx, [path], message);
    }

    if (summary.protected > 0 && !passAllowsAction(pass, "protected")) {
      addIssue(ctx, ["protected"], `${summary.pass_id} has no protection action`);
    }
    if (summary.dropped > 0 && !passAllowsAction(pass, "dropped")) {
      addIssue(ctx, ["dropped"], `${summary.pass_id} has no drop action`);
    }
    if (
      summary.blocking_removed > 0 &&
      !pass.material_transitions.some(
        (transition) =>
          transition.before !== "INFO" &&
          (transition.after === null || transition.after === "INFO"),
      )
    ) {
      addIssue(ctx, ["blocking_removed"], `${summary.pass_id} cannot remove blocking status`);
    }

    const allTransitionsStartBlocking = pass.material_transitions.every(
      (transition) => transition.before !== "INFO",
    );
    if (
      allTransitionsStartBlocking &&
      summary.blocking_removed + summary.blocking_preserved !== summary.would_apply
    ) {
      addIssue(
        ctx,
        ["blocking_preserved"],
        `${summary.pass_id} must account for every matched blocking outcome`,
      );
    }

    const allTransitionsRemoveBlocking =
      allTransitionsStartBlocking &&
      pass.material_transitions.every(
        (transition) => transition.after === null || transition.after === "INFO",
      );
    if (allTransitionsRemoveBlocking && summary.blocking_removed !== summary.applied) {
      addIssue(
        ctx,
        ["blocking_removed"],
        `${summary.pass_id} must count every applied transition as blocking removed`,
      );
    }
  });

export type PolicyPassSummary = z.infer<typeof PolicyPassSummarySchema>;

const PolicyStageEvaluationObjectSchema = z
  .object({
    stage_id: PolicyStageIdSchema,
    order: z.number().int().positive(),
    reason_code: PolicyReasonCodeSchema,
    member_count: z.number().int().positive().optional(),
    input_signatures: UniqueSignaturesSchema,
    output_signature: z.string().min(1).optional(),
    verdict: StageVerdictSchema.optional(),
  })
  .strict();

export const PolicyStageEvaluationSchema = PolicyStageEvaluationObjectSchema.superRefine(
  (evaluation, ctx) => {
    const stage = policyStage(evaluation.stage_id);
    if (evaluation.order !== stage.order) {
      addIssue(ctx, ["order"], `order must match ${evaluation.stage_id} (${stage.order})`);
    }
    if (!stage.reason_codes.some((reason) => reason === evaluation.reason_code)) {
      addIssue(ctx, ["reason_code"], `reason is not allowed for ${evaluation.stage_id}`);
    }

    if (evaluation.stage_id === "aggregation.cluster") {
      if (evaluation.member_count === undefined) {
        addIssue(ctx, ["member_count"], "a cluster stage requires member_count");
      } else if (evaluation.member_count < evaluation.input_signatures.length) {
        addIssue(
          ctx,
          ["member_count"],
          "member_count cannot be smaller than the unique input signature count",
        );
      }
      if (evaluation.input_signatures.length === 0) {
        addIssue(ctx, ["input_signatures"], "a cluster stage requires input signatures");
      }
      if (evaluation.output_signature === undefined) {
        addIssue(ctx, ["output_signature"], "a cluster stage requires an output signature");
      } else if (!evaluation.input_signatures.includes(evaluation.output_signature)) {
        addIssue(ctx, ["output_signature"], "the cluster representative must be an input");
      }
      if (evaluation.verdict !== undefined) {
        addIssue(ctx, ["verdict"], "a cluster stage cannot carry a verdict");
      }
      if (evaluation.reason_code === "singleton" && evaluation.member_count !== 1) {
        addIssue(ctx, ["reason_code"], "singleton requires member_count 1");
      }
      if (
        evaluation.reason_code === "clustered" &&
        (evaluation.member_count === undefined || evaluation.member_count < 2)
      ) {
        addIssue(ctx, ["reason_code"], "clustered requires member_count at least 2");
      }
      return;
    }

    if (evaluation.member_count !== undefined) {
      addIssue(ctx, ["member_count"], "the verdict stage cannot carry member_count");
    }
    if (evaluation.output_signature !== undefined) {
      addIssue(ctx, ["output_signature"], "the verdict stage cannot carry an output signature");
    }
    if (evaluation.verdict === undefined) {
      addIssue(ctx, ["verdict"], "the verdict stage requires a verdict");
    } else {
      const expectedVerdict =
        VERDICT_BY_REASON[evaluation.reason_code as keyof typeof VERDICT_BY_REASON];
      if (expectedVerdict !== undefined && evaluation.verdict !== expectedVerdict) {
        addIssue(ctx, ["verdict"], `${evaluation.reason_code} requires verdict ${expectedVerdict}`);
      }
    }
    if (
      evaluation.reason_code === "no-blocking-findings" &&
      evaluation.input_signatures.length !== 0
    ) {
      addIssue(ctx, ["input_signatures"], "no-blocking-findings requires no blocking signatures");
    }
    if (
      evaluation.reason_code !== "no-blocking-findings" &&
      evaluation.input_signatures.length === 0
    ) {
      addIssue(ctx, ["input_signatures"], "a blocking verdict reason requires a signature");
    }
  },
);

export type PolicyStageEvaluation = z.infer<typeof PolicyStageEvaluationSchema>;

const PolicyFinalFindingSeveritySchema = z
  .object({
    signature: z.string().min(1),
    severity: PolicySeveritySchema,
  })
  .strict();

export const PolicyTraceFinalSchema = z
  .object({
    verdict: TraceVerdictSchema,
    counts: z
      .object({
        critical: z.number().int().nonnegative(),
        warn: z.number().int().nonnegative(),
        info: z.number().int().nonnegative(),
      })
      .strict(),
    finding_signatures: UniqueSignaturesSchema,
    finding_severities: z.array(PolicyFinalFindingSeveritySchema),
  })
  .strict()
  .superRefine((final, ctx) => {
    const count = final.counts.critical + final.counts.warn + final.counts.info;
    if (count !== final.finding_signatures.length) {
      addIssue(ctx, ["finding_signatures"], "final counts must match final finding signatures");
    }
    if (final.finding_severities.length !== final.finding_signatures.length) {
      addIssue(
        ctx,
        ["finding_severities"],
        "final severity evidence must match final finding cardinality",
      );
    }
    for (const [index, signature] of final.finding_signatures.entries()) {
      if (final.finding_severities[index]?.signature !== signature) {
        addIssue(
          ctx,
          ["finding_severities", index, "signature"],
          "final severity evidence must preserve finding signature order",
        );
      }
    }
    const derivedCounts = { critical: 0, warn: 0, info: 0 };
    for (const finding of final.finding_severities) {
      if (finding.severity === "CRITICAL") derivedCounts.critical += 1;
      else if (finding.severity === "WARN") derivedCounts.warn += 1;
      else derivedCounts.info += 1;
    }
    for (const severity of ["critical", "warn", "info"] as const) {
      if (final.counts[severity] !== derivedCounts[severity]) {
        addIssue(
          ctx,
          ["counts", severity],
          `${severity} count disagrees with final severity evidence`,
        );
      }
    }
    const blocking = final.counts.critical + final.counts.warn;
    if (final.verdict === "PASS" && blocking !== 0) {
      addIssue(ctx, ["verdict"], "PASS requires zero blocking findings");
    }
    if ((final.verdict === "SOFT-PASS" || final.verdict === "FAIL") && blocking === 0) {
      addIssue(ctx, ["verdict"], `${final.verdict} requires at least one blocking finding`);
    }
    if (final.verdict === "ERROR" && count !== 0) {
      addIssue(ctx, ["verdict"], "ERROR cannot carry canonical findings");
    }
  });

export type PolicyTraceFinal = z.infer<typeof PolicyTraceFinalSchema>;

function validateOrderedPassRows(
  rows: readonly PolicyPassSummary[],
  ctx: z.RefinementCtx,
  path: Array<string | number>,
): void {
  if (rows.length !== POLICY_PASS_IDS.length) {
    addIssue(ctx, path, `passes must contain exactly ${POLICY_PASS_IDS.length} rows`);
    return;
  }
  for (const [index, expected] of POLICY_PASS_IDS.entries()) {
    if (rows[index]?.pass_id !== expected) {
      addIssue(ctx, [...path, index, "pass_id"], `expected ordered pass ${expected}`);
    }
  }
}

function validateArtifactState(
  value: {
    status: z.infer<typeof PolicyTraceStatusSchema>;
    policy_trace_ref?: string | undefined;
    policy_trace_sha256?: string | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.status === "complete") {
    if (value.policy_trace_ref === undefined) {
      addIssue(ctx, ["policy_trace_ref"], "complete requires policy_trace_ref");
    }
    if (value.policy_trace_sha256 === undefined) {
      addIssue(ctx, ["policy_trace_sha256"], "complete requires policy_trace_sha256");
    }
    return;
  }
  if (value.policy_trace_ref !== undefined) {
    addIssue(ctx, ["policy_trace_ref"], `${value.status} forbids policy_trace_ref`);
  }
  if (value.policy_trace_sha256 !== undefined) {
    addIssue(ctx, ["policy_trace_sha256"], `${value.status} forbids policy_trace_sha256`);
  }
}

export const PolicySummarySchema = z
  .object({
    catalog_version: z.literal(POLICY_CATALOG_VERSION),
    status: PolicyTraceStatusSchema,
    passes: z.array(PolicyPassSummarySchema),
    policy_trace_ref: z.string().min(1).optional(),
    policy_trace_sha256: PolicySha256Schema.optional(),
  })
  .strict()
  .superRefine((summary, ctx) => {
    validateOrderedPassRows(summary.passes, ctx, ["passes"]);
    validateArtifactState(summary, ctx);
    if (summary.status === "not-run") {
      for (const [index, pass] of summary.passes.entries()) {
        if (pass.status !== "not-run") {
          addIssue(
            ctx,
            ["passes", index, "status"],
            "a not-run policy summary requires every pass to be not-run",
          );
        }
      }
    }
  });

export type PolicySummary = z.infer<typeof PolicySummarySchema>;

const PolicyTraceObjectSchema = z
  .object({
    schema: z.literal("reviewgate.policy-trace.v1"),
    catalog_version: z.literal(POLICY_CATALOG_VERSION),
    run_id: z.string().min(1),
    iter: z.number().int().nonnegative(),
    ablated: z.array(PolicyPassIdSchema),
    raw_response_sha256: z.array(PolicySha256Schema),
    passes: z.array(PolicyPassSummarySchema),
    evaluations: z.array(PolicyEvaluationSchema),
    stages: z.array(PolicyStageEvaluationSchema),
    final: PolicyTraceFinalSchema,
  })
  .strict();

export const PolicyTraceSchema = PolicyTraceObjectSchema.superRefine((trace, ctx) => {
  validateOrderedPassRows(trace.passes, ctx, ["passes"]);

  if (trace.final.verdict === "ERROR") {
    addIssue(
      ctx,
      ["final", "verdict"],
      "a complete policy trace requires a representable verdict.compute result",
    );
  }

  const ablatedPasses = new Set<PolicyPassId>(trace.ablated);
  const ablatedOrders = trace.ablated.map((passId) => policyPass(passId).order);
  for (let index = 1; index < trace.ablated.length; index += 1) {
    const previous = ablatedOrders[index - 1];
    const current = ablatedOrders[index];
    if (previous === undefined || current === undefined || previous >= current) {
      addIssue(ctx, ["ablated", index], "ablated pass IDs must be catalog-ordered and unique");
    }
  }

  let priorEvaluationOrder = -1;
  const evaluationsByPass = new Map<PolicyPassId, PolicyEvaluation[]>();
  const finalSignatures = new Set(trace.final.finding_signatures);
  const firstLoreIndex = trace.final.finding_signatures.findIndex((signature) =>
    LORE_FINAL_SIGNATURE.test(signature),
  );
  const policyFinalSignatures =
    firstLoreIndex < 0
      ? trace.final.finding_signatures
      : trace.final.finding_signatures.slice(0, firstLoreIndex);
  const policyFinalSignatureSet = new Set(policyFinalSignatures);
  if (firstLoreIndex >= 0) {
    for (let index = firstLoreIndex; index < trace.final.finding_signatures.length; index += 1) {
      const signature = trace.final.finding_signatures[index];
      const severity = trace.final.finding_severities[index]?.severity;
      if (signature === undefined || !LORE_FINAL_SIGNATURE.test(signature)) {
        addIssue(
          ctx,
          ["final", "finding_signatures", index],
          "server-owned Lore findings must form one closed suffix",
        );
      }
      if (severity !== "INFO") {
        addIssue(
          ctx,
          ["final", "finding_severities", index, "severity"],
          "server-owned Lore findings must remain INFO",
        );
      }
    }
  }
  for (const [index, evaluation] of trace.evaluations.entries()) {
    if (evaluation.order < priorEvaluationOrder) {
      addIssue(ctx, ["evaluations", index, "order"], "evaluations must remain in catalog order");
    }
    priorEvaluationOrder = evaluation.order;
    const rows = evaluationsByPass.get(evaluation.pass_id) ?? [];
    rows.push(evaluation);
    evaluationsByPass.set(evaluation.pass_id, rows);
    if (evaluation.result === "applied" && ablatedPasses.has(evaluation.pass_id)) {
      addIssue(ctx, ["evaluations", index, "result"], "an ablated pass cannot apply");
    }
    if (evaluation.result === "would-apply" && !ablatedPasses.has(evaluation.pass_id)) {
      addIssue(
        ctx,
        ["evaluations", index, "result"],
        "would-apply requires the pass to be ablated",
      );
    }
    if (
      evaluation.final_signature !== undefined &&
      !finalSignatures.has(evaluation.final_signature)
    ) {
      addIssue(ctx, ["evaluations", index, "final_signature"], "unknown final signature");
    }
    if (
      evaluation.final_signature !== undefined &&
      LORE_FINAL_SIGNATURE.test(evaluation.final_signature)
    ) {
      addIssue(
        ctx,
        ["evaluations", index, "final_signature"],
        "Lore findings cannot mask policy evaluation lineage",
      );
    }
  }

  for (const [index, summary] of trace.passes.entries()) {
    const evaluations = evaluationsByPass.get(summary.pass_id) ?? [];
    if (summary.status !== "ran") {
      if (evaluations.length > 0) {
        addIssue(ctx, ["passes", index], "an inactive pass cannot have evaluations");
      }
      continue;
    }

    const actual = {
      considered: evaluations.length,
      opportunities: evaluations.filter((row) => row.result !== "no-opportunity").length,
      would_apply: evaluations.filter(
        (row) =>
          row.result === "would-apply" || row.result === "protected" || row.result === "applied",
      ).length,
      applied: evaluations.filter((row) => row.result === "applied").length,
      protected: evaluations.filter((row) => row.result === "protected").length,
      blocking_removed: evaluations.filter(
        (row) =>
          row.result === "applied" &&
          row.before !== "INFO" &&
          (row.after === null || row.after === "INFO"),
      ).length,
      blocking_preserved: evaluations.filter(
        (row) =>
          (row.result === "would-apply" ||
            row.result === "protected" ||
            row.result === "applied") &&
          row.before !== "INFO" &&
          row.after !== null &&
          row.after !== "INFO",
      ).length,
      dropped: evaluations.filter((row) => row.result === "applied" && row.after === null).length,
    };

    for (const key of Object.keys(actual) as Array<keyof typeof actual>) {
      if (summary[key] !== actual[key]) {
        addIssue(ctx, ["passes", index, key], `${key} disagrees with policy evaluations`);
      }
    }
  }

  let priorStageOrder = -1;
  const clusterOutputs: string[] = [];
  const clusterOutputSet = new Set<string>();
  const clusterOutputByInput = new Map<string, string>();
  let verdictRows = 0;
  let verdictStage: PolicyStageEvaluation | undefined;
  let verdictStageIndex = -1;
  for (const [index, stage] of trace.stages.entries()) {
    if (stage.order < priorStageOrder) {
      addIssue(ctx, ["stages", index, "order"], "stages must remain in catalog order");
    }
    priorStageOrder = stage.order;
    if (stage.stage_id === "aggregation.cluster" && stage.output_signature !== undefined) {
      if (LORE_FINAL_SIGNATURE.test(stage.output_signature)) {
        addIssue(
          ctx,
          ["stages", index, "output_signature"],
          "Lore findings cannot be policy cluster outputs",
        );
      }
      if (clusterOutputSet.has(stage.output_signature)) {
        addIssue(ctx, ["stages", index, "output_signature"], "duplicate cluster output");
      }
      clusterOutputs.push(stage.output_signature);
      clusterOutputSet.add(stage.output_signature);
      for (const [inputIndex, input] of stage.input_signatures.entries()) {
        if (LORE_FINAL_SIGNATURE.test(input)) {
          addIssue(
            ctx,
            ["stages", index, "input_signatures", inputIndex],
            "Lore findings cannot be policy cluster inputs",
          );
        }
        if (clusterOutputByInput.has(input)) {
          addIssue(
            ctx,
            ["stages", index, "input_signatures", inputIndex],
            "a cluster input must map to exactly one output",
          );
        } else {
          clusterOutputByInput.set(input, stage.output_signature);
        }
      }
    }
    if (stage.stage_id === "verdict.compute") {
      verdictRows += 1;
      if (verdictStage === undefined) {
        verdictStage = stage;
        verdictStageIndex = index;
      }
      if (trace.final.verdict !== "ERROR" && stage.verdict !== trace.final.verdict) {
        addIssue(ctx, ["stages", index, "verdict"], "stage verdict disagrees with final verdict");
      }
    }
  }
  if (verdictRows !== 1) {
    addIssue(ctx, ["stages"], "a complete trace requires exactly one verdict.compute row");
  }

  if (!isOrderedSubsequence(policyFinalSignatures, clusterOutputs)) {
    addIssue(ctx, ["stages"], "final finding signatures must preserve cluster output order");
  }

  const droppedOutputs = new Map<string, number>();
  for (const [index, evaluation] of trace.evaluations.entries()) {
    const lineageOutputs = new Set<string>();
    for (const [sourceIndex, source] of evaluation.source_signatures.entries()) {
      const output = clusterOutputByInput.get(source);
      if (output === undefined) {
        addIssue(
          ctx,
          ["evaluations", index, "source_signatures", sourceIndex],
          "evaluation lineage must reference an aggregation cluster input",
        );
      } else {
        lineageOutputs.add(output);
      }
    }
    if (lineageOutputs.size !== 1) {
      addIssue(
        ctx,
        ["evaluations", index, "source_signatures"],
        "evaluation lineage must resolve to exactly one cluster output",
      );
      continue;
    }

    const [output] = lineageOutputs;
    if (output === undefined) continue;
    const appliedDrop = evaluation.result === "applied" && evaluation.after === null;
    const survives = policyFinalSignatureSet.has(output);

    if (appliedDrop) {
      if (survives) {
        addIssue(
          ctx,
          ["evaluations", index, "source_signatures"],
          "an applied-drop cluster output cannot remain in final findings",
        );
      }
      if (droppedOutputs.has(output)) {
        addIssue(
          ctx,
          ["evaluations", index, "source_signatures"],
          "a cluster output can have only one applied drop",
        );
      } else {
        droppedOutputs.set(output, index);
      }
    }

    if (survives && evaluation.final_signature !== output) {
      addIssue(
        ctx,
        ["evaluations", index, "final_signature"],
        "a surviving evaluation must name its resolved cluster output",
      );
    }
    if (!survives && evaluation.final_signature !== undefined) {
      addIssue(
        ctx,
        ["evaluations", index, "final_signature"],
        "a non-surviving evaluation cannot name a final signature",
      );
    }
  }

  for (const [index, signature] of clusterOutputs.entries()) {
    if (!policyFinalSignatureSet.has(signature) && !droppedOutputs.has(signature)) {
      addIssue(ctx, ["stages", index], "a non-final cluster output requires a later applied drop");
    }
  }

  if (verdictStage !== undefined) {
    const blockingSignatures = trace.final.finding_severities
      .filter((finding) => finding.severity !== "INFO")
      .map((finding) => finding.signature);
    if (
      verdictStage.input_signatures.length !== blockingSignatures.length ||
      verdictStage.input_signatures.some(
        (signature, index) => signature !== blockingSignatures[index],
      )
    ) {
      addIssue(
        ctx,
        ["stages", verdictStageIndex, "input_signatures"],
        "verdict inputs must exactly equal ordered final blocking signatures",
      );
    }
    if (verdictStage.reason_code === "hard-critical" && trace.final.counts.critical === 0) {
      addIssue(
        ctx,
        ["stages", verdictStageIndex, "reason_code"],
        "hard-critical requires at least one final CRITICAL finding",
      );
    }
    if (verdictStage.reason_code === "corroborated-warn" && trace.final.counts.warn === 0) {
      addIssue(
        ctx,
        ["stages", verdictStageIndex, "reason_code"],
        "corroborated-warn requires at least one final WARN finding",
      );
    }
  }
});

export type PolicyTrace = z.infer<typeof PolicyTraceSchema>;
