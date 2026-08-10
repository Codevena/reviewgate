import { describe, expect, it } from "bun:test";
import { type AggregateInput, aggregate } from "../../src/core/aggregator.ts";
import type {
  PolicyPassId,
  PolicyProtectionCode,
  PolicyReasonCode,
} from "../../src/core/policy/catalog.ts";
import { PolicyTraceRecorder } from "../../src/core/policy/trace.ts";
import type { Finding } from "../../src/schemas/finding.ts";

type NumericSummary = readonly [number, number, number, number, number, number, number, number];

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
  return {
    recorder,
    result: aggregate({ ...input, policyRuntime: recorder }),
  };
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

function stripPolicyEffects(value: Finding | undefined): Finding | undefined {
  if (value === undefined) return undefined;
  const { policy_effects: _policyEffects, ...legacy } = value;
  return legacy as Finding;
}

function expectSingleEffect(
  value: Finding | undefined,
  expected: {
    pass_id: PolicyPassId;
    order: number;
    action: "demoted" | "protected";
    before: Finding["severity"];
    after: Finding["severity"];
    reason_code: PolicyReasonCode;
    protected_by?: PolicyProtectionCode;
    source_signatures?: string[];
  },
): void {
  if (value === undefined) throw new Error("expected a visible finding");
  const { source_signatures = [value.signature], ...effect } = expected;
  expect(value.policy_effects).toEqual([{ ...effect, source_signatures }]);
}

const NO_OPPORTUNITY = [1, 0, 0, 0, 0, 0, 0, 0] as const;
const PREDICATE_MISS = [1, 1, 0, 0, 0, 0, 0, 0] as const;
const ACTIVE_BLOCKING_REMOVAL = [1, 1, 1, 1, 0, 1, 0, 0] as const;
const ABLATED_BLOCKING_PRESERVED = [1, 1, 1, 0, 0, 0, 1, 0] as const;
const PROTECTED_BLOCKING_PRESERVED = [1, 1, 1, 0, 1, 0, 1, 0] as const;

describe("aggregator policy numeric contracts, orders 60-100", () => {
  it("marks fully inactive Critic and scope passes not-run without evaluations", () => {
    const recorder = runtime("inactive-first-half");
    aggregate({
      findings: [finding()],
      reviewersTotal: 1,
      policyRuntime: recorder,
      policyInactive: {
        "judgment.critic": "configured-off",
        "scope.diff": "configured-off",
        "scope.delta": "stage-precondition-miss",
        "scope.session": "stage-precondition-miss",
      },
    });

    expect(recorder.summary("judgment.critic")).toEqual({
      pass_id: "judgment.critic",
      status: "not-run",
      reason_code: "configured-off",
    });
    expect(recorder.summary("scope.diff")).toEqual({
      pass_id: "scope.diff",
      status: "not-run",
      reason_code: "configured-off",
    });
    expect(recorder.summary("scope.delta")).toEqual({
      pass_id: "scope.delta",
      status: "not-run",
      reason_code: "stage-precondition-miss",
    });
    expect(recorder.summary("scope.session")).toEqual({
      pass_id: "scope.session",
      status: "not-run",
      reason_code: "stage-precondition-miss",
    });
    expect(
      recorder
        .evaluations()
        .filter((row) =>
          ["judgment.critic", "scope.diff", "scope.delta", "scope.session"].includes(row.pass_id),
        ),
    ).toEqual([]);
  });

  it("records redaction no-opportunity, miss, active, ablated, and protected tuples", () => {
    const info = run("redaction-info", {
      findings: [
        finding({
          signature: "sig-redaction-info",
          severity: "INFO",
          message: "undefined variable <REDACTED:HIGH_ENTROPY>",
        }),
      ],
      reviewersTotal: 1,
    });
    const bland = run("redaction-bland", {
      findings: [
        finding({
          signature: "sig-redaction-bland",
          message: "exposed value <REDACTED:HIGH_ENTROPY>",
        }),
      ],
      reviewersTotal: 1,
    });
    const activeFinding = finding({
      signature: "sig-redaction-active",
      message: "undefined variable <REDACTED:HIGH_ENTROPY>",
    });
    const active = run("redaction-active", {
      findings: [activeFinding],
      reviewersTotal: 1,
    });
    const ablated = run("redaction-ablated", { findings: [activeFinding], reviewersTotal: 1 }, [
      "evidence.redaction-placeholder",
    ]);
    const protectedFinding = finding({
      signature: "sig-redaction-protected",
      category: "security",
      message: "undefined variable <REDACTED:HIGH_ENTROPY>",
    });
    const protectedResult = run("redaction-protected", {
      findings: [protectedFinding],
      reviewersTotal: 1,
    });

    expect(numericSummary(info.recorder, "evidence.redaction-placeholder")).toEqual(NO_OPPORTUNITY);
    expect(numericSummary(bland.recorder, "evidence.redaction-placeholder")).toEqual(
      PREDICATE_MISS,
    );
    expect(numericSummary(active.recorder, "evidence.redaction-placeholder")).toEqual(
      ACTIVE_BLOCKING_REMOVAL,
    );
    expect(numericSummary(ablated.recorder, "evidence.redaction-placeholder")).toEqual(
      ABLATED_BLOCKING_PRESERVED,
    );
    expect(numericSummary(protectedResult.recorder, "evidence.redaction-placeholder")).toEqual(
      PROTECTED_BLOCKING_PRESERVED,
    );
    expect(stripPolicyEffects(active.result.dedupedFindings[0])).toEqual(
      aggregate({ findings: [activeFinding], reviewersTotal: 1 }).dedupedFindings[0],
    );
    expect(active.result.dedupedFindings[0]).toMatchObject({
      severity: "INFO",
      redaction_demoted: true,
    });
    expect(ablated.result.dedupedFindings[0]).toEqual({
      ...activeFinding,
      id: "F-001",
      confirmed_by: ["codex:quality"],
      members: [
        {
          signature: activeFinding.signature,
          provider: "codex",
          rule_id: activeFinding.rule_id,
          category: activeFinding.category,
          confidence: activeFinding.confidence,
        },
      ],
    });
    expectSingleEffect(active.result.dedupedFindings[0], {
      pass_id: "evidence.redaction-placeholder",
      order: 60,
      action: "demoted",
      before: "WARN",
      after: "INFO",
      reason_code: "placeholder-code-hallucination",
    });
    expectSingleEffect(protectedResult.result.dedupedFindings[0], {
      pass_id: "evidence.redaction-placeholder",
      order: 60,
      action: "protected",
      before: "WARN",
      after: "WARN",
      reason_code: "placeholder-code-hallucination",
      protected_by: "security-correctness-floor",
    });
  });

  it("records critic no-opportunity, keep, active, ablated, protected, and drop tuples", () => {
    const base = finding({ signature: "sig-critic" });
    const absent = run("critic-absent", {
      findings: [base],
      reviewersTotal: 1,
      critic: new Map(),
    });
    const keep = run("critic-keep", {
      findings: [base],
      reviewersTotal: 1,
      critic: new Map([[base.signature, { verdict: "keep" }]]),
    });
    const active = run("critic-active", {
      findings: [base],
      reviewersTotal: 1,
      critic: new Map([[base.signature, { verdict: "likely_fp" }]]),
    });
    const ablated = run(
      "critic-ablated",
      {
        findings: [base],
        reviewersTotal: 1,
        critic: new Map([[base.signature, { verdict: "likely_fp" }]]),
      },
      ["judgment.critic"],
    );
    const majorityA = finding({
      signature: "sig-critic-majority-a",
      reviewer: { provider: "codex", model: "m", persona: "quality" },
    });
    const majorityB = finding({
      signature: "sig-critic-majority-b",
      reviewer: { provider: "gemini", model: "m", persona: "quality" },
    });
    const protectedResult = run("critic-protected", {
      findings: [majorityA, majorityB],
      reviewersTotal: 3,
      critic: new Map([[majorityB.signature, { verdict: "likely_fp" }]]),
    });
    const droppedFinding = finding({ signature: "sig-critic-drop", severity: "INFO" });
    const dropped = run("critic-drop", {
      findings: [droppedFinding],
      reviewersTotal: 1,
      critic: new Map([[droppedFinding.signature, { verdict: "likely_fp" }]]),
    });

    expect(numericSummary(absent.recorder, "judgment.critic")).toEqual(NO_OPPORTUNITY);
    expect(numericSummary(keep.recorder, "judgment.critic")).toEqual(PREDICATE_MISS);
    expect(numericSummary(active.recorder, "judgment.critic")).toEqual(ACTIVE_BLOCKING_REMOVAL);
    expect(numericSummary(ablated.recorder, "judgment.critic")).toEqual(ABLATED_BLOCKING_PRESERVED);
    expect(numericSummary(protectedResult.recorder, "judgment.critic")).toEqual(
      PROTECTED_BLOCKING_PRESERVED,
    );
    expect(numericSummary(dropped.recorder, "judgment.critic")).toEqual([1, 1, 1, 1, 0, 0, 0, 1]);
    expect(active.result.dedupedFindings[0]).toMatchObject({
      severity: "INFO",
      critic_verdict: "likely_fp",
    });
    expect(ablated.result.dedupedFindings[0]?.severity).toBe("WARN");
    expect(ablated.result.dedupedFindings[0]?.critic_verdict).toBeUndefined();
    expectSingleEffect(active.result.dedupedFindings[0], {
      pass_id: "judgment.critic",
      order: 70,
      action: "demoted",
      before: "WARN",
      after: "INFO",
      reason_code: "critic-likely-fp",
    });
    expectSingleEffect(protectedResult.result.dedupedFindings[0], {
      pass_id: "judgment.critic",
      order: 70,
      action: "protected",
      before: "WARN",
      after: "WARN",
      reason_code: "critic-likely-fp",
      protected_by: "corroborated-majority",
      source_signatures: [majorityA.signature, majorityB.signature],
    });
    expect(dropped.result.dedupedFindings).toEqual([]);
    expect(dropped.result.criticDropped.map((item) => item.signature)).toEqual([
      droppedFinding.signature,
    ]);
    expect(dropped.recorder.evaluations()).toContainEqual({
      pass_id: "judgment.critic",
      order: 70,
      result: "applied",
      before: "INFO",
      after: null,
      reason_code: "critic-likely-fp",
      source_signatures: [droppedFinding.signature],
    });
  });

  it("records a claimed-fixed pin only when critic or delta actually attempts a mutation", () => {
    const pinnedFinding = finding({ signature: "sig-claimed-fixed" });
    const claimedFixed = new Map([[pinnedFinding.signature, 2]]);
    const criticKeep = run("claimed-critic-keep", {
      findings: [pinnedFinding],
      reviewersTotal: 1,
      claimedFixed,
      critic: new Map([[pinnedFinding.signature, { verdict: "keep" }]]),
    });
    const criticAttempt = run("claimed-critic-attempt", {
      findings: [pinnedFinding],
      reviewersTotal: 1,
      claimedFixed,
      critic: new Map([[pinnedFinding.signature, { verdict: "likely_fp" }]]),
    });
    const deltaInside = run("claimed-delta-inside", {
      findings: [pinnedFinding],
      reviewersTotal: 1,
      claimedFixed,
      deltaScope: new Set([pinnedFinding.file]),
    });
    const deltaAttempt = run("claimed-delta-attempt", {
      findings: [pinnedFinding],
      reviewersTotal: 1,
      claimedFixed,
      deltaScope: new Set(["src/other.ts"]),
    });

    expect(numericSummary(criticKeep.recorder, "judgment.critic")).toEqual(PREDICATE_MISS);
    expect(criticKeep.result.dedupedFindings[0]?.policy_effects).toBeUndefined();
    expect(numericSummary(criticAttempt.recorder, "judgment.critic")).toEqual(
      PROTECTED_BLOCKING_PRESERVED,
    );
    expectSingleEffect(criticAttempt.result.dedupedFindings[0], {
      pass_id: "judgment.critic",
      order: 70,
      action: "protected",
      before: "WARN",
      after: "WARN",
      reason_code: "critic-likely-fp",
      protected_by: "claimed-fixed-pin",
    });

    expect(numericSummary(deltaInside.recorder, "scope.delta")).toEqual(PREDICATE_MISS);
    expect(deltaInside.result.dedupedFindings[0]?.policy_effects).toBeUndefined();
    expect(numericSummary(deltaAttempt.recorder, "scope.delta")).toEqual(
      PROTECTED_BLOCKING_PRESERVED,
    );
    expectSingleEffect(deltaAttempt.result.dedupedFindings[0], {
      pass_id: "scope.delta",
      order: 90,
      action: "protected",
      before: "WARN",
      after: "WARN",
      reason_code: "outside-delta-scope",
      protected_by: "claimed-fixed-pin",
    });
  });

  it("records active G0 protection but removes its material effect when critic is ablated", () => {
    const clamped = finding({
      signature: "sig-critic-critical-floor",
      severity: "WARN",
      demoted_from_critical: true,
    });
    const input = {
      findings: [clamped],
      reviewersTotal: 1,
      critic: new Map([[clamped.signature, { verdict: "likely_fp" as const }]]),
    };
    const active = run("critic-critical-floor-active", input);
    const ablated = run("critic-critical-floor-ablated", input, ["judgment.critic"]);

    expect(active.recorder.telemetryError).toBe(false);
    expect(ablated.recorder.telemetryError).toBe(false);
    expect(numericSummary(active.recorder, "judgment.critic")).toEqual(
      PROTECTED_BLOCKING_PRESERVED,
    );
    expect(numericSummary(ablated.recorder, "judgment.critic")).toEqual(ABLATED_BLOCKING_PRESERVED);
    expectSingleEffect(active.result.dedupedFindings[0], {
      pass_id: "judgment.critic",
      order: 70,
      action: "protected",
      before: "WARN",
      after: "WARN",
      reason_code: "critic-likely-fp",
      protected_by: "critical-floor",
    });
    expect(ablated.result.dedupedFindings[0]?.policy_effects).toBeUndefined();
    for (const output of [active, ablated]) {
      expect(output.result.dedupedFindings[0]?.critic_verdict).toBeUndefined();
      expect(output.result.dedupedFindings[0]?.critic_reason).toBeUndefined();
      expect(output.result.dedupedFindings[0]?.protected_high_precision).toBeUndefined();
    }
  });

  it("removes the high-precision Critic marker when its protected match is ablated", () => {
    const protectedFinding = finding({ signature: "sig-critic-high-precision-ablated" });
    const critic = new Map([
      [protectedFinding.signature, { verdict: "likely_fp" as const, reason: "not actionable" }],
    ]);
    const input = {
      findings: [protectedFinding],
      reviewersTotal: 1,
      protectedReviewers: new Set(["codex"]),
      critic,
    };
    const legacy = aggregate(input);
    const active = run("critic-high-precision-active", input);
    const ablated = run("critic-high-precision-ablated", input, ["judgment.critic"]);
    const control = aggregate({
      findings: [protectedFinding],
      reviewersTotal: 1,
      protectedReviewers: input.protectedReviewers,
    });

    expect(legacy.dedupedFindings[0]).toMatchObject({ protected_high_precision: true });
    expect(active.result.dedupedFindings[0]).toMatchObject({ protected_high_precision: true });
    expect(numericSummary(active.recorder, "judgment.critic")).toEqual(
      PROTECTED_BLOCKING_PRESERVED,
    );
    expect(numericSummary(ablated.recorder, "judgment.critic")).toEqual(ABLATED_BLOCKING_PRESERVED);
    expect(ablated.result.dedupedFindings[0]).toEqual(control.dedupedFindings[0]);
    expect(ablated.result.dedupedFindings[0]).toMatchObject({
      details: protectedFinding.details,
    });
    expect(ablated.result.dedupedFindings[0]?.protected_high_precision).toBeUndefined();
    expect(ablated.result.dedupedFindings[0]?.critic_verdict).toBeUndefined();
    expect(ablated.result.dedupedFindings[0]?.critic_reason).toBeUndefined();
    expect(ablated.result.dedupedFindings[0]?.policy_effects).toBeUndefined();
    expect(
      ablated.recorder
        .evaluations()
        .filter((evaluation) => evaluation.pass_id === "judgment.critic"),
    ).toEqual([
      {
        pass_id: "judgment.critic",
        order: 70,
        result: "would-apply",
        before: "WARN",
        after: "WARN",
        reason_code: "critic-likely-fp",
        source_signatures: [protectedFinding.signature],
      },
    ]);
  });

  it("removes security and corroboration Critic keep markers when protected matches are ablated", () => {
    const security = finding({
      signature: "sig-critic-security-ablated",
      severity: "CRITICAL",
      category: "security",
    });
    const corroboratedA = finding({
      signature: "sig-critic-corroborated-a",
      reviewer: { provider: "codex", model: "m", persona: "quality" },
    });
    const corroboratedB = finding({
      signature: "sig-critic-corroborated-b",
      reviewer: { provider: "gemini", model: "m", persona: "quality" },
    });
    const cases: Array<{
      name: string;
      findings: Finding[];
      reviewersTotal: number;
      criticSignature: string;
      severity: Finding["severity"];
    }> = [
      {
        name: "security",
        findings: [security],
        reviewersTotal: 1,
        criticSignature: security.signature,
        severity: "CRITICAL",
      },
      {
        name: "corroboration",
        findings: [corroboratedA, corroboratedB],
        reviewersTotal: 3,
        criticSignature: corroboratedB.signature,
        severity: "WARN",
      },
    ];

    for (const testCase of cases) {
      const critic = new Map([[testCase.criticSignature, { verdict: "likely_fp" as const }]]);
      const input = {
        findings: testCase.findings,
        reviewersTotal: testCase.reviewersTotal,
        critic,
      };
      const legacy = aggregate(input);
      const active = run(`critic-${testCase.name}-active`, input);
      const ablated = run(`critic-${testCase.name}-ablated`, input, ["judgment.critic"]);
      const control = aggregate({
        findings: testCase.findings,
        reviewersTotal: testCase.reviewersTotal,
      });

      expect(legacy.dedupedFindings[0]).toMatchObject({ critic_verdict: "keep" });
      expect(active.result.dedupedFindings[0]).toMatchObject({ critic_verdict: "keep" });
      expect(numericSummary(active.recorder, "judgment.critic")).toEqual(
        PROTECTED_BLOCKING_PRESERVED,
      );
      expect(numericSummary(ablated.recorder, "judgment.critic")).toEqual(
        ABLATED_BLOCKING_PRESERVED,
      );
      expect(ablated.result.dedupedFindings[0]).toEqual(control.dedupedFindings[0]);
      expect(ablated.result.dedupedFindings[0]).toMatchObject({
        details: testCase.findings[0]?.details,
      });
      expect(ablated.result.dedupedFindings[0]?.critic_verdict).toBeUndefined();
      expect(ablated.result.dedupedFindings[0]?.critic_reason).toBeUndefined();
      expect(ablated.result.dedupedFindings[0]?.protected_high_precision).toBeUndefined();
      expect(ablated.result.dedupedFindings[0]?.policy_effects).toBeUndefined();
      expect(
        ablated.recorder
          .evaluations()
          .filter((evaluation) => evaluation.pass_id === "judgment.critic"),
      ).toEqual([
        {
          pass_id: "judgment.critic",
          order: 70,
          result: "would-apply",
          before: testCase.severity,
          after: testCase.severity,
          reason_code: "critic-likely-fp",
          source_signatures: testCase.findings.map((item) => item.signature),
        },
      ]);
    }
  });

  it("records diff-scope no-opportunity, miss, active, ablated, and protected tuples", () => {
    const ranges = new Map([["src/a.ts", [[10, 14]] as Array<[number, number]>]]);
    const noLine = run("diff-no-line", {
      findings: [finding({ signature: "sig-diff-no-line", line_start: 0, line_end: 0 })],
      reviewersTotal: 1,
      changedRanges: ranges,
      scopeToDiff: true,
    });
    const inside = run("diff-inside", {
      findings: [finding({ signature: "sig-diff-inside", line_start: 11, line_end: 11 })],
      reviewersTotal: 1,
      changedRanges: ranges,
      scopeToDiff: true,
    });
    const outsideFinding = finding({
      signature: "sig-diff-outside",
      line_start: 50,
      line_end: 50,
    });
    const active = run("diff-active", {
      findings: [outsideFinding],
      reviewersTotal: 1,
      changedRanges: ranges,
      scopeToDiff: true,
    });
    const ablated = run(
      "diff-ablated",
      {
        findings: [outsideFinding],
        reviewersTotal: 1,
        changedRanges: ranges,
        scopeToDiff: true,
      },
      ["scope.diff"],
    );
    const protectedFinding = finding({
      signature: "sig-diff-protected",
      category: "security",
      line_start: 50,
      line_end: 50,
    });
    const protectedResult = run("diff-protected", {
      findings: [protectedFinding],
      reviewersTotal: 1,
      changedRanges: ranges,
      scopeToDiff: true,
      outOfDiffBlocking: ["security"],
    });

    expect(numericSummary(noLine.recorder, "scope.diff")).toEqual(NO_OPPORTUNITY);
    expect(numericSummary(inside.recorder, "scope.diff")).toEqual(PREDICATE_MISS);
    expect(numericSummary(active.recorder, "scope.diff")).toEqual(ACTIVE_BLOCKING_REMOVAL);
    expect(numericSummary(ablated.recorder, "scope.diff")).toEqual(ABLATED_BLOCKING_PRESERVED);
    expect(numericSummary(protectedResult.recorder, "scope.diff")).toEqual(
      PROTECTED_BLOCKING_PRESERVED,
    );
    expect(active.result.dedupedFindings[0]).toMatchObject({
      severity: "INFO",
      scope_demoted: true,
    });
    expect(ablated.result.dedupedFindings[0]?.severity).toBe("WARN");
    expect(ablated.result.dedupedFindings[0]?.scope_demoted).toBeUndefined();
    expectSingleEffect(active.result.dedupedFindings[0], {
      pass_id: "scope.diff",
      order: 80,
      action: "demoted",
      before: "WARN",
      after: "INFO",
      reason_code: "outside-changed-lines",
    });
    expectSingleEffect(protectedResult.result.dedupedFindings[0], {
      pass_id: "scope.diff",
      order: 80,
      action: "protected",
      before: "WARN",
      after: "WARN",
      reason_code: "outside-changed-lines",
      protected_by: "out-of-diff-blocking-hatch",
    });
  });

  it("records delta-scope no-opportunity, miss, active, ablated, and protected tuples", () => {
    const noOpportunity = run("delta-info", {
      findings: [finding({ signature: "sig-delta-info", severity: "INFO" })],
      reviewersTotal: 1,
      deltaScope: new Set(["src/a.ts"]),
    });
    const inside = run("delta-inside", {
      findings: [finding({ signature: "sig-delta-inside" })],
      reviewersTotal: 1,
      deltaScope: new Set(["src/a.ts"]),
    });
    const outsideFinding = finding({ signature: "sig-delta-outside" });
    const active = run("delta-active", {
      findings: [outsideFinding],
      reviewersTotal: 1,
      deltaScope: new Set(["src/other.ts"]),
    });
    const ablated = run(
      "delta-ablated",
      {
        findings: [outsideFinding],
        reviewersTotal: 1,
        deltaScope: new Set(["src/other.ts"]),
      },
      ["scope.delta"],
    );
    const protectedFinding = finding({
      signature: "sig-delta-protected",
      category: "correctness",
    });
    const protectedResult = run("delta-protected", {
      findings: [protectedFinding],
      reviewersTotal: 1,
      deltaScope: new Set(["src/other.ts"]),
    });

    expect(numericSummary(noOpportunity.recorder, "scope.delta")).toEqual(NO_OPPORTUNITY);
    expect(numericSummary(inside.recorder, "scope.delta")).toEqual(PREDICATE_MISS);
    expect(numericSummary(active.recorder, "scope.delta")).toEqual(ACTIVE_BLOCKING_REMOVAL);
    expect(numericSummary(ablated.recorder, "scope.delta")).toEqual(ABLATED_BLOCKING_PRESERVED);
    expect(numericSummary(protectedResult.recorder, "scope.delta")).toEqual(
      PROTECTED_BLOCKING_PRESERVED,
    );
    expect(active.result.dedupedFindings[0]).toMatchObject({
      severity: "INFO",
      delta_scope_demoted: true,
    });
    expect(ablated.result.dedupedFindings[0]?.severity).toBe("WARN");
    expect(ablated.result.dedupedFindings[0]?.delta_scope_demoted).toBeUndefined();
    expectSingleEffect(active.result.dedupedFindings[0], {
      pass_id: "scope.delta",
      order: 90,
      action: "demoted",
      before: "WARN",
      after: "INFO",
      reason_code: "outside-delta-scope",
    });
    expectSingleEffect(protectedResult.result.dedupedFindings[0], {
      pass_id: "scope.delta",
      order: 90,
      action: "protected",
      before: "WARN",
      after: "WARN",
      reason_code: "outside-delta-scope",
      protected_by: "security-correctness-floor",
    });
  });

  it("records session-scope no-opportunity, miss, active, ablated, and protected tuples", () => {
    const noOpportunity = run("session-info", {
      findings: [finding({ signature: "sig-session-info", severity: "INFO" })],
      reviewersTotal: 1,
      foreignFiles: new Set(["src/a.ts"]),
    });
    const owned = run("session-owned", {
      findings: [finding({ signature: "sig-session-owned" })],
      reviewersTotal: 1,
      foreignFiles: new Set(["src/foreign.ts"]),
    });
    const foreignFinding = finding({ signature: "sig-session-foreign" });
    const active = run("session-active", {
      findings: [foreignFinding],
      reviewersTotal: 1,
      foreignFiles: new Set(["src/a.ts"]),
    });
    const ablated = run(
      "session-ablated",
      {
        findings: [foreignFinding],
        reviewersTotal: 1,
        foreignFiles: new Set(["src/a.ts"]),
      },
      ["scope.session"],
    );
    const protectedFinding = finding({
      signature: "sig-session-protected",
      category: "security",
    });
    const protectedResult = run("session-protected", {
      findings: [protectedFinding],
      reviewersTotal: 1,
      foreignFiles: new Set(["src/a.ts"]),
      outOfDiffBlocking: ["security"],
    });

    expect(numericSummary(noOpportunity.recorder, "scope.session")).toEqual(NO_OPPORTUNITY);
    expect(numericSummary(owned.recorder, "scope.session")).toEqual(PREDICATE_MISS);
    expect(numericSummary(active.recorder, "scope.session")).toEqual(ACTIVE_BLOCKING_REMOVAL);
    expect(numericSummary(ablated.recorder, "scope.session")).toEqual(ABLATED_BLOCKING_PRESERVED);
    expect(numericSummary(protectedResult.recorder, "scope.session")).toEqual(
      PROTECTED_BLOCKING_PRESERVED,
    );
    expect(active.result.dedupedFindings[0]).toMatchObject({
      severity: "INFO",
      foreign_to_session: true,
    });
    expect(ablated.result.dedupedFindings[0]?.severity).toBe("WARN");
    expect(ablated.result.dedupedFindings[0]?.foreign_to_session).toBeUndefined();
    expectSingleEffect(active.result.dedupedFindings[0], {
      pass_id: "scope.session",
      order: 100,
      action: "demoted",
      before: "WARN",
      after: "INFO",
      reason_code: "foreign-to-session",
    });
    expectSingleEffect(protectedResult.result.dedupedFindings[0], {
      pass_id: "scope.session",
      order: 100,
      action: "protected",
      before: "WARN",
      after: "WARN",
      reason_code: "foreign-to-session",
      protected_by: "out-of-diff-blocking-hatch",
    });
  });

  it("removes the foreign-session hatch marker when its protected match is ablated", () => {
    const protectedFinding = finding({ signature: "sig-session-hatch-ablated" });
    const input = {
      findings: [protectedFinding],
      reviewersTotal: 1,
      foreignFiles: new Set([protectedFinding.file]),
      outOfDiffBlocking: [protectedFinding.category],
    };
    const legacy = aggregate(input);
    const active = run("session-hatch-active", input);
    const ablated = run("session-hatch-ablated", input, ["scope.session"]);
    const control = aggregate({
      findings: [protectedFinding],
      reviewersTotal: 1,
      outOfDiffBlocking: input.outOfDiffBlocking,
    });

    expect(legacy.dedupedFindings[0]).toMatchObject({ foreign_to_session: true });
    expect(active.result.dedupedFindings[0]).toMatchObject({ foreign_to_session: true });
    expect(numericSummary(active.recorder, "scope.session")).toEqual(PROTECTED_BLOCKING_PRESERVED);
    expect(numericSummary(ablated.recorder, "scope.session")).toEqual(ABLATED_BLOCKING_PRESERVED);
    expect(ablated.result.dedupedFindings[0]).toEqual(control.dedupedFindings[0]);
    expect(ablated.result.dedupedFindings[0]).toMatchObject({
      details: protectedFinding.details,
    });
    expect(ablated.result.dedupedFindings[0]?.foreign_to_session).toBeUndefined();
    expect(ablated.result.dedupedFindings[0]?.policy_effects).toBeUndefined();
    expect(
      ablated.recorder.evaluations().filter((evaluation) => evaluation.pass_id === "scope.session"),
    ).toEqual([
      {
        pass_id: "scope.session",
        order: 100,
        result: "would-apply",
        before: "WARN",
        after: "WARN",
        reason_code: "foreign-to-session",
        source_signatures: [protectedFinding.signature],
      },
    ]);
  });
});

describe("aggregation cluster lineage", () => {
  it("propagates a demoted member effect and links every input to the representative", () => {
    const artifact = finding({
      signature: "sig-artifact",
      message: "undefined variable <REDACTED:HIGH_ENTROPY>",
      reviewer: { provider: "codex", model: "m", persona: "quality" },
    });
    const representative = finding({
      signature: "sig-representative",
      message: "real defect",
      reviewer: { provider: "gemini", model: "m", persona: "quality" },
    });
    const { recorder, result } = run("cluster-lineage", {
      findings: [artifact, representative],
      reviewersTotal: 2,
    });
    const finalFinding = result.dedupedFindings[0];
    if (finalFinding === undefined) throw new Error("expected one final cluster");

    expect(result.dedupedFindings).toHaveLength(1);
    expect(finalFinding.signature).toBe(representative.signature);
    expect(finalFinding.members?.map((member) => member.signature).sort()).toEqual([
      artifact.signature,
      representative.signature,
    ]);
    expect(finalFinding.policy_effects).toEqual([
      {
        pass_id: "evidence.redaction-placeholder",
        order: 60,
        action: "demoted",
        before: "WARN",
        after: "INFO",
        reason_code: "placeholder-code-hallucination",
        source_signatures: [artifact.signature],
      },
    ]);

    const trace = recorder.finalize({
      rawResponseSha256: [],
      verdict: result.verdict,
      finalFindings: result.dedupedFindings,
    });
    if (trace === null) throw new Error("expected a valid finalized policy trace");

    expect(trace.stages).toEqual([
      {
        stage_id: "aggregation.cluster",
        order: 65,
        reason_code: "clustered",
        member_count: 2,
        input_signatures: [artifact.signature, representative.signature],
        output_signature: representative.signature,
      },
      {
        stage_id: "verdict.compute",
        order: 190,
        reason_code: "corroborated-warn",
        input_signatures: [representative.signature],
        verdict: "FAIL",
      },
    ]);
    expect(
      trace.evaluations
        .filter((evaluation) => evaluation.pass_id === "evidence.redaction-placeholder")
        .map((evaluation) => ({
          source: evaluation.source_signatures,
          final: evaluation.final_signature,
        })),
    ).toEqual([
      { source: [artifact.signature], final: representative.signature },
      { source: [representative.signature], final: representative.signature },
    ]);
  });

  it("records one deterministic singleton cluster stage", () => {
    const singleton = finding({ signature: "sig-singleton" });
    const { recorder, result } = run("cluster-singleton", {
      findings: [singleton],
      reviewersTotal: 1,
    });
    const finalFinding = result.dedupedFindings[0];
    if (finalFinding === undefined) throw new Error("expected singleton output");
    const trace = recorder.finalize({
      rawResponseSha256: [],
      verdict: result.verdict,
      finalFindings: result.dedupedFindings,
    });
    expect(trace?.stages[0]).toEqual({
      stage_id: "aggregation.cluster",
      order: 65,
      reason_code: "singleton",
      member_count: 1,
      input_signatures: [singleton.signature],
      output_signature: singleton.signature,
    });
  });

  it("records duplicate-signature reviewer contributions as a two-member cluster", () => {
    const sharedSignature = "sig-shared-contribution";
    const first = finding({
      signature: sharedSignature,
      reviewer: { provider: "codex", model: "m", persona: "quality" },
    });
    const second = finding({
      signature: sharedSignature,
      reviewer: { provider: "gemini", model: "m", persona: "quality" },
    });
    const { recorder, result } = run("cluster-shared-signature", {
      findings: [first, second],
      reviewersTotal: 2,
    });
    const finalFinding = result.dedupedFindings[0];
    if (finalFinding === undefined) throw new Error("expected a shared-signature cluster");
    const trace = recorder.finalize({
      rawResponseSha256: [],
      verdict: result.verdict,
      finalFindings: result.dedupedFindings,
    });

    expect(finalFinding.members).toHaveLength(2);
    expect(trace?.stages[0]).toEqual({
      stage_id: "aggregation.cluster",
      order: 65,
      reason_code: "clustered",
      member_count: 2,
      input_signatures: [sharedSignature],
      output_signature: sharedSignature,
    });
  });
});
