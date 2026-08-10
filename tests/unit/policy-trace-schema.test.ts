import { describe, expect, it } from "bun:test";
import {
  PolicyEffectSchema,
  PolicyEvaluationSchema,
  PolicyPassSummarySchema,
  PolicyStageEvaluationSchema,
  PolicySummarySchema,
  PolicyTraceFinalSchema,
  PolicyTraceSchema,
} from "../../src/schemas/policy-trace.ts";

const PASS_IDS = [
  "evidence.fact-location",
  "evidence.self-refutation",
  "judgment.hypothetical",
  "evidence.grounding-token",
  "judgment.grounding-llm",
  "evidence.redaction-placeholder",
  "judgment.critic",
  "scope.diff",
  "scope.delta",
  "scope.session",
  "history.fp-signature",
  "history.cycle-rejected",
  "history.fp-cluster",
  "judgment.confidence",
  "judgment.reputation",
  "history.region-rejected",
  "judgment.test-security",
  "judgment.docs-cap",
] as const;

function emptyRanSummary(passId: (typeof PASS_IDS)[number]) {
  return {
    pass_id: passId,
    status: "ran" as const,
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

const validEffect = {
  pass_id: "judgment.confidence",
  order: 140,
  action: "demoted",
  before: "WARN",
  after: "INFO",
  reason_code: "below-confidence-floor",
  source_signatures: ["sig-a", "sig-b"],
};

const validEvaluation = {
  pass_id: "judgment.confidence",
  order: 140,
  result: "applied",
  before: "WARN",
  after: "INFO",
  reason_code: "below-confidence-floor",
  source_signatures: ["sig-a"],
  final_signature: "sig-a",
};

function emptyTrace() {
  return {
    schema: "reviewgate.policy-trace.v1" as const,
    catalog_version: "reviewgate.policy-catalog.v1" as const,
    run_id: "run-1",
    iter: 1,
    ablated: [],
    raw_response_sha256: ["a".repeat(64)],
    passes: PASS_IDS.map(emptyRanSummary),
    evaluations: [],
    stages: [
      {
        stage_id: "verdict.compute" as const,
        order: 190,
        reason_code: "no-blocking-findings" as const,
        input_signatures: [],
        verdict: "PASS" as const,
      },
    ],
    final: {
      verdict: "PASS" as const,
      counts: { critical: 0, warn: 0, info: 0 },
      finding_signatures: [],
      finding_severities: [],
    },
  };
}

function passesWithOnly(
  passId: (typeof PASS_IDS)[number],
  summary: ReturnType<typeof emptyRanSummary>,
) {
  return PASS_IDS.map((candidate) =>
    candidate === passId
      ? summary
      : {
          pass_id: candidate,
          status: "not-run" as const,
          reason_code: "stage-precondition-miss" as const,
        },
  );
}

function traceWithSingleFinal(severity: "CRITICAL" | "WARN" | "INFO") {
  const trace = emptyTrace();
  const counts = {
    critical: severity === "CRITICAL" ? 1 : 0,
    warn: severity === "WARN" ? 1 : 0,
    info: severity === "INFO" ? 1 : 0,
  };
  const blocking = severity !== "INFO";
  return {
    ...trace,
    passes: PASS_IDS.map((passId) => ({
      ...emptyRanSummary(passId),
      considered: 1,
    })),
    evaluations: PASS_IDS.map((passId, index) => ({
      pass_id: passId,
      order: (index + 1) * 10,
      result: "no-opportunity" as const,
      before: severity,
      after: severity,
      reason_code: "ineligible-starting-state" as const,
      source_signatures: ["sig-a"],
      final_signature: "sig-a",
    })),
    stages: [
      {
        stage_id: "aggregation.cluster" as const,
        order: 65,
        reason_code: "singleton" as const,
        input_signatures: ["sig-a"],
        output_signature: "sig-a",
      },
      {
        stage_id: "verdict.compute" as const,
        order: 190,
        reason_code: blocking ? ("blocking-present" as const) : ("no-blocking-findings" as const),
        input_signatures: blocking ? ["sig-a"] : [],
        verdict: blocking ? ("SOFT-PASS" as const) : ("PASS" as const),
      },
    ],
    final: {
      verdict: blocking ? ("SOFT-PASS" as const) : ("PASS" as const),
      counts,
      finding_signatures: ["sig-a"],
      finding_severities: [{ signature: "sig-a", severity }],
    },
  };
}

function traceWithWarnAndInfoFinals() {
  const trace = emptyTrace();
  return {
    ...trace,
    passes: PASS_IDS.map((passId) => ({
      ...emptyRanSummary(passId),
      considered: 2,
    })),
    evaluations: PASS_IDS.flatMap((passId, index) => [
      {
        pass_id: passId,
        order: (index + 1) * 10,
        result: "no-opportunity" as const,
        before: "INFO" as const,
        after: "INFO" as const,
        reason_code: "ineligible-starting-state" as const,
        source_signatures: ["sig-info"],
        final_signature: "sig-info",
      },
      {
        pass_id: passId,
        order: (index + 1) * 10,
        result: "no-opportunity" as const,
        before: "WARN" as const,
        after: "WARN" as const,
        reason_code: "ineligible-starting-state" as const,
        source_signatures: ["sig-warn"],
        final_signature: "sig-warn",
      },
    ]),
    stages: [
      {
        stage_id: "aggregation.cluster" as const,
        order: 65,
        reason_code: "singleton" as const,
        input_signatures: ["sig-info"],
        output_signature: "sig-info",
      },
      {
        stage_id: "aggregation.cluster" as const,
        order: 65,
        reason_code: "singleton" as const,
        input_signatures: ["sig-warn"],
        output_signature: "sig-warn",
      },
      {
        stage_id: "verdict.compute" as const,
        order: 190,
        reason_code: "blocking-present" as const,
        input_signatures: ["sig-warn"],
        verdict: "SOFT-PASS" as const,
      },
    ],
    final: {
      verdict: "SOFT-PASS" as const,
      counts: { critical: 0, warn: 1, info: 1 },
      finding_signatures: ["sig-info", "sig-warn"],
      finding_severities: [
        { signature: "sig-info", severity: "INFO" as const },
        { signature: "sig-warn", severity: "WARN" as const },
      ],
    },
  };
}

describe("PolicyEffectSchema", () => {
  it("accepts a catalog-valid material effect", () => {
    expect(PolicyEffectSchema.parse(validEffect).reason_code).toBe("below-confidence-floor");
  });

  it("rejects unknown pass, protection, and action values", () => {
    expect(
      PolicyEffectSchema.safeParse({ ...validEffect, pass_id: "judgment.unknown" }).success,
    ).toBe(false);
    expect(PolicyEffectSchema.safeParse({ ...validEffect, action: "rewritten" }).success).toBe(
      false,
    );
    expect(
      PolicyEffectSchema.safeParse({
        ...validEffect,
        action: "protected",
        after: "WARN",
        protected_by: "reviewer-said-so",
      }).success,
    ).toBe(false);
  });

  it("rejects reviewer-controlled prose as a reason code", () => {
    expect(
      PolicyEffectSchema.safeParse({
        ...validEffect,
        reason_code: "The reviewer said this looked suspicious in the diff",
      }).success,
    ).toBe(false);
  });

  it("rejects a globally known reason, protection, or action on the wrong pass", () => {
    expect(
      PolicyEffectSchema.safeParse({ ...validEffect, reason_code: "docs-critical-cap" }).success,
    ).toBe(false);
    expect(
      PolicyEffectSchema.safeParse({ ...validEffect, action: "suppressed", after: "INFO" }).success,
    ).toBe(false);
    expect(
      PolicyEffectSchema.safeParse({
        ...validEffect,
        action: "protected",
        after: "WARN",
        protected_by: "mixed-category-cluster",
      }).success,
    ).toBe(false);
  });

  it("requires source signatures to be sorted and deduplicated", () => {
    expect(
      PolicyEffectSchema.safeParse({ ...validEffect, source_signatures: ["sig-b", "sig-a"] })
        .success,
    ).toBe(false);
    expect(
      PolicyEffectSchema.safeParse({ ...validEffect, source_signatures: ["sig-a", "sig-a"] })
        .success,
    ).toBe(false);
    expect(
      PolicyEffectSchema.safeParse({ ...validEffect, source_signatures: ["sig-a", "sig-b"] })
        .success,
    ).toBe(true);
  });

  it("enforces action-specific after and protection states", () => {
    expect(PolicyEffectSchema.safeParse({ ...validEffect, after: "WARN" }).success).toBe(false);
    expect(PolicyEffectSchema.safeParse({ ...validEffect, after: null }).success).toBe(false);
    expect(
      PolicyEffectSchema.safeParse({
        pass_id: "judgment.critic",
        order: 70,
        action: "dropped",
        before: "INFO",
        after: null,
        reason_code: "critic-likely-fp",
        source_signatures: ["sig-a"],
      }).success,
    ).toBe(true);
    expect(
      PolicyEffectSchema.safeParse({
        ...validEffect,
        action: "protected",
        after: "WARN",
        protected_by: "high-precision-reviewer",
      }).success,
    ).toBe(true);
  });

  it("rejects pass-specific reason/action/transition mismatches", () => {
    expect(
      PolicyEffectSchema.safeParse({
        pass_id: "evidence.fact-location",
        order: 10,
        action: "reanchored",
        before: "WARN",
        after: "WARN",
        reason_code: "location-out-of-range",
        source_signatures: ["sig-a"],
      }).success,
    ).toBe(false);
    expect(
      PolicyEffectSchema.safeParse({
        pass_id: "judgment.docs-cap",
        order: 180,
        action: "capped",
        before: "CRITICAL",
        after: "INFO",
        reason_code: "docs-critical-cap",
        source_signatures: ["sig-a"],
      }).success,
    ).toBe(false);
    expect(
      PolicyEffectSchema.safeParse({
        pass_id: "judgment.critic",
        order: 70,
        action: "dropped",
        before: "WARN",
        after: null,
        reason_code: "critic-likely-fp",
        source_signatures: ["sig-a"],
      }).success,
    ).toBe(false);
    expect(
      PolicyEffectSchema.safeParse({
        pass_id: "judgment.docs-cap",
        order: 180,
        action: "capped",
        before: "CRITICAL",
        after: "WARN",
        reason_code: "docs-critical-cap",
        source_signatures: ["sig-a"],
      }).success,
    ).toBe(true);
  });

  it("binds each protection code to its exact starting severity", () => {
    const criticProtection = {
      pass_id: "judgment.critic",
      order: 70,
      action: "protected",
      before: "WARN",
      after: "WARN",
      reason_code: "critic-likely-fp",
      protected_by: "high-precision-reviewer",
      source_signatures: ["sig-a"],
    } as const;
    expect(PolicyEffectSchema.safeParse(criticProtection).success).toBe(true);
    expect(
      PolicyEffectSchema.safeParse({
        ...criticProtection,
        before: "INFO",
        after: "INFO",
      }).success,
    ).toBe(false);

    const selfRefutationVisibility = {
      ...criticProtection,
      before: "INFO",
      after: "INFO",
      protected_by: "self-refutation-visibility",
    } as const;
    expect(PolicyEffectSchema.safeParse(selfRefutationVisibility).success).toBe(true);
    expect(
      PolicyEffectSchema.safeParse({
        ...selfRefutationVisibility,
        before: "CRITICAL",
        after: "CRITICAL",
      }).success,
    ).toBe(false);
    expect(
      PolicyEffectSchema.safeParse({
        ...criticProtection,
        before: "INFO",
        after: "INFO",
        protected_by: "claimed-fixed-pin",
      }).success,
    ).toBe(true);
  });
});

describe("PolicyEvaluationSchema", () => {
  it("accepts an applied evaluation and rejects mismatched result semantics", () => {
    expect(PolicyEvaluationSchema.safeParse(validEvaluation).success).toBe(true);
    expect(
      PolicyEvaluationSchema.safeParse({
        ...validEvaluation,
        result: "no-match",
        reason_code: "below-confidence-floor",
        after: "WARN",
      }).success,
    ).toBe(false);
    expect(
      PolicyEvaluationSchema.safeParse({
        ...validEvaluation,
        result: "protected",
        after: "WARN",
      }).success,
    ).toBe(false);
  });

  it("validates order, per-pass reason, protection, and lineage signatures", () => {
    expect(PolicyEvaluationSchema.safeParse({ ...validEvaluation, order: 150 }).success).toBe(
      false,
    );
    expect(
      PolicyEvaluationSchema.safeParse({ ...validEvaluation, reason_code: "unreliable-reviewer" })
        .success,
    ).toBe(false);
    expect(
      PolicyEvaluationSchema.safeParse({
        ...validEvaluation,
        result: "protected",
        after: "WARN",
        protected_by: "mixed-category-cluster",
      }).success,
    ).toBe(false);
    expect(
      PolicyEvaluationSchema.safeParse({
        ...validEvaluation,
        source_signatures: ["sig-b", "sig-a"],
      }).success,
    ).toBe(false);
  });

  it("rejects applied transitions that the pass cannot produce", () => {
    expect(
      PolicyEvaluationSchema.safeParse({
        pass_id: "judgment.docs-cap",
        order: 180,
        result: "applied",
        before: "CRITICAL",
        after: "INFO",
        reason_code: "docs-critical-cap",
        source_signatures: ["sig-a"],
        final_signature: "sig-a",
      }).success,
    ).toBe(false);
    expect(
      PolicyEvaluationSchema.safeParse({
        pass_id: "judgment.critic",
        order: 70,
        result: "applied",
        before: "WARN",
        after: null,
        reason_code: "critic-likely-fp",
        source_signatures: ["sig-a"],
      }).success,
    ).toBe(false);
  });

  it("accepts a critical match protected before a suppression can apply", () => {
    expect(
      PolicyEvaluationSchema.safeParse({
        pass_id: "history.cycle-rejected",
        order: 120,
        result: "protected",
        before: "CRITICAL",
        after: "CRITICAL",
        reason_code: "cycle-signature-rejected",
        protected_by: "critical-floor",
        source_signatures: ["sig-a"],
        final_signature: "sig-a",
      }).success,
    ).toBe(true);
  });

  it("rejects a protection code at a severity where that guard cannot fire", () => {
    const protectedCycle = {
      pass_id: "history.cycle-rejected",
      order: 120,
      result: "protected",
      before: "WARN",
      after: "WARN",
      reason_code: "cycle-signature-rejected",
      protected_by: "critical-floor",
      source_signatures: ["sig-a"],
      final_signature: "sig-a",
    } as const;
    expect(PolicyEvaluationSchema.safeParse(protectedCycle).success).toBe(false);
    expect(
      PolicyEvaluationSchema.safeParse({
        ...protectedCycle,
        before: "CRITICAL",
        after: "CRITICAL",
      }).success,
    ).toBe(true);
  });

  it("accepts the critic claimed-fixed pin that preserves an INFO finding", () => {
    expect(
      PolicyEvaluationSchema.safeParse({
        pass_id: "judgment.critic",
        order: 70,
        result: "protected",
        before: "INFO",
        after: "INFO",
        reason_code: "critic-likely-fp",
        protected_by: "claimed-fixed-pin",
        source_signatures: ["sig-a"],
        final_signature: "sig-a",
      }).success,
    ).toBe(true);
  });
});

describe("PolicyPassSummarySchema", () => {
  const active = {
    pass_id: "judgment.confidence",
    status: "ran",
    considered: 1,
    opportunities: 1,
    would_apply: 1,
    applied: 1,
    protected: 0,
    blocking_removed: 1,
    blocking_preserved: 0,
    dropped: 0,
  };

  it("accepts a valid complete counter row", () => {
    expect(PolicyPassSummarySchema.safeParse(active).success).toBe(true);
  });

  it("rejects applied counts greater than would-apply counts", () => {
    expect(PolicyPassSummarySchema.safeParse({ ...active, applied: 2 }).success).toBe(false);
  });

  it("rejects every impossible counter relationship", () => {
    const invalid = [
      { ...active, considered: 0 },
      { ...active, opportunities: 0 },
      { ...active, protected: 1 },
      { ...active, blocking_removed: 2 },
      { ...active, blocking_preserved: 1 },
      { ...active, dropped: 2 },
    ];
    for (const row of invalid) expect(PolicyPassSummarySchema.safeParse(row).success).toBe(false);
  });

  it("rejects counters that use an action absent from the pass catalog", () => {
    expect(
      PolicyPassSummarySchema.safeParse({
        ...active,
        pass_id: "history.fp-signature",
        applied: 0,
        protected: 1,
        blocking_removed: 0,
        blocking_preserved: 1,
      }).success,
    ).toBe(false);
    expect(
      PolicyPassSummarySchema.safeParse({
        ...active,
        pass_id: "judgment.docs-cap",
        dropped: 1,
      }).success,
    ).toBe(false);
    expect(
      PolicyPassSummarySchema.safeParse({
        ...active,
        pass_id: "judgment.docs-cap",
        blocking_removed: 1,
      }).success,
    ).toBe(false);
  });

  it("rejects a pass summary that misclassifies an applied blocking outcome", () => {
    expect(
      PolicyPassSummarySchema.safeParse({
        ...active,
        pass_id: "history.fp-signature",
        blocking_removed: 0,
        blocking_preserved: 1,
      }).success,
    ).toBe(false);
  });

  it("forbids counters and free-form reasons on an inactive pass summary", () => {
    expect(
      PolicyPassSummarySchema.safeParse({
        pass_id: "judgment.confidence",
        status: "not-run",
        reason_code: "configured-off",
        considered: 0,
      }).success,
    ).toBe(false);
    expect(
      PolicyPassSummarySchema.safeParse({
        pass_id: "judgment.confidence",
        status: "error",
        reason_code: "provider returned an odd answer",
      }).success,
    ).toBe(false);
  });

  it("binds inactive pass reasons to not-run versus instrumentation error", () => {
    const notRun = {
      pass_id: "judgment.confidence",
      status: "not-run",
      reason_code: "configured-off",
    };
    expect(PolicyPassSummarySchema.safeParse(notRun).success).toBe(true);
    expect(
      PolicyPassSummarySchema.safeParse({
        ...notRun,
        status: "error",
        reason_code: "instrumentation-error",
      }).success,
    ).toBe(true);
    expect(PolicyPassSummarySchema.safeParse({ ...notRun, status: "error" }).success).toBe(false);
    expect(
      PolicyPassSummarySchema.safeParse({ ...notRun, reason_code: "instrumentation-error" })
        .success,
    ).toBe(false);
  });
});

describe("PolicyStageEvaluationSchema", () => {
  it("accepts closed cluster and verdict stage rows", () => {
    expect(
      PolicyStageEvaluationSchema.safeParse({
        stage_id: "aggregation.cluster",
        order: 65,
        reason_code: "clustered",
        input_signatures: ["sig-a", "sig-b"],
        output_signature: "sig-a",
      }).success,
    ).toBe(true);
    expect(
      PolicyStageEvaluationSchema.safeParse({
        stage_id: "verdict.compute",
        order: 190,
        reason_code: "blocking-present",
        input_signatures: ["sig-a"],
        verdict: "SOFT-PASS",
      }).success,
    ).toBe(true);
  });

  it("rejects unknown reason prose and inconsistent stage fields", () => {
    expect(
      PolicyStageEvaluationSchema.safeParse({
        stage_id: "verdict.compute",
        order: 190,
        reason_code: "reviewer sounded confident",
        input_signatures: [],
        verdict: "PASS",
      }).success,
    ).toBe(false);
    expect(
      PolicyStageEvaluationSchema.safeParse({
        stage_id: "aggregation.cluster",
        order: 65,
        reason_code: "singleton",
        input_signatures: ["sig-a", "sig-b"],
        output_signature: "sig-c",
      }).success,
    ).toBe(false);
  });

  it("binds each verdict reason to its only valid verdict", () => {
    expect(
      PolicyStageEvaluationSchema.safeParse({
        stage_id: "verdict.compute",
        order: 190,
        reason_code: "no-blocking-findings",
        input_signatures: [],
        verdict: "FAIL",
      }).success,
    ).toBe(false);
    expect(
      PolicyStageEvaluationSchema.safeParse({
        stage_id: "verdict.compute",
        order: 190,
        reason_code: "blocking-present",
        input_signatures: ["sig-a"],
        verdict: "PASS",
      }).success,
    ).toBe(false);
    expect(
      PolicyStageEvaluationSchema.safeParse({
        stage_id: "verdict.compute",
        order: 190,
        reason_code: "hard-critical",
        input_signatures: ["sig-a"],
        verdict: "SOFT-PASS",
      }).success,
    ).toBe(false);
  });
});

describe("PolicyTraceFinalSchema", () => {
  it("preserves deterministic production finding order while rejecting duplicates", () => {
    const final = {
      verdict: "PASS",
      counts: { critical: 0, warn: 0, info: 2 },
      finding_signatures: ["sig-z", "sig-a"],
      finding_severities: [
        { signature: "sig-z", severity: "INFO" },
        { signature: "sig-a", severity: "INFO" },
      ],
    };
    expect(PolicyTraceFinalSchema.safeParse(final).success).toBe(true);
    expect(
      PolicyTraceFinalSchema.safeParse({
        ...final,
        finding_signatures: ["sig-a", "sig-a"],
      }).success,
    ).toBe(false);
  });

  it("requires ordered one-to-one severity evidence and derives final counts from it", () => {
    const final = {
      verdict: "SOFT-PASS" as const,
      counts: { critical: 0, warn: 1, info: 1 },
      finding_signatures: ["sig-warn", "sig-info"],
      finding_severities: [
        { signature: "sig-warn", severity: "WARN" as const },
        { signature: "sig-info", severity: "INFO" as const },
      ],
    };

    expect(PolicyTraceFinalSchema.safeParse(final).success).toBe(true);
    expect(
      PolicyTraceFinalSchema.safeParse({
        verdict: final.verdict,
        counts: final.counts,
        finding_signatures: final.finding_signatures,
      }).success,
    ).toBe(false);
    expect(
      PolicyTraceFinalSchema.safeParse({
        ...final,
        finding_severities: [final.finding_severities[1], final.finding_severities[0]],
      }).success,
    ).toBe(false);
    expect(
      PolicyTraceFinalSchema.safeParse({
        ...final,
        counts: { critical: 0, warn: 2, info: 0 },
      }).success,
    ).toBe(false);
  });
});

describe("PolicySummarySchema", () => {
  const passes = PASS_IDS.map(emptyRanSummary);
  const hash = "b".repeat(64);

  it("requires an exact ordered 18-pass summary", () => {
    expect(
      PolicySummarySchema.safeParse({
        catalog_version: "reviewgate.policy-catalog.v1",
        status: "error",
        passes,
      }).success,
    ).toBe(true);
    expect(
      PolicySummarySchema.safeParse({
        catalog_version: "reviewgate.policy-catalog.v1",
        status: "error",
        passes: passes.slice(0, -1),
      }).success,
    ).toBe(false);
    expect(
      PolicySummarySchema.safeParse({
        catalog_version: "reviewgate.policy-catalog.v1",
        status: "error",
        passes: [passes[1], passes[0], ...passes.slice(2)],
      }).success,
    ).toBe(false);
  });

  it("requires ref and hash only for a complete trace", () => {
    expect(
      PolicySummarySchema.safeParse({
        catalog_version: "reviewgate.policy-catalog.v1",
        status: "complete",
        passes,
        policy_trace_ref: "audit/2026/08/10/policy/trace.json",
        policy_trace_sha256: hash,
      }).success,
    ).toBe(true);
    expect(
      PolicySummarySchema.safeParse({
        catalog_version: "reviewgate.policy-catalog.v1",
        status: "complete",
        passes,
      }).success,
    ).toBe(false);
    expect(
      PolicySummarySchema.safeParse({
        catalog_version: "reviewgate.policy-catalog.v1",
        status: "error",
        passes,
        policy_trace_ref: "trace.json",
        policy_trace_sha256: hash,
      }).success,
    ).toBe(false);
  });

  it("requires a top-level not-run summary to contain only not-run pass rows", () => {
    expect(
      PolicySummarySchema.safeParse({
        catalog_version: "reviewgate.policy-catalog.v1",
        status: "not-run",
        passes,
      }).success,
    ).toBe(false);

    expect(
      PolicySummarySchema.safeParse({
        catalog_version: "reviewgate.policy-catalog.v1",
        status: "not-run",
        passes: PASS_IDS.map((pass_id) => ({
          pass_id,
          status: "not-run",
          reason_code: "stage-precondition-miss",
        })),
      }).success,
    ).toBe(true);
  });
});

describe("PolicyTraceSchema", () => {
  it("accepts a complete empty-finding trace", () => {
    expect(PolicyTraceSchema.safeParse(emptyTrace()).success).toBe(true);
  });

  it("rejects missing pass rows, malformed hashes, and duplicate ablations", () => {
    const trace = emptyTrace();
    expect(
      PolicyTraceSchema.safeParse({ ...trace, passes: trace.passes.slice(0, -1) }).success,
    ).toBe(false);
    expect(
      PolicyTraceSchema.safeParse({ ...trace, raw_response_sha256: ["A".repeat(64)] }).success,
    ).toBe(false);
    expect(
      PolicyTraceSchema.safeParse({
        ...trace,
        ablated: ["judgment.confidence", "judgment.confidence"],
      }).success,
    ).toBe(false);
  });

  it("rejects summaries that disagree with per-finding evaluations", () => {
    const trace = emptyTrace();
    const confidenceIndex = PASS_IDS.indexOf("judgment.confidence");
    const passes = [...trace.passes];
    passes[confidenceIndex] = {
      ...emptyRanSummary("judgment.confidence"),
      considered: 1,
      opportunities: 1,
      would_apply: 1,
      applied: 1,
      blocking_removed: 0,
    };
    expect(
      PolicyTraceSchema.safeParse({
        ...trace,
        passes,
        evaluations: [validEvaluation],
        stages: [
          {
            stage_id: "aggregation.cluster",
            order: 65,
            reason_code: "singleton",
            input_signatures: ["sig-a"],
            output_signature: "sig-a",
          },
          {
            stage_id: "verdict.compute",
            order: 190,
            reason_code: "no-blocking-findings",
            input_signatures: [],
            verdict: "PASS",
          },
        ],
        final: {
          verdict: "PASS",
          counts: { critical: 0, warn: 0, info: 1 },
          finding_signatures: ["sig-a"],
          finding_severities: [{ signature: "sig-a", severity: "INFO" }],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects a missing verdict stage or cluster outputs inconsistent with final findings", () => {
    const trace = emptyTrace();
    expect(PolicyTraceSchema.safeParse({ ...trace, stages: [] }).success).toBe(false);
    expect(
      PolicyTraceSchema.safeParse({
        ...trace,
        final: {
          verdict: "PASS",
          counts: { critical: 0, warn: 0, info: 1 },
          finding_signatures: ["sig-a"],
          finding_severities: [{ signature: "sig-a", severity: "INFO" }],
        },
      }).success,
    ).toBe(false);
  });

  it("cross-checks applied and would-apply evaluations against the ablation set", () => {
    const applied = traceWithSingleFinal("INFO");
    const appliedSummary = {
      ...emptyRanSummary("judgment.confidence"),
      considered: 1,
      opportunities: 1,
      would_apply: 1,
      applied: 1,
      blocking_removed: 1,
    };
    expect(
      PolicyTraceSchema.safeParse({
        ...applied,
        ablated: ["judgment.confidence"],
        passes: passesWithOnly("judgment.confidence", appliedSummary),
        evaluations: [validEvaluation],
      }).success,
    ).toBe(false);

    const wouldApply = traceWithSingleFinal("WARN");
    const wouldApplyEvaluation = {
      ...validEvaluation,
      result: "would-apply",
      after: "WARN",
    } as const;
    const wouldApplySummary = {
      ...emptyRanSummary("judgment.confidence"),
      considered: 1,
      opportunities: 1,
      would_apply: 1,
      blocking_preserved: 1,
    };
    expect(
      PolicyTraceSchema.safeParse({
        ...wouldApply,
        passes: passesWithOnly("judgment.confidence", wouldApplySummary),
        evaluations: [wouldApplyEvaluation],
      }).success,
    ).toBe(false);
    expect(
      PolicyTraceSchema.safeParse({
        ...wouldApply,
        ablated: ["judgment.confidence"],
        passes: passesWithOnly("judgment.confidence", wouldApplySummary),
        evaluations: [wouldApplyEvaluation],
      }).success,
    ).toBe(true);
  });

  it("keeps a post-cluster critic drop traceable without treating it as a final finding", () => {
    const trace = emptyTrace();
    const criticSummary = {
      ...emptyRanSummary("judgment.critic"),
      considered: 1,
      opportunities: 1,
      would_apply: 1,
      applied: 1,
      dropped: 1,
    };
    const droppedEvaluation = {
      pass_id: "judgment.critic" as const,
      order: 70,
      result: "applied" as const,
      before: "INFO" as const,
      after: null,
      reason_code: "critic-likely-fp" as const,
      source_signatures: ["sig-a"],
    };
    const stages = [
      {
        stage_id: "aggregation.cluster" as const,
        order: 65,
        reason_code: "singleton" as const,
        input_signatures: ["sig-a"],
        output_signature: "sig-a",
      },
      ...trace.stages,
    ];
    const droppedTrace = {
      ...trace,
      passes: passesWithOnly("judgment.critic", criticSummary),
      evaluations: [droppedEvaluation],
      stages,
    };
    expect(PolicyTraceSchema.safeParse(droppedTrace).success).toBe(true);
    expect(
      PolicyTraceSchema.safeParse({
        ...droppedTrace,
        stages: trace.stages,
      }).success,
    ).toBe(false);
  });

  it("rejects a dropped cluster output that remains in the final findings", () => {
    const trace = emptyTrace();
    expect(
      PolicyTraceSchema.safeParse({
        ...trace,
        passes: passesWithOnly("judgment.critic", {
          ...emptyRanSummary("judgment.critic"),
          considered: 1,
          opportunities: 1,
          would_apply: 1,
          applied: 1,
          dropped: 1,
        }),
        evaluations: [
          {
            pass_id: "judgment.critic",
            order: 70,
            result: "applied",
            before: "INFO",
            after: null,
            reason_code: "critic-likely-fp",
            source_signatures: ["sig-a"],
          },
        ],
        stages: [
          {
            stage_id: "aggregation.cluster",
            order: 65,
            reason_code: "singleton",
            input_signatures: ["sig-a"],
            output_signature: "sig-a",
          },
          ...trace.stages,
        ],
        final: {
          verdict: "PASS",
          counts: { critical: 0, warn: 0, info: 1 },
          finding_signatures: ["sig-a"],
          finding_severities: [{ signature: "sig-a", severity: "INFO" }],
        },
      }).success,
    ).toBe(false);
  });

  it("requires each evaluation lineage and final signature to resolve to one cluster output", () => {
    const trace = traceWithWarnAndInfoFinals();
    expect(
      PolicyTraceSchema.safeParse({
        ...trace,
        evaluations: trace.evaluations.map((evaluation, index) =>
          index === 0 ? { ...evaluation, final_signature: "sig-warn" } : evaluation,
        ),
      }).success,
    ).toBe(false);
  });

  it("rejects a cluster input assigned to more than one output", () => {
    const trace = traceWithWarnAndInfoFinals();
    expect(
      PolicyTraceSchema.safeParse({
        ...trace,
        stages: [
          trace.stages[0],
          {
            ...trace.stages[1],
            reason_code: "clustered",
            input_signatures: ["sig-info", "sig-warn"],
          },
          trace.stages[2],
        ],
      }).success,
    ).toBe(false);
  });

  it("binds the final verdict to blocking counts, signatures, and the verdict stage", () => {
    const warnTrace = traceWithSingleFinal("WARN");
    expect(PolicyTraceSchema.safeParse(warnTrace).success).toBe(true);
    expect(
      PolicyTraceSchema.safeParse({
        ...warnTrace,
        stages: [
          warnTrace.stages[0],
          {
            stage_id: "verdict.compute",
            order: 190,
            reason_code: "no-blocking-findings",
            input_signatures: [],
            verdict: "PASS",
          },
        ],
        final: { ...warnTrace.final, verdict: "PASS" },
      }).success,
    ).toBe(false);
    expect(
      PolicyTraceSchema.safeParse({
        ...warnTrace,
        final: { ...warnTrace.final, verdict: "ERROR" },
      }).success,
    ).toBe(false);
  });

  it("binds verdict reasons to severity counts and excludes unrepresentable ERROR traces", () => {
    const warnTrace = traceWithSingleFinal("WARN");
    expect(
      PolicyTraceSchema.safeParse({
        ...warnTrace,
        stages: [
          warnTrace.stages[0],
          {
            stage_id: "verdict.compute",
            order: 190,
            reason_code: "hard-critical",
            input_signatures: ["sig-a"],
            verdict: "FAIL",
          },
        ],
        final: { ...warnTrace.final, verdict: "FAIL" },
      }).success,
    ).toBe(false);

    const criticalTrace = traceWithSingleFinal("CRITICAL");
    expect(
      PolicyTraceSchema.safeParse({
        ...criticalTrace,
        stages: [
          criticalTrace.stages[0],
          {
            stage_id: "verdict.compute",
            order: 190,
            reason_code: "corroborated-warn",
            input_signatures: ["sig-a"],
            verdict: "FAIL",
          },
        ],
        final: { ...criticalTrace.final, verdict: "FAIL" },
      }).success,
    ).toBe(false);

    const empty = emptyTrace();
    expect(
      PolicyTraceSchema.safeParse({
        ...empty,
        final: { ...empty.final, verdict: "ERROR" },
      }).success,
    ).toBe(false);
  });

  it("requires the verdict stage to enumerate every final blocking signature", () => {
    const single = traceWithSingleFinal("WARN");
    const trace = {
      ...single,
      passes: single.passes.map((summary) => ({ ...summary, considered: 2 })),
      evaluations: single.evaluations.flatMap((evaluation) => [
        evaluation,
        {
          ...evaluation,
          source_signatures: ["sig-b"],
          final_signature: "sig-b",
        },
      ]),
      stages: [
        {
          stage_id: "aggregation.cluster" as const,
          order: 65,
          reason_code: "singleton" as const,
          input_signatures: ["sig-a"],
          output_signature: "sig-a",
        },
        {
          stage_id: "aggregation.cluster" as const,
          order: 65,
          reason_code: "singleton" as const,
          input_signatures: ["sig-b"],
          output_signature: "sig-b",
        },
        {
          stage_id: "verdict.compute" as const,
          order: 190,
          reason_code: "blocking-present" as const,
          input_signatures: ["sig-a", "sig-b"],
          verdict: "SOFT-PASS" as const,
        },
      ],
      final: {
        verdict: "SOFT-PASS" as const,
        counts: { critical: 0, warn: 2, info: 0 },
        finding_signatures: ["sig-a", "sig-b"],
        finding_severities: [
          { signature: "sig-a", severity: "WARN" as const },
          { signature: "sig-b", severity: "WARN" as const },
        ],
      },
    };
    expect(PolicyTraceSchema.safeParse(trace).success).toBe(true);
    expect(
      PolicyTraceSchema.safeParse({
        ...trace,
        stages: [
          trace.stages[0],
          trace.stages[1],
          { ...trace.stages[2], input_signatures: ["sig-a"] },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a verdict stage that swaps an INFO signature for a blocking signature", () => {
    const trace = traceWithWarnAndInfoFinals();
    expect(
      PolicyTraceSchema.safeParse({
        ...trace,
        stages: [
          trace.stages[0],
          trace.stages[1],
          { ...trace.stages[2], input_signatures: ["sig-info"] },
        ],
      }).success,
    ).toBe(false);
  });
});
