import type { Finding } from "../../schemas/finding.ts";
import {
  type PolicyEffect,
  PolicyEffectSchema,
  PolicyEffectsSchema,
  type PolicyEvaluation,
  PolicyEvaluationSchema,
  type PolicyPassSummary,
  PolicyPassSummarySchema,
  type PolicyStageEvaluation,
  PolicyStageEvaluationSchema,
  type PolicyTrace,
  PolicyTraceSchema,
} from "../../schemas/policy-trace.ts";
import {
  POLICY_PASSES,
  POLICY_STAGES,
  type PolicyEffectAction,
  type PolicyPassId,
  type PolicyProtectionCode,
  type PolicyReasonCode,
  type PolicyStageId,
} from "./catalog.ts";

type RanPolicyPassSummary = Extract<PolicyPassSummary, { status: "ran" }>;
type TraceVerdict = PolicyTrace["final"]["verdict"];

const PASS_BY_ID = new Map(POLICY_PASSES.map((pass) => [pass.id, pass]));
const STAGE_BY_ID = new Map(POLICY_STAGES.map((stage) => [stage.id, stage]));

export interface TransitionInput {
  readonly runtime?: PolicyRuntime;
  readonly passId: PolicyPassId;
  readonly finding: Finding;
  readonly opportunity: boolean;
  readonly matched: boolean;
  readonly reasonCode: PolicyReasonCode;
  readonly action: PolicyEffectAction;
  readonly protectedBy?: PolicyProtectionCode;
  readonly sourceSignatures?: readonly string[];
  readonly proposed: () => Finding | null;
}

export type RecordPolicyStageInput =
  | {
      readonly stageId: Extract<PolicyStageId, "aggregation.cluster">;
      readonly reasonCode: PolicyReasonCode;
      readonly memberCount: number;
      readonly inputSignatures: readonly string[];
      readonly outputSignature: string;
      readonly verdict?: never;
    }
  | {
      readonly stageId: Extract<PolicyStageId, "verdict.compute">;
      readonly reasonCode: PolicyReasonCode;
      readonly memberCount?: never;
      readonly inputSignatures: readonly string[];
      readonly outputSignature?: never;
      readonly verdict: Exclude<TraceVerdict, "ERROR">;
    };

export interface FinalizePolicyTraceInput {
  readonly rawResponseSha256: readonly string[];
  readonly verdict: TraceVerdict;
  readonly finalFindings: readonly Pick<Finding, "signature" | "severity">[];
}

export interface PolicyRuntime {
  readonly telemetryError: boolean;
  transition(input: TransitionInput): Finding | null;
  summary(passId: PolicyPassId): PolicyPassSummary;
  evaluations(): PolicyEvaluation[];
  recordStage(input: RecordPolicyStageInput): void;
  linkFinal(inputSignatures: readonly string[], finalSignature: string): void;
  finalize(input: FinalizePolicyTraceInput): PolicyTrace | null;
}

export interface StartPolicyTraceInput {
  readonly runId: string;
  readonly iter: number;
  readonly ablated: readonly PolicyPassId[] | ReadonlySet<PolicyPassId>;
}

function compareByteOrder(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareByteOrder);
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function effectIdentity(effect: PolicyEffect): string {
  return JSON.stringify([
    effect.pass_id,
    effect.action,
    effect.before,
    effect.after,
    effect.reason_code,
    effect.protected_by ?? null,
    effect.source_signatures,
  ]);
}

export function mergePolicyEffects(
  ...groups: Array<readonly PolicyEffect[] | undefined>
): PolicyEffect[] {
  const byIdentity = new Map<string, PolicyEffect>();
  for (const effect of groups.flatMap((group) => group ?? [])) {
    const parsed = PolicyEffectSchema.parse(effect);
    byIdentity.set(effectIdentity(parsed), parsed);
  }

  const merged = [...byIdentity.entries()]
    .sort(
      ([leftIdentity, left], [rightIdentity, right]) =>
        left.order - right.order || compareByteOrder(leftIdentity, rightIdentity),
    )
    .map(([, effect]) => effect);
  return PolicyEffectsSchema.parse(merged);
}

function emptySummary(passId: PolicyPassId): RanPolicyPassSummary {
  return {
    pass_id: passId,
    status: "ran",
    considered: 0,
    opportunities: 0,
    would_apply: 0,
    applied: 0,
    protected: 0,
    blocking_removed: 0,
    blocking_preserved: 0,
    dropped: 0,
  };
}

function copyEvaluation(evaluation: PolicyEvaluation): PolicyEvaluation {
  return {
    ...evaluation,
    source_signatures: [...evaluation.source_signatures],
  };
}

function countFinalFindings(
  findings: readonly Pick<Finding, "signature" | "severity">[],
): PolicyTrace["final"]["counts"] {
  const counts = { critical: 0, warn: 0, info: 0 };
  for (const finding of findings) {
    if (finding.severity === "CRITICAL") counts.critical += 1;
    else if (finding.severity === "WARN") counts.warn += 1;
    else counts.info += 1;
  }
  return counts;
}

export class PolicyTraceRecorder implements PolicyRuntime {
  readonly #runId: string;
  readonly #iter: number;
  readonly #ablated: ReadonlySet<PolicyPassId>;
  readonly #summaries = new Map<PolicyPassId, RanPolicyPassSummary>();
  readonly #evaluations: PolicyEvaluation[] = [];
  readonly #stages: PolicyStageEvaluation[] = [];
  readonly #finalBySource = new Map<string, string>();
  #telemetryError = false;

  private constructor(input: StartPolicyTraceInput) {
    this.#runId = input.runId;
    this.#iter = input.iter;
    this.#ablated = new Set(input.ablated);
    for (const pass of POLICY_PASSES) this.#summaries.set(pass.id, emptySummary(pass.id));
  }

  static start(input: StartPolicyTraceInput): PolicyTraceRecorder {
    return new PolicyTraceRecorder(input);
  }

  get telemetryError(): boolean {
    return this.#telemetryError;
  }

  transition(input: TransitionInput): Finding | null {
    // These are production inputs. Read them and calculate the production result
    // before entering the fail-open telemetry boundary so their errors propagate.
    const finding = input.finding;
    const opportunity = input.opportunity;
    const matched = input.matched;
    const protectedBy = input.protectedBy;
    const productionResult = matched && protectedBy === undefined ? input.proposed() : finding;
    const ablated = this.#ablated.has(input.passId);

    try {
      if (!opportunity) {
        if (matched) throw new Error("a matched policy transition requires an opportunity");
        this.#recordEvaluation({
          pass_id: input.passId,
          result: "no-opportunity",
          before: finding.severity,
          after: finding.severity,
          reason_code: "ineligible-starting-state",
          source_signatures: this.#sourceSignatures(input, finding),
        });
        return finding;
      }

      if (!matched) {
        this.#recordEvaluation({
          pass_id: input.passId,
          result: "no-match",
          before: finding.severity,
          after: finding.severity,
          reason_code: "predicate-miss",
          source_signatures: this.#sourceSignatures(input, finding),
        });
        return finding;
      }

      const sourceSignatures = this.#sourceSignatures(input, finding);
      if (protectedBy !== undefined) {
        const effect = PolicyEffectSchema.parse({
          pass_id: input.passId,
          order: this.#passOrder(input.passId),
          action: "protected",
          before: finding.severity,
          after: finding.severity,
          reason_code: input.reasonCode,
          protected_by: protectedBy,
          source_signatures: sourceSignatures,
        });
        this.#recordEvaluation(
          {
            pass_id: input.passId,
            result: "protected",
            before: finding.severity,
            after: finding.severity,
            reason_code: input.reasonCode,
            protected_by: protectedBy,
            source_signatures: sourceSignatures,
          },
          effect,
        );
        return {
          ...finding,
          policy_effects: mergePolicyEffects(finding.policy_effects, [effect]),
        };
      }

      if (ablated) {
        this.#recordEvaluation({
          pass_id: input.passId,
          result: "would-apply",
          before: finding.severity,
          after: finding.severity,
          reason_code: input.reasonCode,
          source_signatures: sourceSignatures,
        });
        return finding;
      }

      const after = productionResult?.severity ?? null;
      const effect = PolicyEffectSchema.parse({
        pass_id: input.passId,
        order: this.#passOrder(input.passId),
        action: input.action,
        before: finding.severity,
        after,
        reason_code: input.reasonCode,
        source_signatures: sourceSignatures,
      });
      this.#recordEvaluation(
        {
          pass_id: input.passId,
          result: "applied",
          before: finding.severity,
          after,
          reason_code: input.reasonCode,
          source_signatures: sourceSignatures,
        },
        effect,
      );
      if (productionResult === null) return null;
      return {
        ...productionResult,
        policy_effects: mergePolicyEffects(
          finding.policy_effects,
          productionResult.policy_effects,
          [effect],
        ),
      };
    } catch {
      this.#telemetryError = true;
      return ablated ? finding : productionResult;
    }
  }

  summary(passId: PolicyPassId): PolicyPassSummary {
    const summary = this.#summaries.get(passId);
    if (summary === undefined) throw new Error(`unknown policy pass: ${passId}`);
    return { ...summary };
  }

  evaluations(): PolicyEvaluation[] {
    return this.#evaluations.map(copyEvaluation);
  }

  recordStage(input: RecordPolicyStageInput): void {
    try {
      const stage = STAGE_BY_ID.get(input.stageId);
      if (stage === undefined) throw new Error(`unknown policy stage: ${input.stageId}`);
      const candidate = {
        stage_id: input.stageId,
        order: stage.order,
        reason_code: input.reasonCode,
        ...(input.memberCount === undefined ? {} : { member_count: input.memberCount }),
        input_signatures: uniqueInOrder(input.inputSignatures),
        ...(input.outputSignature === undefined ? {} : { output_signature: input.outputSignature }),
        ...(input.verdict === undefined ? {} : { verdict: input.verdict }),
      };
      this.#stages.push(PolicyStageEvaluationSchema.parse(candidate));
    } catch {
      this.#telemetryError = true;
    }
  }

  linkFinal(inputSignatures: readonly string[], finalSignature: string): void {
    try {
      const sources = sortedUnique(inputSignatures);
      if (sources.length === 0 || !sources.includes(finalSignature)) {
        throw new Error("final signature must be one of the cluster inputs");
      }
      for (const source of sources) {
        const existing = this.#finalBySource.get(source);
        if (existing !== undefined && existing !== finalSignature) {
          throw new Error(`policy lineage ${source} already links to ${existing}`);
        }
      }
      for (const source of sources) this.#finalBySource.set(source, finalSignature);
    } catch {
      this.#telemetryError = true;
    }
  }

  finalize(input: FinalizePolicyTraceInput): PolicyTrace | null {
    if (this.#telemetryError) return null;
    try {
      const finalSignatures = new Set(input.finalFindings.map((finding) => finding.signature));
      const evaluations = this.#evaluations
        .map((evaluation) => {
          const linked = new Set(
            evaluation.source_signatures
              .map((source) => this.#finalBySource.get(source))
              .filter((signature): signature is string => signature !== undefined),
          );
          const [finalSignature] = linked;
          return {
            ...copyEvaluation(evaluation),
            ...(linked.size === 1 &&
            finalSignature !== undefined &&
            finalSignatures.has(finalSignature)
              ? { final_signature: finalSignature }
              : {}),
          };
        })
        .sort((left, right) => left.order - right.order);
      const stages = this.#stages
        .map((stage, index) => ({ stage, index }))
        .sort((left, right) => left.stage.order - right.stage.order || left.index - right.index)
        .map(({ stage }) => ({ ...stage, input_signatures: [...stage.input_signatures] }));
      const final = {
        verdict: input.verdict,
        counts: countFinalFindings(input.finalFindings),
        finding_signatures: input.finalFindings.map((finding) => finding.signature),
        finding_severities: input.finalFindings.map((finding) => ({
          signature: finding.signature,
          severity: finding.severity,
        })),
      };
      return PolicyTraceSchema.parse({
        schema: "reviewgate.policy-trace.v1",
        catalog_version: "reviewgate.policy-catalog.v1",
        run_id: this.#runId,
        iter: this.#iter,
        ablated: POLICY_PASSES.filter((pass) => this.#ablated.has(pass.id)).map((pass) => pass.id),
        raw_response_sha256: [...input.rawResponseSha256],
        passes: POLICY_PASSES.map((pass) => this.summary(pass.id)),
        evaluations,
        stages,
        final,
      });
    } catch {
      this.#telemetryError = true;
      return null;
    }
  }

  #passOrder(passId: PolicyPassId): number {
    const pass = PASS_BY_ID.get(passId);
    if (pass === undefined) throw new Error(`unknown policy pass: ${passId}`);
    return pass.order;
  }

  #sourceSignatures(input: TransitionInput, finding: Finding): string[] {
    return sortedUnique(input.sourceSignatures ?? [finding.signature]);
  }

  #recordEvaluation(
    input: Omit<PolicyEvaluation, "order" | "final_signature">,
    effect?: PolicyEffect,
  ): void {
    if (effect !== undefined) PolicyEffectSchema.parse(effect);
    const evaluation = PolicyEvaluationSchema.parse({
      ...input,
      order: this.#passOrder(input.pass_id),
    });
    const current = this.#summaries.get(evaluation.pass_id);
    if (current === undefined) throw new Error(`unknown policy pass: ${evaluation.pass_id}`);
    const next: RanPolicyPassSummary = { ...current, considered: current.considered + 1 };

    if (evaluation.result !== "no-opportunity") next.opportunities += 1;
    if (
      evaluation.result === "would-apply" ||
      evaluation.result === "protected" ||
      evaluation.result === "applied"
    ) {
      next.would_apply += 1;
      if (evaluation.result === "protected") next.protected += 1;
      if (evaluation.result === "applied") {
        next.applied += 1;
        if (evaluation.after === null) next.dropped += 1;
      }
      if (evaluation.before !== "INFO") {
        if (
          evaluation.result === "applied" &&
          (evaluation.after === null || evaluation.after === "INFO")
        ) {
          next.blocking_removed += 1;
        } else if (evaluation.after !== null && evaluation.after !== "INFO") {
          next.blocking_preserved += 1;
        }
      }
    }

    const parsedSummary = PolicyPassSummarySchema.parse(next);
    if (parsedSummary.status !== "ran") throw new Error("recorded summary unexpectedly inactive");
    this.#summaries.set(evaluation.pass_id, parsedSummary);
    this.#evaluations.push(evaluation);
  }
}

export function transitionFinding(input: TransitionInput): Finding | null {
  // Access telemetry predicates before any runtime-owned fail-open boundary.
  void input.opportunity;
  const matched = input.matched;
  const protectedBy = input.protectedBy;
  if (input.runtime === undefined) {
    return matched && protectedBy === undefined ? input.proposed() : input.finding;
  }
  return input.runtime.transition(input);
}
