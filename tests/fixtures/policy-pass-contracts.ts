import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AggregateInput, aggregate } from "../../src/core/aggregator.ts";
import { validateFindingFacts } from "../../src/core/fact-check.ts";
import {
  type GroundingVerdict,
  applyGroundingJudgeVerdicts,
  groundFindings,
} from "../../src/core/grounding.ts";
import { demoteHypotheticalCriticals } from "../../src/core/hypothetical-demote.ts";
import {
  type PolicyPassId,
  type PolicyReasonCode,
  type PolicyStageId,
} from "../../src/core/policy/catalog.ts";
import { PolicyTraceRecorder } from "../../src/core/policy/trace.ts";
import { demoteSelfRefuting } from "../../src/core/self-refutation.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import type {
  PolicyEffect,
  PolicyEvaluation,
  PolicyPassSummary,
  PolicyStageEvaluation,
} from "../../src/schemas/policy-trace.ts";

export type PolicyNumericTuple = readonly [
  considered: number,
  opportunities: number,
  wouldApply: number,
  applied: number,
  protectedCount: number,
  blockingRemoved: number,
  blockingPreserved: number,
  dropped: number,
];

export interface PolicyContractScenario {
  tuple: PolicyNumericTuple;
  blocking: number;
  severities: Finding["severity"][];
  effects: PolicyEffect[];
  evaluations: PolicyEvaluation[];
}

export interface PolicyPassContractActual {
  noOpportunity: PolicyContractScenario;
  noMatch: PolicyContractScenario;
  active: PolicyContractScenario;
  ablated: PolicyContractScenario;
  protected?: PolicyContractScenario;
  inactive: PolicyPassSummary;
  variant?: PolicyContractScenario;
}

export interface PolicyPassContractExpected {
  noOpportunity: PolicyNumericTuple;
  noMatch: PolicyNumericTuple;
  active: PolicyNumericTuple;
  ablated: PolicyNumericTuple;
  protected?: PolicyNumericTuple;
  inactiveReason: Extract<PolicyReasonCode, "configured-off" | "stage-precondition-miss">;
  activeBlocking: number;
  ablatedBlocking: number;
  protectedBlocking?: number;
  activeSeverities: Finding["severity"][];
  ablatedSeverities: Finding["severity"][];
  protectedSeverities?: Finding["severity"][];
  variant?: {
    tuple: PolicyNumericTuple;
    blocking: number;
    severities: Finding["severity"][];
  };
}

export interface PolicyPassContract {
  passId: PolicyPassId;
  expected: PolicyPassContractExpected;
  run(): PolicyPassContractActual;
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    signature: "sig-policy",
    severity: "WARN",
    category: "quality",
    rule_id: "policy-contract",
    file: "src/a.ts",
    line_start: 10,
    line_end: 10,
    message: "A concrete policy finding",
    details: "The implementation has a concrete defect.",
    reviewer: { provider: "codex", model: "m", persona: "quality" },
    confidence: 0.9,
    consensus: "singleton",
    ...overrides,
  };
}

function runtime(runId: string, ablated: readonly PolicyPassId[] = []): PolicyTraceRecorder {
  return PolicyTraceRecorder.start({ runId, iter: 1, ablated });
}

function tuple(recorder: PolicyTraceRecorder, passId: PolicyPassId): PolicyNumericTuple {
  const summary = recorder.summary(passId);
  if (summary.status !== "ran") throw new Error(`${passId} did not run`);
  return [
    summary.considered,
    summary.opportunities,
    summary.would_apply,
    summary.applied,
    summary.protected,
    summary.blocking_removed,
    summary.blocking_preserved,
    summary.dropped,
  ];
}

function scenario(
  recorder: PolicyTraceRecorder,
  passId: PolicyPassId,
  findings: readonly Finding[],
): PolicyContractScenario {
  return {
    tuple: tuple(recorder, passId),
    blocking: findings.filter(({ severity }) => severity === "CRITICAL" || severity === "WARN")
      .length,
    severities: findings.map(({ severity }) => severity),
    effects: findings.flatMap(({ policy_effects }) => policy_effects ?? []),
    evaluations: recorder.evaluations().filter(({ pass_id }) => pass_id === passId),
  };
}

function inactive(
  passId: PolicyPassId,
  reasonCode: Extract<PolicyReasonCode, "configured-off" | "stage-precondition-miss">,
): PolicyPassSummary {
  const recorder = runtime(`${passId}-inactive`);
  recorder.markInactive(passId, reasonCode);
  return recorder.summary(passId);
}

function runPrePass(
  passId: PolicyPassId,
  runId: string,
  invoke: (recorder: PolicyTraceRecorder) => Finding[],
  ablated: readonly PolicyPassId[] = [],
): PolicyContractScenario {
  const recorder = runtime(runId, ablated);
  return scenario(recorder, passId, invoke(recorder));
}

function runAggregatePass(
  passId: PolicyPassId,
  runId: string,
  input: AggregateInput,
  ablated: readonly PolicyPassId[] = [],
): PolicyContractScenario {
  const recorder = runtime(runId, ablated);
  const result = aggregate({ ...input, policyRuntime: recorder });
  return scenario(recorder, passId, result.dedupedFindings);
}

function aggregateContract(
  passId: PolicyPassId,
  expected: PolicyPassContractExpected,
  inputs: {
    noOpportunity: AggregateInput;
    noMatch: AggregateInput;
    active: AggregateInput;
    protected?: AggregateInput;
    variant?: AggregateInput;
  },
): PolicyPassContract {
  return {
    passId,
    expected,
    run: () => ({
      noOpportunity: runAggregatePass(passId, `${passId}-no-opportunity`, inputs.noOpportunity),
      noMatch: runAggregatePass(passId, `${passId}-no-match`, inputs.noMatch),
      active: runAggregatePass(passId, `${passId}-active`, inputs.active),
      ablated: runAggregatePass(passId, `${passId}-ablated`, inputs.active, [passId]),
      ...(inputs.protected === undefined
        ? {}
        : {
            protected: runAggregatePass(
              passId,
              `${passId}-protected`,
              inputs.protected,
            ),
          }),
      inactive: inactive(passId, expected.inactiveReason),
      ...(inputs.variant === undefined
        ? {}
        : { variant: runAggregatePass(passId, `${passId}-variant`, inputs.variant) }),
    }),
  };
}

function factLocationContract(): PolicyPassContract {
  const passId = "evidence.fact-location" as const;
  const expected: PolicyPassContractExpected = {
    noOpportunity: [1, 0, 0, 0, 0, 0, 0, 0],
    noMatch: [1, 1, 0, 0, 0, 0, 0, 0],
    active: [1, 1, 1, 1, 0, 1, 0, 0],
    ablated: [1, 1, 1, 0, 0, 0, 1, 0],
    inactiveReason: "stage-precondition-miss",
    activeBlocking: 0,
    ablatedBlocking: 1,
    activeSeverities: ["INFO"],
    ablatedSeverities: ["WARN"],
    variant: { tuple: [1, 1, 1, 1, 0, 0, 1, 0], blocking: 1, severities: ["CRITICAL"] },
  };
  return {
    passId,
    expected,
    run: () => {
      const repoRoot = mkdtempSync(join(tmpdir(), "reviewgate-policy-contract-"));
      writeFileSync(join(repoRoot, "one-line.ts"), "const present = true;\n");
      try {
        const activeFinding = finding({ file: "one-line.ts", line_start: 9, line_end: 9 });
        const reanchorFinding = finding({
          severity: "CRITICAL",
          file: "one-line.ts",
          line_start: 99,
          line_end: 99,
          evidence_line: "const present = true;",
        });
        return {
          noOpportunity: runPrePass(passId, "fact-no-opportunity", (recorder) =>
            validateFindingFacts(
              [finding({ file: "absent.ts", line_start: 9, line_end: 9 })],
              repoRoot,
              new Set(),
              recorder,
            ),
          ),
          noMatch: runPrePass(passId, "fact-no-match", (recorder) =>
            validateFindingFacts(
              [finding({ file: "one-line.ts", line_start: 1, line_end: 1 })],
              repoRoot,
              new Set(),
              recorder,
            ),
          ),
          active: runPrePass(passId, "fact-active", (recorder) =>
            validateFindingFacts([activeFinding], repoRoot, new Set(), recorder),
          ),
          ablated: runPrePass(
            passId,
            "fact-ablated",
            (recorder) => validateFindingFacts([activeFinding], repoRoot, new Set(), recorder),
            [passId],
          ),
          inactive: inactive(passId, expected.inactiveReason),
          variant: runPrePass(passId, "fact-reanchor", (recorder) =>
            validateFindingFacts([reanchorFinding], repoRoot, new Set(), recorder),
          ),
        };
      } finally {
        rmSync(repoRoot, { recursive: true, force: true });
      }
    },
  };
}

function preAggregationContract(
  passId: PolicyPassId,
  expected: PolicyPassContractExpected,
  inputs: {
    noOpportunity: (recorder: PolicyTraceRecorder) => Finding[];
    noMatch: (recorder: PolicyTraceRecorder) => Finding[];
    active: (recorder: PolicyTraceRecorder) => Finding[];
    protected?: (recorder: PolicyTraceRecorder) => Finding[];
  },
): PolicyPassContract {
  return {
    passId,
    expected,
    run: () => ({
      noOpportunity: runPrePass(passId, `${passId}-no-opportunity`, inputs.noOpportunity),
      noMatch: runPrePass(passId, `${passId}-no-match`, inputs.noMatch),
      active: runPrePass(passId, `${passId}-active`, inputs.active),
      ablated: runPrePass(passId, `${passId}-ablated`, inputs.active, [passId]),
      ...(inputs.protected === undefined
        ? {}
        : { protected: runPrePass(passId, `${passId}-protected`, inputs.protected) }),
      inactive: inactive(passId, expected.inactiveReason),
    }),
  };
}

function sameFindingRunner(
  value: Finding,
  operation: (values: Finding[], recorder: PolicyTraceRecorder) => Finding[],
): (recorder: PolicyTraceRecorder) => Finding[] {
  return (recorder) => operation([value], recorder);
}

const selfActive = finding({ details: "Checked carefully. No issue." });
const hypotheticalActive = finding({
  severity: "CRITICAL",
  details: "This is currently safe, but a future change could break it.",
});
const tokenActive = finding({
  severity: "CRITICAL",
  details: "The --absent-token breaks the theme.",
});
const llmActive = finding({ severity: "CRITICAL" });
const llmUngrounded = new Map<string, GroundingVerdict>([
  [llmActive.signature, { grounded: false, reason: "not present" }],
]);

const redactionActive = finding({ message: "undefined variable <REDACTED:HIGH_ENTROPY>" });
const criticActive = finding({ signature: "sig-critic" });
const diffActive = finding({ line_start: 50, line_end: 50 });
const ranges = new Map([["src/a.ts", [[10, 14]] as Array<[number, number]>]]);
const fpInput = {
  findings: [finding()],
  reviewersTotal: 1,
  fpActive: new Map([["sig-policy", { id: "FP-001" }]]),
};
const cycleInput = {
  findings: [finding()],
  reviewersTotal: 1,
  cycleRejected: new Set(["sig-policy"]),
};
const activeCluster = new Map([
  ["policy@src/a.ts", { key: "policy@src/a.ts", member_ids: ["FP-001"] }],
]);
const clusterInput = {
  findings: [finding()],
  reviewersTotal: 1,
  fpActiveClusters: activeCluster,
};
const lowConfidence = finding({ confidence: 0.2 });
const reputationInput = {
  findings: [finding()],
  reviewersTotal: 1,
  repUnreliable: new Set(["codex:quality"]),
};
const rejectedRegion = {
  file: "src/a.ts",
  start_line: 8,
  end_line: 12,
  severity: "WARN" as const,
  categories: ["quality" as const],
  reason: "this exact region was already disproven twice",
  distinct_count: 2,
};
const regionInput = {
  findings: [finding()],
  reviewersTotal: 1,
  rejectedRegions: [rejectedRegion],
};
const testSecurity = finding({ category: "security", file: "src/a.test.ts" });
const docsCritical = finding({ severity: "CRITICAL", file: "README.md" });

export const POLICY_PASS_CONTRACTS: readonly PolicyPassContract[] = [
  factLocationContract(),
  preAggregationContract(
    "evidence.self-refutation",
    {
      noOpportunity: [1, 0, 0, 0, 0, 0, 0, 0],
      noMatch: [1, 1, 0, 0, 0, 0, 0, 0],
      active: [1, 1, 1, 1, 0, 1, 0, 0],
      ablated: [1, 1, 1, 0, 0, 0, 1, 0],
      protected: [1, 1, 1, 0, 1, 0, 1, 0],
      inactiveReason: "configured-off",
      activeBlocking: 0,
      ablatedBlocking: 1,
      protectedBlocking: 1,
      activeSeverities: ["INFO"],
      ablatedSeverities: ["WARN"],
      protectedSeverities: ["WARN"],
    },
    {
      noOpportunity: sameFindingRunner(
        finding({ severity: "INFO", details: "No issue." }),
        (values, recorder) => demoteSelfRefuting(values, true, recorder),
      ),
      noMatch: sameFindingRunner(finding(), (values, recorder) =>
        demoteSelfRefuting(values, true, recorder),
      ),
      active: sameFindingRunner(selfActive, (values, recorder) =>
        demoteSelfRefuting(values, true, recorder),
      ),
      protected: sameFindingRunner(
        { ...selfActive, category: "correctness" },
        (values, recorder) => demoteSelfRefuting(values, true, recorder),
      ),
    },
  ),
  preAggregationContract(
    "judgment.hypothetical",
    {
      noOpportunity: [1, 0, 0, 0, 0, 0, 0, 0],
      noMatch: [1, 1, 0, 0, 0, 0, 0, 0],
      active: [1, 1, 1, 1, 0, 0, 1, 0],
      ablated: [1, 1, 1, 0, 0, 0, 1, 0],
      protected: [1, 1, 1, 0, 1, 0, 1, 0],
      inactiveReason: "configured-off",
      activeBlocking: 1,
      ablatedBlocking: 1,
      protectedBlocking: 1,
      activeSeverities: ["WARN"],
      ablatedSeverities: ["CRITICAL"],
      protectedSeverities: ["CRITICAL"],
    },
    {
      noOpportunity: sameFindingRunner(
        finding({ severity: "WARN", details: "Currently safe; future change." }),
        (values, recorder) => demoteHypotheticalCriticals(values, true, recorder),
      ),
      noMatch: sameFindingRunner(
        finding({
          severity: "CRITICAL",
          details: "Currently safe in theory, but this already fails right now.",
        }),
        (values, recorder) => demoteHypotheticalCriticals(values, true, recorder),
      ),
      active: sameFindingRunner(hypotheticalActive, (values, recorder) =>
        demoteHypotheticalCriticals(values, true, recorder),
      ),
      protected: sameFindingRunner(
        { ...hypotheticalActive, category: "security" },
        (values, recorder) => demoteHypotheticalCriticals(values, true, recorder),
      ),
    },
  ),
  preAggregationContract(
    "evidence.grounding-token",
    {
      noOpportunity: [1, 0, 0, 0, 0, 0, 0, 0],
      noMatch: [1, 1, 0, 0, 0, 0, 0, 0],
      active: [1, 1, 1, 1, 0, 0, 1, 0],
      ablated: [1, 1, 1, 0, 0, 0, 1, 0],
      protected: [1, 1, 1, 0, 1, 0, 1, 0],
      inactiveReason: "stage-precondition-miss",
      activeBlocking: 1,
      ablatedBlocking: 1,
      protectedBlocking: 1,
      activeSeverities: ["WARN"],
      ablatedSeverities: ["CRITICAL"],
      protectedSeverities: ["CRITICAL"],
    },
    {
      noOpportunity: sameFindingRunner(
        finding({ severity: "WARN", details: "Missing --absent-token." }),
        (values, recorder) => groundFindings(values, ":root { --present-token: #fff; }", recorder),
      ),
      noMatch: sameFindingRunner(
        finding({ severity: "CRITICAL", details: "The --present-token is wrong." }),
        (values, recorder) => groundFindings(values, ":root { --present-token: #fff; }", recorder),
      ),
      active: sameFindingRunner(tokenActive, (values, recorder) =>
        groundFindings(values, "const present = true;", recorder),
      ),
      protected: sameFindingRunner(
        { ...tokenActive, category: "security" },
        (values, recorder) => groundFindings(values, "const present = true;", recorder),
      ),
    },
  ),
  preAggregationContract(
    "judgment.grounding-llm",
    {
      noOpportunity: [1, 0, 0, 0, 0, 0, 0, 0],
      noMatch: [1, 1, 0, 0, 0, 0, 0, 0],
      active: [1, 1, 1, 1, 0, 0, 1, 0],
      ablated: [1, 1, 1, 0, 0, 0, 1, 0],
      protected: [1, 1, 1, 0, 1, 0, 1, 0],
      inactiveReason: "configured-off",
      activeBlocking: 1,
      ablatedBlocking: 1,
      protectedBlocking: 1,
      activeSeverities: ["WARN"],
      ablatedSeverities: ["CRITICAL"],
      protectedSeverities: ["CRITICAL"],
    },
    {
      noOpportunity: sameFindingRunner(llmActive, (values, recorder) =>
        applyGroundingJudgeVerdicts(values, new Map(), recorder),
      ),
      noMatch: sameFindingRunner(llmActive, (values, recorder) =>
        applyGroundingJudgeVerdicts(
          values,
          new Map([[llmActive.signature, { grounded: true }]]),
          recorder,
        ),
      ),
      active: sameFindingRunner(llmActive, (values, recorder) =>
        applyGroundingJudgeVerdicts(values, llmUngrounded, recorder),
      ),
      protected: sameFindingRunner(
        { ...llmActive, category: "correctness" },
        (values, recorder) =>
          applyGroundingJudgeVerdicts(
            values,
            new Map([[llmActive.signature, { grounded: false }]]),
            recorder,
          ),
      ),
    },
  ),
  aggregateContract(
    "evidence.redaction-placeholder",
    {
      noOpportunity: [1, 0, 0, 0, 0, 0, 0, 0],
      noMatch: [1, 1, 0, 0, 0, 0, 0, 0],
      active: [1, 1, 1, 1, 0, 1, 0, 0],
      ablated: [1, 1, 1, 0, 0, 0, 1, 0],
      protected: [1, 1, 1, 0, 1, 0, 1, 0],
      inactiveReason: "stage-precondition-miss",
      activeBlocking: 0,
      ablatedBlocking: 1,
      protectedBlocking: 1,
      activeSeverities: ["INFO"],
      ablatedSeverities: ["WARN"],
      protectedSeverities: ["WARN"],
    },
    {
      noOpportunity: {
        findings: [{ ...redactionActive, severity: "INFO" }],
        reviewersTotal: 1,
      },
      noMatch: {
        findings: [finding({ message: "exposed value <REDACTED:HIGH_ENTROPY>" })],
        reviewersTotal: 1,
      },
      active: { findings: [redactionActive], reviewersTotal: 1 },
      protected: {
        findings: [{ ...redactionActive, category: "security" }],
        reviewersTotal: 1,
      },
    },
  ),
  aggregateContract(
    "judgment.critic",
    {
      noOpportunity: [1, 0, 0, 0, 0, 0, 0, 0],
      noMatch: [1, 1, 0, 0, 0, 0, 0, 0],
      active: [1, 1, 1, 1, 0, 1, 0, 0],
      ablated: [1, 1, 1, 0, 0, 0, 1, 0],
      protected: [1, 1, 1, 0, 1, 0, 1, 0],
      inactiveReason: "configured-off",
      activeBlocking: 0,
      ablatedBlocking: 1,
      protectedBlocking: 1,
      activeSeverities: ["INFO"],
      ablatedSeverities: ["WARN"],
      protectedSeverities: ["WARN"],
      variant: { tuple: [1, 1, 1, 1, 0, 0, 0, 1], blocking: 0, severities: [] },
    },
    {
      noOpportunity: { findings: [criticActive], reviewersTotal: 1, critic: new Map() },
      noMatch: {
        findings: [criticActive],
        reviewersTotal: 1,
        critic: new Map([[criticActive.signature, { verdict: "keep" }]]),
      },
      active: {
        findings: [criticActive],
        reviewersTotal: 1,
        critic: new Map([[criticActive.signature, { verdict: "likely_fp" }]]),
      },
      protected: {
        findings: [
          finding({ signature: "sig-critic-majority-a" }),
          finding({
            signature: "sig-critic-majority-b",
            reviewer: { provider: "gemini", model: "m", persona: "quality" },
          }),
        ],
        reviewersTotal: 3,
        critic: new Map([["sig-critic-majority-b", { verdict: "likely_fp" }]]),
      },
      variant: {
        findings: [{ ...criticActive, severity: "INFO" }],
        reviewersTotal: 1,
        critic: new Map([[criticActive.signature, { verdict: "likely_fp" }]]),
      },
    },
  ),
  aggregateContract(
    "scope.diff",
    {
      noOpportunity: [1, 0, 0, 0, 0, 0, 0, 0],
      noMatch: [1, 1, 0, 0, 0, 0, 0, 0],
      active: [1, 1, 1, 1, 0, 1, 0, 0],
      ablated: [1, 1, 1, 0, 0, 0, 1, 0],
      protected: [1, 1, 1, 0, 1, 0, 1, 0],
      inactiveReason: "configured-off",
      activeBlocking: 0,
      ablatedBlocking: 1,
      protectedBlocking: 1,
      activeSeverities: ["INFO"],
      ablatedSeverities: ["WARN"],
      protectedSeverities: ["WARN"],
    },
    {
      noOpportunity: {
        findings: [{ ...diffActive, line_start: 0, line_end: 0 }],
        reviewersTotal: 1,
        changedRanges: ranges,
        scopeToDiff: true,
      },
      noMatch: {
        findings: [{ ...diffActive, line_start: 11, line_end: 11 }],
        reviewersTotal: 1,
        changedRanges: ranges,
        scopeToDiff: true,
      },
      active: {
        findings: [diffActive],
        reviewersTotal: 1,
        changedRanges: ranges,
        scopeToDiff: true,
      },
      protected: {
        findings: [{ ...diffActive, category: "security" }],
        reviewersTotal: 1,
        changedRanges: ranges,
        scopeToDiff: true,
        outOfDiffBlocking: ["security"],
      },
    },
  ),
  aggregateContract(
    "scope.delta",
    {
      noOpportunity: [1, 0, 0, 0, 0, 0, 0, 0],
      noMatch: [1, 1, 0, 0, 0, 0, 0, 0],
      active: [1, 1, 1, 1, 0, 1, 0, 0],
      ablated: [1, 1, 1, 0, 0, 0, 1, 0],
      protected: [1, 1, 1, 0, 1, 0, 1, 0],
      inactiveReason: "stage-precondition-miss",
      activeBlocking: 0,
      ablatedBlocking: 1,
      protectedBlocking: 1,
      activeSeverities: ["INFO"],
      ablatedSeverities: ["WARN"],
      protectedSeverities: ["WARN"],
    },
    {
      noOpportunity: {
        findings: [finding({ severity: "INFO" })],
        reviewersTotal: 1,
        deltaScope: new Set(["src/a.ts"]),
      },
      noMatch: { findings: [finding()], reviewersTotal: 1, deltaScope: new Set(["src/a.ts"]) },
      active: {
        findings: [finding()],
        reviewersTotal: 1,
        deltaScope: new Set(["src/other.ts"]),
      },
      protected: {
        findings: [finding({ category: "correctness" })],
        reviewersTotal: 1,
        deltaScope: new Set(["src/other.ts"]),
      },
    },
  ),
  aggregateContract(
    "scope.session",
    {
      noOpportunity: [1, 0, 0, 0, 0, 0, 0, 0],
      noMatch: [1, 1, 0, 0, 0, 0, 0, 0],
      active: [1, 1, 1, 1, 0, 1, 0, 0],
      ablated: [1, 1, 1, 0, 0, 0, 1, 0],
      protected: [1, 1, 1, 0, 1, 0, 1, 0],
      inactiveReason: "stage-precondition-miss",
      activeBlocking: 0,
      ablatedBlocking: 1,
      protectedBlocking: 1,
      activeSeverities: ["INFO"],
      ablatedSeverities: ["WARN"],
      protectedSeverities: ["WARN"],
    },
    {
      noOpportunity: {
        findings: [finding({ severity: "INFO" })],
        reviewersTotal: 1,
        foreignFiles: new Set(["src/a.ts"]),
      },
      noMatch: {
        findings: [finding()],
        reviewersTotal: 1,
        foreignFiles: new Set(["src/foreign.ts"]),
      },
      active: {
        findings: [finding()],
        reviewersTotal: 1,
        foreignFiles: new Set(["src/a.ts"]),
      },
      protected: {
        findings: [finding({ category: "security" })],
        reviewersTotal: 1,
        foreignFiles: new Set(["src/a.ts"]),
        outOfDiffBlocking: ["security"],
      },
    },
  ),
  aggregateContract(
    "history.fp-signature",
    {
      noOpportunity: [1, 0, 0, 0, 0, 0, 0, 0],
      noMatch: [1, 1, 0, 0, 0, 0, 0, 0],
      active: [1, 1, 1, 1, 0, 1, 0, 0],
      ablated: [1, 1, 1, 0, 0, 0, 1, 0],
      inactiveReason: "stage-precondition-miss",
      activeBlocking: 0,
      ablatedBlocking: 1,
      activeSeverities: ["INFO"],
      ablatedSeverities: ["WARN"],
    },
    {
      noOpportunity: {
        findings: [finding({ severity: "INFO" })],
        reviewersTotal: 1,
        fpActive: fpInput.fpActive,
      },
      noMatch: {
        findings: [finding()],
        reviewersTotal: 1,
        fpActive: new Map([["other", { id: "FP-001" }]]),
      },
      active: fpInput,
    },
  ),
  aggregateContract(
    "history.cycle-rejected",
    {
      noOpportunity: [1, 0, 0, 0, 0, 0, 0, 0],
      noMatch: [1, 1, 0, 0, 0, 0, 0, 0],
      active: [1, 1, 1, 1, 0, 1, 0, 0],
      ablated: [1, 1, 1, 0, 0, 0, 1, 0],
      protected: [1, 1, 1, 0, 1, 0, 1, 0],
      inactiveReason: "stage-precondition-miss",
      activeBlocking: 0,
      ablatedBlocking: 1,
      protectedBlocking: 1,
      activeSeverities: ["INFO"],
      ablatedSeverities: ["WARN"],
      protectedSeverities: ["WARN"],
    },
    {
      noOpportunity: {
        findings: [finding({ severity: "INFO" })],
        reviewersTotal: 1,
        cycleRejected: cycleInput.cycleRejected,
      },
      noMatch: {
        findings: [finding()],
        reviewersTotal: 1,
        cycleRejected: new Set(["other"]),
      },
      active: cycleInput,
      protected: {
        findings: [finding({ category: "correctness" })],
        reviewersTotal: 1,
        cycleRejected: cycleInput.cycleRejected,
      },
    },
  ),
  aggregateContract(
    "history.fp-cluster",
    {
      noOpportunity: [1, 0, 0, 0, 0, 0, 0, 0],
      noMatch: [1, 1, 0, 0, 0, 0, 0, 0],
      active: [1, 1, 1, 1, 0, 1, 0, 0],
      ablated: [1, 1, 1, 0, 0, 0, 1, 0],
      inactiveReason: "stage-precondition-miss",
      activeBlocking: 0,
      ablatedBlocking: 1,
      activeSeverities: ["INFO"],
      ablatedSeverities: ["WARN"],
    },
    {
      noOpportunity: {
        findings: [finding({ severity: "INFO" })],
        reviewersTotal: 1,
        fpActiveClusters: activeCluster,
      },
      noMatch: {
        findings: [finding({ rule_id: "other-contract" })],
        reviewersTotal: 1,
        fpActiveClusters: activeCluster,
      },
      active: clusterInput,
    },
  ),
  aggregateContract(
    "judgment.confidence",
    {
      noOpportunity: [1, 0, 0, 0, 0, 0, 0, 0],
      noMatch: [1, 1, 0, 0, 0, 0, 0, 0],
      active: [1, 1, 1, 1, 0, 1, 0, 0],
      ablated: [1, 1, 1, 0, 0, 0, 1, 0],
      protected: [1, 1, 1, 0, 1, 0, 1, 0],
      inactiveReason: "configured-off",
      activeBlocking: 0,
      ablatedBlocking: 1,
      protectedBlocking: 1,
      activeSeverities: ["INFO"],
      ablatedSeverities: ["WARN"],
      protectedSeverities: ["WARN"],
    },
    {
      noOpportunity: {
        findings: [
          lowConfidence,
          {
            ...lowConfidence,
            signature: "sig-majority",
            reviewer: { provider: "gemini", model: "m", persona: "quality" },
          },
        ],
        reviewersTotal: 2,
        confidenceFloor: 0.5,
      },
      noMatch: {
        findings: [finding({ confidence: 0.5 })],
        reviewersTotal: 1,
        confidenceFloor: 0.5,
      },
      active: { findings: [lowConfidence], reviewersTotal: 1, confidenceFloor: 0.5 },
      protected: {
        findings: [lowConfidence],
        reviewersTotal: 1,
        confidenceFloor: 0.5,
        protectedReviewers: new Set(["codex"]),
      },
    },
  ),
  aggregateContract(
    "judgment.reputation",
    {
      noOpportunity: [1, 0, 0, 0, 0, 0, 0, 0],
      noMatch: [1, 1, 0, 0, 0, 0, 0, 0],
      active: [1, 1, 1, 1, 0, 1, 0, 0],
      ablated: [1, 1, 1, 0, 0, 0, 1, 0],
      protected: [1, 1, 1, 0, 1, 0, 1, 0],
      inactiveReason: "stage-precondition-miss",
      activeBlocking: 0,
      ablatedBlocking: 1,
      protectedBlocking: 1,
      activeSeverities: ["INFO"],
      ablatedSeverities: ["WARN"],
      protectedSeverities: ["WARN"],
    },
    {
      noOpportunity: {
        findings: [
          finding(),
          finding({
            signature: "sig-reputation-majority",
            reviewer: { provider: "gemini", model: "m", persona: "quality" },
          }),
        ],
        reviewersTotal: 2,
        repUnreliable: new Set(["codex:quality", "gemini:quality"]),
      },
      noMatch: {
        findings: [finding()],
        reviewersTotal: 1,
        repUnreliable: new Set(["gemini:quality"]),
      },
      active: reputationInput,
      protected: {
        findings: [finding({ category: "security" })],
        reviewersTotal: 1,
        repUnreliable: new Set(["codex:quality"]),
      },
    },
  ),
  aggregateContract(
    "history.region-rejected",
    {
      noOpportunity: [1, 0, 0, 0, 0, 0, 0, 0],
      noMatch: [1, 1, 0, 0, 0, 0, 0, 0],
      active: [1, 1, 1, 1, 0, 1, 0, 0],
      ablated: [1, 1, 1, 0, 0, 0, 1, 0],
      protected: [1, 1, 1, 0, 1, 0, 1, 0],
      inactiveReason: "stage-precondition-miss",
      activeBlocking: 0,
      ablatedBlocking: 1,
      protectedBlocking: 1,
      activeSeverities: ["INFO"],
      ablatedSeverities: ["WARN"],
      protectedSeverities: ["WARN"],
    },
    {
      noOpportunity: {
        findings: [finding({ line_start: 0, line_end: 0 })],
        reviewersTotal: 1,
        rejectedRegions: [rejectedRegion],
      },
      noMatch: {
        findings: [finding({ line_start: 40, line_end: 40 })],
        reviewersTotal: 1,
        rejectedRegions: [rejectedRegion],
      },
      active: regionInput,
      protected: {
        findings: [finding()],
        reviewersTotal: 1,
        rejectedRegions: [{ ...rejectedRegion, distinct_count: 1 }],
      },
    },
  ),
  aggregateContract(
    "judgment.test-security",
    {
      noOpportunity: [1, 0, 0, 0, 0, 0, 0, 0],
      noMatch: [1, 1, 0, 0, 0, 0, 0, 0],
      active: [1, 1, 1, 1, 0, 1, 0, 0],
      ablated: [1, 1, 1, 0, 0, 0, 1, 0],
      protected: [1, 1, 1, 0, 1, 0, 1, 0],
      inactiveReason: "configured-off",
      activeBlocking: 0,
      ablatedBlocking: 1,
      protectedBlocking: 1,
      activeSeverities: ["INFO"],
      ablatedSeverities: ["WARN"],
      protectedSeverities: ["WARN"],
    },
    {
      noOpportunity: {
        findings: [{ ...testSecurity, severity: "INFO" }],
        reviewersTotal: 1,
        demoteTestSecurity: true,
      },
      noMatch: {
        findings: [finding({ file: "src/a.test.ts" })],
        reviewersTotal: 1,
        demoteTestSecurity: true,
      },
      active: { findings: [testSecurity], reviewersTotal: 1, demoteTestSecurity: true },
      protected: {
        findings: [
          { ...testSecurity, signature: "sig-test-security", message: "same test issue" },
          finding({
            signature: "sig-test-correctness",
            category: "correctness",
            file: "src/a.test.ts",
            message: "same test issue",
          }),
        ],
        reviewersTotal: 1,
        demoteTestSecurity: true,
      },
    },
  ),
  aggregateContract(
    "judgment.docs-cap",
    {
      noOpportunity: [1, 0, 0, 0, 0, 0, 0, 0],
      noMatch: [1, 1, 0, 0, 0, 0, 0, 0],
      active: [1, 1, 1, 1, 0, 0, 1, 0],
      ablated: [1, 1, 1, 0, 0, 0, 1, 0],
      protected: [1, 1, 1, 0, 1, 0, 1, 0],
      inactiveReason: "configured-off",
      activeBlocking: 1,
      ablatedBlocking: 1,
      protectedBlocking: 1,
      activeSeverities: ["WARN"],
      ablatedSeverities: ["CRITICAL"],
      protectedSeverities: ["CRITICAL"],
    },
    {
      noOpportunity: {
        findings: [finding({ file: "README.md" })],
        reviewersTotal: 1,
        capDocsSeverity: true,
      },
      noMatch: {
        findings: [finding({ severity: "CRITICAL" })],
        reviewersTotal: 2,
        capDocsSeverity: true,
      },
      active: { findings: [docsCritical], reviewersTotal: 1, capDocsSeverity: true },
      protected: {
        findings: [{ ...docsCritical, category: "correctness" }],
        reviewersTotal: 1,
        capDocsSeverity: true,
      },
    },
  ),
];

export function runExplanatoryStageContract(): {
  stages: PolicyStageEvaluation[];
  effects: PolicyEffect[];
} {
  const protectedFinding = finding({
    category: "security",
    message: "undefined variable <REDACTED:HIGH_ENTROPY>",
  });
  const recorder = runtime("explanatory-stages");
  const result = aggregate({
    findings: [protectedFinding],
    reviewersTotal: 1,
    critic: new Map([[protectedFinding.signature, { verdict: "likely_fp" }]]),
    policyRuntime: recorder,
  });
  const trace = recorder.finalize({
    rawResponseSha256: [],
    verdict: result.verdict,
    finalFindings: result.dedupedFindings,
  });
  if (trace === null) throw new Error("explanatory stage trace did not finalize");
  return {
    stages: trace.stages,
    effects: result.dedupedFindings.flatMap(({ policy_effects }) => policy_effects ?? []),
  };
}

export const EXPLANATORY_STAGE_IDS: readonly PolicyStageId[] = [
  "aggregation.cluster",
  "verdict.compute",
];
