import { describe, expect, it } from "bun:test";
import { type AggregateInput, aggregate } from "../../src/core/aggregator.ts";
import { deriveImplicitOutcomes } from "../../src/core/learnings/implicit-outcomes.ts";
import type {
  PolicyPassId,
  PolicyProtectionCode,
  PolicyReasonCode,
} from "../../src/core/policy/catalog.ts";
import { PolicyTraceRecorder } from "../../src/core/policy/trace.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import type { PolicyTrace } from "../../src/schemas/policy-trace.ts";

type NumericSummary = readonly [number, number, number, number, number, number, number, number];

const NO_OPPORTUNITY = [1, 0, 0, 0, 0, 0, 0, 0] as const;
const PREDICATE_MISS = [1, 1, 0, 0, 0, 0, 0, 0] as const;
const ACTIVE_BLOCKING_REMOVAL = [1, 1, 1, 1, 0, 1, 0, 0] as const;
const ABLATED_BLOCKING_PRESERVED = [1, 1, 1, 0, 0, 0, 1, 0] as const;
const PROTECTED_BLOCKING_PRESERVED = [1, 1, 1, 0, 1, 0, 1, 0] as const;
const ACTIVE_BLOCKING_PRESERVED = [1, 1, 1, 1, 0, 0, 1, 0] as const;

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

function run(
  runId: string,
  input: AggregateInput,
  ablated: readonly PolicyPassId[] = [],
): { recorder: PolicyTraceRecorder; result: ReturnType<typeof aggregate> } {
  const recorder = runtime(runId, ablated);
  return { recorder, result: aggregate({ ...input, policyRuntime: recorder }) };
}

function numericSummary(recorder: PolicyTraceRecorder, passId: PolicyPassId): NumericSummary {
  const summary = recorder.summary(passId);
  expect(summary.status).toBe("ran");
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

function expectEffect(
  value: Finding | undefined,
  expected: {
    pass_id: PolicyPassId;
    order: number;
    action: "demoted" | "capped" | "protected" | "suppressed";
    before: Finding["severity"];
    after: Finding["severity"];
    reason_code: PolicyReasonCode;
    protected_by?: PolicyProtectionCode;
    source_signatures?: string[];
  },
): void {
  if (value === undefined) throw new Error("expected a visible finding");
  const { source_signatures = [value.signature], ...effect } = expected;
  expect(value.policy_effects).toContainEqual({
    ...effect,
    source_signatures,
  });
}

function finalized(output: ReturnType<typeof run>): PolicyTrace {
  const trace = output.recorder.finalize({
    rawResponseSha256: [],
    verdict: output.result.verdict,
    finalFindings: output.result.dedupedFindings,
  });
  expect(output.recorder.telemetryError).toBe(false);
  if (trace === null) throw new Error("expected a complete policy trace");
  return trace;
}

function withoutPolicyEffects(value: Finding | undefined): Finding | undefined {
  if (value === undefined) return undefined;
  const { policy_effects: _policyEffects, ...legacyFinding } = value;
  return legacyFinding as Finding;
}

function implicitOutcomes(value: Finding | undefined) {
  return deriveImplicitOutcomes(value === undefined ? [] : [value], [], {
    runId: "run-ablation-marker",
    iter: 1,
    nowIso: "2026-08-10T00:00:00Z",
  });
}

function activeCluster() {
  return new Map([["policy@src/a.ts", { key: "policy@src/a.ts", member_ids: ["FP-001"] }]]);
}

function rejectedRegion(
  overrides: Partial<NonNullable<AggregateInput["rejectedRegions"]>[number]> = {},
) {
  return {
    file: "src/a.ts",
    start_line: 8,
    end_line: 12,
    severity: "WARN" as const,
    categories: ["quality" as const],
    reason: "this exact region was already disproven twice",
    distinct_count: 2,
    ...overrides,
  };
}

describe("aggregator policy numeric contracts, orders 110-180", () => {
  it("marks every configured-inactive second-half pass not-run and finalizes without evaluations", () => {
    const output = run("second-half-inactive", {
      findings: [finding()],
      reviewersTotal: 2,
    });
    const expected = [
      ["history.fp-signature", "stage-precondition-miss"],
      ["history.cycle-rejected", "stage-precondition-miss"],
      ["history.fp-cluster", "stage-precondition-miss"],
      ["judgment.confidence", "configured-off"],
      ["judgment.reputation", "stage-precondition-miss"],
      ["history.region-rejected", "stage-precondition-miss"],
      ["judgment.test-security", "configured-off"],
      ["judgment.docs-cap", "configured-off"],
    ] as const;

    for (const [passId, reasonCode] of expected) {
      expect(output.recorder.summary(passId)).toEqual({
        pass_id: passId,
        status: "not-run",
        reason_code: reasonCode,
      });
      expect(output.recorder.evaluations().some((row) => row.pass_id === passId)).toBe(false);
    }

    const trace = finalized(output);
    expect(
      trace.passes
        .filter((pass) => expected.some(([passId]) => pass.pass_id === passId))
        .map((pass) => [
          pass.pass_id,
          pass.status,
          "reason_code" in pass ? pass.reason_code : null,
        ]),
    ).toEqual(expected.map(([passId, reasonCode]) => [passId, "not-run", reasonCode]));
  });

  it("records FP-signature no-opportunity, miss, active, and ablated tuples", () => {
    const info = run("fp-signature-info", {
      findings: [finding({ severity: "INFO" })],
      reviewersTotal: 1,
      fpActive: new Map([["sig-policy", { id: "FP-001" }]]),
    });
    const miss = run("fp-signature-miss", {
      findings: [finding()],
      reviewersTotal: 1,
      fpActive: new Map([["other", { id: "FP-001" }]]),
    });
    const input = {
      findings: [finding()],
      reviewersTotal: 1,
      fpActive: new Map([["sig-policy", { id: "FP-001" }]]),
    };
    const active = run("fp-signature-active", input);
    const ablated = run("fp-signature-ablated", input, ["history.fp-signature"]);

    expect(numericSummary(info.recorder, "history.fp-signature")).toEqual(NO_OPPORTUNITY);
    expect(numericSummary(miss.recorder, "history.fp-signature")).toEqual(PREDICATE_MISS);
    expect(numericSummary(active.recorder, "history.fp-signature")).toEqual(
      ACTIVE_BLOCKING_REMOVAL,
    );
    expect(numericSummary(ablated.recorder, "history.fp-signature")).toEqual(
      ABLATED_BLOCKING_PRESERVED,
    );
    expect(active.result.dedupedFindings[0]).toMatchObject({
      severity: "INFO",
      fp_ledger_match: { pattern_id: "FP-001", matched_count: 1, suppressed: true },
    });
    expect(ablated.result.dedupedFindings[0]).not.toHaveProperty("fp_ledger_match");
    expectEffect(active.result.dedupedFindings[0], {
      pass_id: "history.fp-signature",
      order: 110,
      action: "suppressed",
      before: "WARN",
      after: "INFO",
      reason_code: "active-fp-signature",
    });
  });

  it("records cycle-rejection no-opportunity, miss, active, ablated, and protected tuples", () => {
    const info = run("cycle-info", {
      findings: [finding({ severity: "INFO" })],
      reviewersTotal: 1,
      cycleRejected: new Set(["sig-policy"]),
    });
    const miss = run("cycle-miss", {
      findings: [finding()],
      reviewersTotal: 1,
      cycleRejected: new Set(["other"]),
    });
    const input = {
      findings: [finding()],
      reviewersTotal: 1,
      cycleRejected: new Set(["sig-policy"]),
    };
    const active = run("cycle-active", input);
    const ablated = run("cycle-ablated", input, ["history.cycle-rejected"]);
    const protectedResult = run("cycle-protected", {
      findings: [finding({ category: "correctness" })],
      reviewersTotal: 1,
      cycleRejected: new Set(["sig-policy"]),
    });
    const criticalFloor = run("cycle-critical-floor", {
      findings: [finding({ severity: "CRITICAL" })],
      reviewersTotal: 2,
      cycleRejected: new Set(["sig-policy"]),
    });

    expect(numericSummary(info.recorder, "history.cycle-rejected")).toEqual(NO_OPPORTUNITY);
    expect(numericSummary(miss.recorder, "history.cycle-rejected")).toEqual(PREDICATE_MISS);
    expect(numericSummary(active.recorder, "history.cycle-rejected")).toEqual(
      ACTIVE_BLOCKING_REMOVAL,
    );
    expect(numericSummary(ablated.recorder, "history.cycle-rejected")).toEqual(
      ABLATED_BLOCKING_PRESERVED,
    );
    expect(numericSummary(protectedResult.recorder, "history.cycle-rejected")).toEqual(
      PROTECTED_BLOCKING_PRESERVED,
    );
    expect(numericSummary(criticalFloor.recorder, "history.cycle-rejected")).toEqual(
      PROTECTED_BLOCKING_PRESERVED,
    );
    expect(ablated.result.dedupedFindings[0]?.severity).toBe("WARN");
    expectEffect(protectedResult.result.dedupedFindings[0], {
      pass_id: "history.cycle-rejected",
      order: 120,
      action: "protected",
      before: "WARN",
      after: "WARN",
      reason_code: "cycle-signature-rejected",
      protected_by: "security-correctness-floor",
    });
    expectEffect(criticalFloor.result.dedupedFindings[0], {
      pass_id: "history.cycle-rejected",
      order: 120,
      action: "protected",
      before: "CRITICAL",
      after: "CRITICAL",
      reason_code: "cycle-signature-rejected",
      protected_by: "critical-floor",
    });
  });

  it("records FP-cluster no-opportunity, miss, active, and ablated tuples", () => {
    const info = run("fp-cluster-info", {
      findings: [finding({ severity: "INFO" })],
      reviewersTotal: 1,
      fpActiveClusters: activeCluster(),
    });
    const miss = run("fp-cluster-miss", {
      findings: [finding({ rule_id: "other-contract" })],
      reviewersTotal: 1,
      fpActiveClusters: activeCluster(),
    });
    const input = { findings: [finding()], reviewersTotal: 1, fpActiveClusters: activeCluster() };
    const active = run("fp-cluster-active", input);
    const ablated = run("fp-cluster-ablated", input, ["history.fp-cluster"]);

    expect(numericSummary(info.recorder, "history.fp-cluster")).toEqual(NO_OPPORTUNITY);
    expect(numericSummary(miss.recorder, "history.fp-cluster")).toEqual(PREDICATE_MISS);
    expect(numericSummary(active.recorder, "history.fp-cluster")).toEqual(ACTIVE_BLOCKING_REMOVAL);
    expect(numericSummary(ablated.recorder, "history.fp-cluster")).toEqual(
      ABLATED_BLOCKING_PRESERVED,
    );
    expect(active.result.dedupedFindings[0]?.fp_cluster_match).toEqual({
      cluster_key: "policy@src/a.ts",
      member_ids: ["FP-001"],
      suppressed: true,
    });
    expect(ablated.result.dedupedFindings[0]).not.toHaveProperty("fp_cluster_match");
    expectEffect(active.result.dedupedFindings[0], {
      pass_id: "history.fp-cluster",
      order: 130,
      action: "suppressed",
      before: "WARN",
      after: "INFO",
      reason_code: "active-fp-cluster",
    });
  });

  it("records confidence no-opportunity, miss, active, ablated, and high-precision protection", () => {
    const majorityA = finding({
      signature: "sig-majority-a",
      confidence: 0.2,
      reviewer: { provider: "codex", model: "m", persona: "quality" },
    });
    const majorityB = finding({
      signature: "sig-majority-b",
      confidence: 0.2,
      reviewer: { provider: "gemini", model: "m", persona: "quality" },
    });
    const noOpportunity = run("confidence-majority", {
      findings: [majorityA, majorityB],
      reviewersTotal: 2,
      confidenceFloor: 0.5,
    });
    const miss = run("confidence-miss", {
      findings: [finding({ confidence: 0.5 })],
      reviewersTotal: 1,
      confidenceFloor: 0.5,
    });
    const low = finding({ confidence: 0.2 });
    const input = { findings: [low], reviewersTotal: 1, confidenceFloor: 0.5 };
    const active = run("confidence-active", input);
    const ablated = run("confidence-ablated", input, ["judgment.confidence"]);
    const protectedResult = run("confidence-protected", {
      ...input,
      protectedReviewers: new Set(["codex"]),
    });

    expect(numericSummary(noOpportunity.recorder, "judgment.confidence")).toEqual(NO_OPPORTUNITY);
    expect(numericSummary(miss.recorder, "judgment.confidence")).toEqual(PREDICATE_MISS);
    expect(numericSummary(active.recorder, "judgment.confidence")).toEqual(ACTIVE_BLOCKING_REMOVAL);
    expect(numericSummary(ablated.recorder, "judgment.confidence")).toEqual(
      ABLATED_BLOCKING_PRESERVED,
    );
    expect(numericSummary(protectedResult.recorder, "judgment.confidence")).toEqual(
      PROTECTED_BLOCKING_PRESERVED,
    );
    expect(protectedResult.result.dedupedFindings[0]).toMatchObject({
      severity: "WARN",
      protected_high_precision: true,
    });
    expectEffect(protectedResult.result.dedupedFindings[0], {
      pass_id: "judgment.confidence",
      order: 140,
      action: "protected",
      before: "WARN",
      after: "WARN",
      reason_code: "below-confidence-floor",
      protected_by: "high-precision-reviewer",
    });
  });

  it("records confidence security/pin protections and the CRITICAL G0 clamp", () => {
    const critical = run("confidence-critical", {
      findings: [finding({ severity: "CRITICAL", confidence: 0.1 })],
      reviewersTotal: 2,
      confidenceFloor: 0.5,
    });
    const security = run("confidence-security", {
      findings: [finding({ severity: "CRITICAL", category: "security", confidence: 0.1 })],
      reviewersTotal: 2,
      confidenceFloor: 0.5,
    });
    const pinned = run("confidence-pinned", {
      findings: [finding({ confidence: 0.1 })],
      reviewersTotal: 1,
      confidenceFloor: 0.5,
      claimedFixed: new Map([["sig-policy", 1]]),
    });

    expect(numericSummary(critical.recorder, "judgment.confidence")).toEqual(
      ACTIVE_BLOCKING_PRESERVED,
    );
    expect(critical.result.dedupedFindings[0]).toMatchObject({
      severity: "WARN",
      low_confidence: true,
      demoted_from_critical: true,
    });
    expectEffect(critical.result.dedupedFindings[0], {
      pass_id: "judgment.confidence",
      order: 140,
      action: "capped",
      before: "CRITICAL",
      after: "WARN",
      reason_code: "below-confidence-floor",
    });
    expect(numericSummary(security.recorder, "judgment.confidence")).toEqual(
      PROTECTED_BLOCKING_PRESERVED,
    );
    expectEffect(security.result.dedupedFindings[0], {
      pass_id: "judgment.confidence",
      order: 140,
      action: "protected",
      before: "CRITICAL",
      after: "CRITICAL",
      reason_code: "below-confidence-floor",
      protected_by: "security-correctness-floor",
    });
    expect(numericSummary(pinned.recorder, "judgment.confidence")).toEqual(
      PROTECTED_BLOCKING_PRESERVED,
    );
    expectEffect(pinned.result.dedupedFindings[0], {
      pass_id: "judgment.confidence",
      order: 140,
      action: "protected",
      before: "WARN",
      after: "WARN",
      reason_code: "below-confidence-floor",
      protected_by: "claimed-fixed-pin",
    });
  });

  it("records reputation no-opportunity, miss, active, ablated, and security protection", () => {
    const majorityA = finding({
      signature: "sig-reputation-a",
      reviewer: { provider: "codex", model: "m", persona: "quality" },
    });
    const majorityB = finding({
      signature: "sig-reputation-b",
      reviewer: { provider: "gemini", model: "m", persona: "quality" },
    });
    const noOpportunity = run("reputation-majority", {
      findings: [majorityA, majorityB],
      reviewersTotal: 2,
      repUnreliable: new Set(["codex:quality", "gemini:quality"]),
    });
    const miss = run("reputation-miss", {
      findings: [finding()],
      reviewersTotal: 1,
      repUnreliable: new Set(["gemini:quality"]),
    });
    const input = {
      findings: [finding()],
      reviewersTotal: 1,
      repUnreliable: new Set(["codex:quality"]),
    };
    const active = run("reputation-active", input);
    const ablated = run("reputation-ablated", input, ["judgment.reputation"]);
    const protectedResult = run("reputation-security", {
      findings: [finding({ category: "security" })],
      reviewersTotal: 1,
      repUnreliable: new Set(["codex:quality"]),
    });

    expect(numericSummary(noOpportunity.recorder, "judgment.reputation")).toEqual(NO_OPPORTUNITY);
    expect(numericSummary(miss.recorder, "judgment.reputation")).toEqual(PREDICATE_MISS);
    expect(numericSummary(active.recorder, "judgment.reputation")).toEqual(ACTIVE_BLOCKING_REMOVAL);
    expect(numericSummary(ablated.recorder, "judgment.reputation")).toEqual(
      ABLATED_BLOCKING_PRESERVED,
    );
    expect(numericSummary(protectedResult.recorder, "judgment.reputation")).toEqual(
      PROTECTED_BLOCKING_PRESERVED,
    );
    expectEffect(protectedResult.result.dedupedFindings[0], {
      pass_id: "judgment.reputation",
      order: 150,
      action: "protected",
      before: "WARN",
      after: "WARN",
      reason_code: "unreliable-reviewer",
      protected_by: "security-floor",
    });
  });

  it("records reputation CRITICAL quality/correctness clamps and remaining guards", () => {
    const quality = run("reputation-quality-critical", {
      findings: [finding({ severity: "CRITICAL" })],
      reviewersTotal: 2,
      repUnreliable: new Set(["codex:quality"]),
    });
    const correctness = run("reputation-correctness-critical", {
      findings: [finding({ severity: "CRITICAL", category: "correctness" })],
      reviewersTotal: 2,
      repUnreliable: new Set(["codex:quality"]),
      demoteCorrectness: true,
      corroborateCritical: true,
    });
    const correctnessDisabled = run("reputation-correctness-disabled", {
      findings: [finding({ category: "correctness" })],
      reviewersTotal: 2,
      repUnreliable: new Set(["codex:quality"]),
    });
    const criticalFloor = run("reputation-critical-floor", {
      findings: [finding({ demoted_from_critical: true })],
      reviewersTotal: 2,
      repUnreliable: new Set(["codex:quality"]),
    });
    const pinned = run("reputation-pinned", {
      findings: [finding()],
      reviewersTotal: 2,
      repUnreliable: new Set(["codex:quality"]),
      claimedFixed: new Map([["sig-policy", 1]]),
    });

    expect(numericSummary(quality.recorder, "judgment.reputation")).toEqual(
      ACTIVE_BLOCKING_PRESERVED,
    );
    expectEffect(quality.result.dedupedFindings[0], {
      pass_id: "judgment.reputation",
      order: 150,
      action: "demoted",
      before: "CRITICAL",
      after: "WARN",
      reason_code: "unreliable-reviewer",
    });
    expect(numericSummary(correctness.recorder, "judgment.reputation")).toEqual(
      ACTIVE_BLOCKING_PRESERVED,
    );
    expect(correctness.result.dedupedFindings[0]).toMatchObject({
      severity: "WARN",
      reputation_corroboration_required: true,
    });
    expectEffect(correctness.result.dedupedFindings[0], {
      pass_id: "judgment.reputation",
      order: 150,
      action: "capped",
      before: "CRITICAL",
      after: "WARN",
      reason_code: "unreliable-reviewer",
    });
    for (const [output, protectedBy] of [
      [correctnessDisabled, "correctness-demote-disabled"],
      [criticalFloor, "critical-floor"],
      [pinned, "claimed-fixed-pin"],
    ] as const) {
      expect(numericSummary(output.recorder, "judgment.reputation")).toEqual(
        PROTECTED_BLOCKING_PRESERVED,
      );
      expectEffect(output.result.dedupedFindings[0], {
        pass_id: "judgment.reputation",
        order: 150,
        action: "protected",
        before: "WARN",
        after: "WARN",
        reason_code: "unreliable-reviewer",
        protected_by: protectedBy,
      });
    }
  });

  it("records region no-opportunity, miss, active, ablated, and insufficient-history protection", () => {
    const noOpportunity = run("region-no-line", {
      findings: [finding({ line_start: 0, line_end: 0 })],
      reviewersTotal: 1,
      rejectedRegions: [rejectedRegion()],
    });
    const miss = run("region-miss", {
      findings: [finding({ line_start: 40, line_end: 40 })],
      reviewersTotal: 1,
      rejectedRegions: [rejectedRegion()],
    });
    const input = {
      findings: [finding()],
      reviewersTotal: 1,
      rejectedRegions: [rejectedRegion()],
    };
    const active = run("region-active", input);
    const ablated = run("region-ablated", input, ["history.region-rejected"]);
    const protectedResult = run("region-insufficient", {
      ...input,
      rejectedRegions: [rejectedRegion({ distinct_count: 1 })],
    });

    expect(numericSummary(noOpportunity.recorder, "history.region-rejected")).toEqual(
      NO_OPPORTUNITY,
    );
    expect(numericSummary(miss.recorder, "history.region-rejected")).toEqual(PREDICATE_MISS);
    expect(numericSummary(active.recorder, "history.region-rejected")).toEqual(
      ACTIVE_BLOCKING_REMOVAL,
    );
    expect(numericSummary(ablated.recorder, "history.region-rejected")).toEqual(
      ABLATED_BLOCKING_PRESERVED,
    );
    expect(numericSummary(protectedResult.recorder, "history.region-rejected")).toEqual(
      PROTECTED_BLOCKING_PRESERVED,
    );
    expect(active.result.regionSuppressedCount).toBe(1);
    expect(ablated.result.regionSuppressedCount).toBe(0);
    expect(ablated.result.dedupedFindings[0]).not.toHaveProperty("region_rejected_match");
    expect(protectedResult.result.dedupedFindings[0]?.region_rejected_match?.suppressed).toBe(
      false,
    );
    expectEffect(protectedResult.result.dedupedFindings[0], {
      pass_id: "history.region-rejected",
      order: 160,
      action: "protected",
      before: "WARN",
      after: "WARN",
      reason_code: "rejected-region-overlap",
      protected_by: "insufficient-distinct-rejections",
    });
  });

  it("records every region-rejection guard on the attempted overlap", () => {
    const cases: Array<{
      name: string;
      input: AggregateInput;
      protectedBy: PolicyProtectionCode;
      before?: Finding["severity"];
    }> = [
      {
        name: "claimed-fixed",
        input: {
          findings: [finding()],
          reviewersTotal: 2,
          rejectedRegions: [rejectedRegion()],
          claimedFixed: new Map([["sig-policy", 1]]),
        },
        protectedBy: "claimed-fixed-pin",
      },
      {
        name: "category-change",
        input: {
          findings: [finding({ category: "performance" })],
          reviewersTotal: 2,
          rejectedRegions: [rejectedRegion()],
        },
        protectedBy: "category-change",
      },
      {
        name: "severity-increase",
        input: {
          findings: [finding({ severity: "CRITICAL" })],
          reviewersTotal: 2,
          rejectedRegions: [rejectedRegion()],
        },
        protectedBy: "severity-increase",
        before: "CRITICAL",
      },
      {
        name: "critical-floor",
        input: {
          findings: [finding({ demoted_from_critical: true })],
          reviewersTotal: 2,
          rejectedRegions: [rejectedRegion()],
        },
        protectedBy: "critical-floor",
      },
      {
        name: "security-floor",
        input: {
          findings: [finding({ category: "security" })],
          reviewersTotal: 2,
          rejectedRegions: [rejectedRegion({ categories: ["security"] })],
        },
        protectedBy: "security-correctness-floor",
      },
    ];

    for (const testCase of cases) {
      const output = run(`region-${testCase.name}`, testCase.input);
      expect(numericSummary(output.recorder, "history.region-rejected")).toEqual(
        PROTECTED_BLOCKING_PRESERVED,
      );
      expectEffect(output.result.dedupedFindings[0], {
        pass_id: "history.region-rejected",
        order: 160,
        action: "protected",
        before: testCase.before ?? "WARN",
        after: testCase.before ?? "WARN",
        reason_code: "rejected-region-overlap",
        protected_by: testCase.protectedBy,
      });
    }
  });

  it("records test-security no-opportunity, miss, active, ablated, and mixed-cluster protection", () => {
    const info = run("test-security-info", {
      findings: [finding({ severity: "INFO", category: "security", file: "src/a.test.ts" })],
      reviewersTotal: 1,
      demoteTestSecurity: true,
    });
    const miss = run("test-security-miss", {
      findings: [finding({ file: "src/a.test.ts" })],
      reviewersTotal: 1,
      demoteTestSecurity: true,
    });
    const security = finding({ category: "security", file: "src/a.test.ts" });
    const input = { findings: [security], reviewersTotal: 1, demoteTestSecurity: true };
    const active = run("test-security-active", input);
    const ablated = run("test-security-ablated", input, ["judgment.test-security"]);
    const mixedSecurity = finding({
      signature: "sig-test-security",
      category: "security",
      file: "src/a.test.ts",
      message: "same test issue reported here",
    });
    const mixedCorrectness = finding({
      signature: "sig-test-correctness",
      category: "correctness",
      file: "src/a.test.ts",
      message: "same test issue reported here",
    });
    const protectedResult = run("test-security-protected", {
      findings: [mixedSecurity, mixedCorrectness],
      reviewersTotal: 1,
      demoteTestSecurity: true,
    });

    expect(numericSummary(info.recorder, "judgment.test-security")).toEqual(NO_OPPORTUNITY);
    expect(numericSummary(miss.recorder, "judgment.test-security")).toEqual(PREDICATE_MISS);
    expect(numericSummary(active.recorder, "judgment.test-security")).toEqual(
      ACTIVE_BLOCKING_REMOVAL,
    );
    expect(numericSummary(ablated.recorder, "judgment.test-security")).toEqual(
      ABLATED_BLOCKING_PRESERVED,
    );
    expect(numericSummary(protectedResult.recorder, "judgment.test-security")).toEqual(
      PROTECTED_BLOCKING_PRESERVED,
    );
    expect(ablated.result.dedupedFindings[0]).not.toHaveProperty("test_severity_demoted");
    const protectedFinding = protectedResult.result.dedupedFindings[0];
    expect(protectedFinding?.members).toHaveLength(2);
    expectEffect(protectedFinding, {
      pass_id: "judgment.test-security",
      order: 170,
      action: "protected",
      before: "WARN",
      after: "WARN",
      reason_code: "test-only-security",
      protected_by: "mixed-category-cluster",
      source_signatures: ["sig-test-correctness", "sig-test-security"],
    });
  });

  it("records docs-cap no-opportunity, miss, active, ablated, and protected tuples", () => {
    const noOpportunity = run("docs-warn", {
      findings: [finding({ file: "README.md" })],
      reviewersTotal: 1,
      capDocsSeverity: true,
    });
    const miss = run("docs-source", {
      findings: [finding({ severity: "CRITICAL" })],
      reviewersTotal: 2,
      capDocsSeverity: true,
    });
    const docs = finding({ severity: "CRITICAL", file: "README.md" });
    const input = { findings: [docs], reviewersTotal: 1, capDocsSeverity: true };
    const active = run("docs-active", input);
    const ablated = run("docs-ablated", input, ["judgment.docs-cap"]);
    const protectedResult = run("docs-protected", {
      findings: [finding({ severity: "CRITICAL", category: "correctness", file: "README.md" })],
      reviewersTotal: 1,
      capDocsSeverity: true,
    });

    expect(numericSummary(noOpportunity.recorder, "judgment.docs-cap")).toEqual(NO_OPPORTUNITY);
    expect(numericSummary(miss.recorder, "judgment.docs-cap")).toEqual(PREDICATE_MISS);
    expect(numericSummary(active.recorder, "judgment.docs-cap")).toEqual(ACTIVE_BLOCKING_PRESERVED);
    expect(numericSummary(ablated.recorder, "judgment.docs-cap")).toEqual(
      ABLATED_BLOCKING_PRESERVED,
    );
    expect(numericSummary(protectedResult.recorder, "judgment.docs-cap")).toEqual(
      PROTECTED_BLOCKING_PRESERVED,
    );
    expect(active.result.dedupedFindings[0]).toMatchObject({
      severity: "WARN",
      docs_severity_capped: true,
      demoted_from_critical: true,
    });
    expect(ablated.result.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(ablated.result.dedupedFindings[0]).not.toHaveProperty("docs_severity_capped");
    expectEffect(active.result.dedupedFindings[0], {
      pass_id: "judgment.docs-cap",
      order: 180,
      action: "capped",
      before: "CRITICAL",
      after: "WARN",
      reason_code: "docs-critical-cap",
    });
    expectEffect(protectedResult.result.dedupedFindings[0], {
      pass_id: "judgment.docs-cap",
      order: 180,
      action: "protected",
      before: "CRITICAL",
      after: "CRITICAL",
      reason_code: "docs-critical-cap",
      protected_by: "security-correctness-floor",
    });
  });
});

describe("second-half ablation marker isolation", () => {
  it("preserves legacy FP-signature INFO attribution only when the pass is not ablated", () => {
    const original = finding({ severity: "INFO", details: "original FP details" });
    const input = {
      findings: [original],
      reviewersTotal: 1,
      fpActive: new Map([["sig-policy", { id: "FP-001" }]]),
    };
    const legacy = aggregate(input);
    const control = aggregate({ findings: [original], reviewersTotal: 1 });
    const active = run("fp-info-marker-active", input);
    const ablated = run("fp-info-marker-ablated", input, ["history.fp-signature"]);

    expect(withoutPolicyEffects(active.result.dedupedFindings[0])).toEqual(
      legacy.dedupedFindings[0],
    );
    expect(active.result.dedupedFindings[0]?.fp_ledger_match).toEqual({
      pattern_id: "FP-001",
      matched_count: 1,
      suppressed: true,
    });
    expect(ablated.result.dedupedFindings[0]).toEqual(control.dedupedFindings[0]);
    expect(implicitOutcomes(ablated.result.dedupedFindings[0])).toEqual([]);
  });

  it("does not leak the FP-cluster INFO attribution branch through ablation", () => {
    const original = finding({ severity: "INFO", details: "original cluster details" });
    const input = {
      findings: [original],
      reviewersTotal: 1,
      fpActiveClusters: activeCluster(),
    };
    const legacy = aggregate(input);
    const control = aggregate({ findings: [original], reviewersTotal: 1 });
    const active = run("fp-cluster-info-marker-active", input);
    const ablated = run("fp-cluster-info-marker-ablated", input, ["history.fp-cluster"]);

    expect(withoutPolicyEffects(active.result.dedupedFindings[0])).toEqual(
      legacy.dedupedFindings[0],
    );
    expect(active.result.dedupedFindings[0]?.fp_cluster_match?.suppressed).toBe(true);
    expect(ablated.result.dedupedFindings[0]).toEqual(control.dedupedFindings[0]);
  });

  it("removes confidence G0 and high-precision markers, details, effects, and implicit outcomes", () => {
    const g0 = finding({
      confidence: 0.1,
      demoted_from_critical: true,
      details: "original confidence details",
    });
    const g0Input = { findings: [g0], reviewersTotal: 1, confidenceFloor: 0.5 };
    const g0Legacy = aggregate(g0Input);
    const g0Control = aggregate({ findings: [g0], reviewersTotal: 1 });
    const g0Active = run("confidence-g0-marker-active", g0Input);
    const g0Ablated = run("confidence-g0-marker-ablated", g0Input, ["judgment.confidence"]);

    expect(withoutPolicyEffects(g0Active.result.dedupedFindings[0])).toEqual(
      g0Legacy.dedupedFindings[0],
    );
    expect(g0Active.result.dedupedFindings[0]).toMatchObject({
      low_confidence: true,
      demoted_from_critical: true,
    });
    expect(g0Ablated.result.dedupedFindings[0]).toEqual(g0Control.dedupedFindings[0]);
    expect(implicitOutcomes(g0Ablated.result.dedupedFindings[0])).toEqual([]);

    const protectedFinding = finding({
      confidence: 0.1,
      details: "original protected details",
    });
    const protectedInput = {
      findings: [protectedFinding],
      reviewersTotal: 1,
      confidenceFloor: 0.5,
      protectedReviewers: new Set(["codex"]),
    };
    const protectedLegacy = aggregate(protectedInput);
    const protectedControl = aggregate({ findings: [protectedFinding], reviewersTotal: 1 });
    const protectedActive = run("confidence-protected-marker-active", protectedInput);
    const protectedAblated = run("confidence-protected-marker-ablated", protectedInput, [
      "judgment.confidence",
    ]);

    expect(withoutPolicyEffects(protectedActive.result.dedupedFindings[0])).toEqual(
      protectedLegacy.dedupedFindings[0],
    );
    expect(protectedActive.result.dedupedFindings[0]?.protected_high_precision).toBe(true);
    expect(protectedAblated.result.dedupedFindings[0]).toEqual(protectedControl.dedupedFindings[0]);
  });

  it("removes reputation G0 markers, details, effects, and implicit outcomes", () => {
    const original = finding({
      demoted_from_critical: true,
      details: "original reputation details",
    });
    const input = {
      findings: [original],
      reviewersTotal: 1,
      repUnreliable: new Set(["codex:quality"]),
    };
    const legacy = aggregate(input);
    const control = aggregate({ findings: [original], reviewersTotal: 1 });
    const active = run("reputation-g0-marker-active", input);
    const ablated = run("reputation-g0-marker-ablated", input, ["judgment.reputation"]);

    expect(withoutPolicyEffects(active.result.dedupedFindings[0])).toEqual(
      legacy.dedupedFindings[0],
    );
    expect(active.result.dedupedFindings[0]?.reputation_demoted).toBe(true);
    expect(implicitOutcomes(ablated.result.dedupedFindings[0])).toEqual([]);
    expect(ablated.result.dedupedFindings[0]).toEqual(control.dedupedFindings[0]);
  });

  it("removes protected region badges and INFO test-security markers under ablation", () => {
    const regionFinding = finding({ details: "original region details" });
    const regionInput = {
      findings: [regionFinding],
      reviewersTotal: 1,
      rejectedRegions: [rejectedRegion({ distinct_count: 1 })],
    };
    const regionLegacy = aggregate(regionInput);
    const regionControl = aggregate({ findings: [regionFinding], reviewersTotal: 1 });
    const regionActive = run("region-marker-active", regionInput);
    const regionAblated = run("region-marker-ablated", regionInput, ["history.region-rejected"]);

    expect(withoutPolicyEffects(regionActive.result.dedupedFindings[0])).toEqual(
      regionLegacy.dedupedFindings[0],
    );
    expect(regionActive.result.dedupedFindings[0]?.region_rejected_match?.suppressed).toBe(false);
    expect(regionAblated.result.dedupedFindings[0]).toEqual(regionControl.dedupedFindings[0]);

    const testFinding = finding({
      severity: "INFO",
      category: "security",
      file: "tests/a.test.ts",
      details: "original test details",
    });
    const testInput = {
      findings: [testFinding],
      reviewersTotal: 1,
      demoteTestSecurity: true,
    };
    const testLegacy = aggregate(testInput);
    const testControl = aggregate({ findings: [testFinding], reviewersTotal: 1 });
    const testActive = run("test-security-info-marker-active", testInput);
    const testAblated = run("test-security-info-marker-ablated", testInput, [
      "judgment.test-security",
    ]);

    expect(withoutPolicyEffects(testActive.result.dedupedFindings[0])).toEqual(
      testLegacy.dedupedFindings[0],
    );
    expect(testActive.result.dedupedFindings[0]?.test_severity_demoted).toBe(true);
    expect(testAblated.result.dedupedFindings[0]).toEqual(testControl.dedupedFindings[0]);
  });
});

describe("verdict.compute trace stage", () => {
  it("records exactly one closed verdict reason for every judgment branch", () => {
    const hardCritical = run("verdict-hard-critical", {
      findings: [finding({ category: "security", severity: "CRITICAL" })],
      reviewersTotal: 2,
    });
    const corroboratedA = finding({
      signature: "sig-corroborated-a",
      reviewer: { provider: "codex", model: "m", persona: "quality" },
    });
    const corroboratedB = finding({
      signature: "sig-corroborated-b",
      reviewer: { provider: "gemini", model: "m", persona: "quality" },
    });
    const corroboratedWarn = run("verdict-corroborated-warn", {
      findings: [corroboratedA, corroboratedB],
      reviewersTotal: 2,
    });
    const claimedFixed = run("verdict-claimed-fixed", {
      findings: [finding()],
      reviewersTotal: 2,
      claimedFixed: new Map([["sig-policy", 1]]),
    });
    const blocking = run("verdict-blocking", { findings: [finding()], reviewersTotal: 2 });
    const noBlocking = run("verdict-no-blocking", {
      findings: [finding({ severity: "INFO" })],
      reviewersTotal: 2,
    });

    const cases = [
      [hardCritical, "hard-critical", "FAIL"],
      [corroboratedWarn, "corroborated-warn", "FAIL"],
      [claimedFixed, "claimed-fixed-recurrence", "FAIL"],
      [blocking, "blocking-present", "SOFT-PASS"],
      [noBlocking, "no-blocking-findings", "PASS"],
    ] as const;
    for (const [output, reason, verdict] of cases) {
      const trace = finalized(output);
      const verdictRows = trace.stages.filter((stage) => stage.stage_id === "verdict.compute");
      expect(verdictRows).toHaveLength(1);
      expect(verdictRows[0]).toMatchObject({ reason_code: reason, verdict });
    }
  });

  it("uses the deterministic final-finding order for verdict blocking signatures", () => {
    const output = run("verdict-signature-order", {
      findings: [
        finding({ signature: "sig-a", file: "src/b.ts", line_start: 20, line_end: 20 }),
        finding({ signature: "sig-z", file: "src/a.ts", line_start: 10, line_end: 10 }),
      ],
      reviewersTotal: 2,
    });
    const trace = finalized(output);
    const stage = trace.stages.find((row) => row.stage_id === "verdict.compute");

    expect(output.result.dedupedFindings.map((item) => item.signature)).toEqual(["sig-z", "sig-a"]);
    expect(stage?.input_signatures).toEqual(["sig-z", "sig-a"]);
  });
});
