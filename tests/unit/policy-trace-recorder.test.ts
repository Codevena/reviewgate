import { describe, expect, it } from "bun:test";
import {
  PolicyTraceRecorder,
  type TransitionInput,
  mergePolicyEffects,
  transitionFinding,
} from "../../src/core/policy/trace.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import type { PolicyEffect } from "../../src/schemas/policy-trace.ts";

const warnFinding = {
  id: "F-001",
  signature: "sig-confidence",
  severity: "WARN",
  category: "quality",
  rule_id: "naming",
  file: "src/x.ts",
  line_start: 1,
  line_end: 1,
  message: "name is unclear",
  details: "rename the value",
  reviewer: { provider: "codex", model: "m", persona: "quality" },
  confidence: 0.2,
  consensus: "singleton",
} satisfies Finding;

const infoFinding = {
  ...warnFinding,
  id: "F-002",
  signature: "sig-info",
  severity: "INFO",
  confidence: 0.9,
} satisfies Finding;

function stripPolicyEffects(finding: Finding | null): Finding | null {
  if (finding === null) return null;
  const { policy_effects: _policyEffects, ...productionFinding } = finding;
  return productionFinding as Finding;
}

describe("transitionFinding production boundary", () => {
  it("preserves the exact legacy mutation result when no runtime is supplied", () => {
    const proposed = { ...warnFinding, severity: "INFO" as const, low_confidence: true };

    const applied = transitionFinding({
      passId: "judgment.confidence",
      finding: warnFinding,
      opportunity: true,
      matched: true,
      reasonCode: "below-confidence-floor",
      action: "demoted",
      proposed: () => proposed,
    });
    const missed = transitionFinding({
      passId: "judgment.confidence",
      finding: warnFinding,
      opportunity: true,
      matched: false,
      reasonCode: "below-confidence-floor",
      action: "demoted",
      proposed: () => {
        throw new Error("a missed proposal must stay lazy");
      },
    });
    const protectedFinding = transitionFinding({
      passId: "judgment.confidence",
      finding: warnFinding,
      opportunity: true,
      matched: true,
      reasonCode: "below-confidence-floor",
      action: "demoted",
      protectedBy: "high-precision-reviewer",
      proposed: () => {
        throw new Error("a protected proposal must stay lazy");
      },
    });

    expect(applied).toBe(proposed);
    expect(missed).toBe(warnFinding);
    expect(protectedFinding).toBe(warnFinding);
  });

  it("keeps opportunity, predicate, and proposal failures outside telemetry isolation", () => {
    const opportunityError = new Error("opportunity failed");
    const predicateError = new Error("predicate failed");
    const proposalError = new Error("proposal failed");
    const runtime = PolicyTraceRecorder.start({ runId: "run-errors", iter: 1, ablated: [] });
    const base = {
      runtime,
      passId: "judgment.confidence",
      finding: warnFinding,
      opportunity: true,
      matched: true,
      reasonCode: "below-confidence-floor",
      action: "demoted",
      proposed: () => ({ ...warnFinding, severity: "INFO" as const }),
    } satisfies TransitionInput;
    const opportunityInput = { ...base } as TransitionInput;
    const predicateInput = { ...base } as TransitionInput;
    Object.defineProperty(opportunityInput, "opportunity", {
      get: () => {
        throw opportunityError;
      },
    });
    Object.defineProperty(predicateInput, "matched", {
      get: () => {
        throw predicateError;
      },
    });

    expect(() => transitionFinding(opportunityInput)).toThrow(opportunityError);
    expect(() => transitionFinding(predicateInput)).toThrow(predicateError);
    expect(() =>
      transitionFinding({
        ...base,
        proposed: () => {
          throw proposalError;
        },
      }),
    ).toThrow(proposalError);
    expect(runtime.telemetryError).toBe(false);
  });

  it("never lets an inconsistent telemetry opportunity suppress a matched production result", () => {
    const runtime = PolicyTraceRecorder.start({
      runId: "run-inconsistent-opportunity",
      iter: 1,
      ablated: [],
    });
    const proposed = { ...warnFinding, severity: "INFO" as const, low_confidence: true };

    const after = transitionFinding({
      runtime,
      passId: "judgment.confidence",
      finding: warnFinding,
      opportunity: false,
      matched: true,
      reasonCode: "below-confidence-floor",
      action: "demoted",
      proposed: () => proposed,
    });

    expect(after).toBe(proposed);
    expect(runtime.telemetryError).toBe(true);
  });
});

describe("PolicyTraceRecorder terminal evaluations", () => {
  it("records no-opportunity without evaluating the proposal", () => {
    const runtime = PolicyTraceRecorder.start({
      runId: "run-no-opportunity",
      iter: 1,
      ablated: [],
    });

    const after = transitionFinding({
      runtime,
      passId: "judgment.confidence",
      finding: warnFinding,
      opportunity: false,
      matched: false,
      reasonCode: "below-confidence-floor",
      action: "demoted",
      proposed: () => {
        throw new Error("no-opportunity must not propose");
      },
    });

    expect(after).toBe(warnFinding);
    expect(runtime.summary("judgment.confidence")).toEqual({
      pass_id: "judgment.confidence",
      status: "ran",
      considered: 1,
      opportunities: 0,
      would_apply: 0,
      applied: 0,
      protected: 0,
      blocking_removed: 0,
      blocking_preserved: 0,
      dropped: 0,
    });
    expect(runtime.evaluations()).toEqual([
      {
        pass_id: "judgment.confidence",
        order: 140,
        result: "no-opportunity",
        before: "WARN",
        after: "WARN",
        reason_code: "ineligible-starting-state",
        source_signatures: ["sig-confidence"],
      },
    ]);
  });

  it("increments opportunity for an eligible predicate miss", () => {
    const runtime = PolicyTraceRecorder.start({ runId: "run-no-match", iter: 1, ablated: [] });

    const after = transitionFinding({
      runtime,
      passId: "judgment.confidence",
      finding: warnFinding,
      opportunity: true,
      matched: false,
      reasonCode: "below-confidence-floor",
      action: "demoted",
      proposed: () => {
        throw new Error("no-match must not propose");
      },
    });

    expect(after).toBe(warnFinding);
    expect(runtime.summary("judgment.confidence")).toMatchObject({
      considered: 1,
      opportunities: 1,
      would_apply: 0,
      applied: 0,
    });
    expect(runtime.evaluations()[0]?.result).toBe("no-match");
    expect(runtime.evaluations()[0]?.reason_code).toBe("predicate-miss");
  });

  it("records an applied transition and exact blocking counters", () => {
    const runtime = PolicyTraceRecorder.start({ runId: "run-applied", iter: 1, ablated: [] });
    const proposed = { ...warnFinding, severity: "INFO" as const, low_confidence: true };

    const after = transitionFinding({
      runtime,
      passId: "judgment.confidence",
      finding: warnFinding,
      opportunity: true,
      matched: true,
      reasonCode: "below-confidence-floor",
      action: "demoted",
      proposed: () => proposed,
    });

    expect(stripPolicyEffects(after)).toEqual(proposed);
    expect(after?.policy_effects).toEqual([
      {
        pass_id: "judgment.confidence",
        order: 140,
        action: "demoted",
        before: "WARN",
        after: "INFO",
        reason_code: "below-confidence-floor",
        source_signatures: ["sig-confidence"],
      },
    ]);
    expect(runtime.summary("judgment.confidence")).toEqual({
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
    });
  });

  it("records a protected material effect while preserving production fields", () => {
    const runtime = PolicyTraceRecorder.start({ runId: "run-protected", iter: 1, ablated: [] });

    const after = transitionFinding({
      runtime,
      passId: "judgment.confidence",
      finding: warnFinding,
      opportunity: true,
      matched: true,
      reasonCode: "below-confidence-floor",
      action: "demoted",
      protectedBy: "high-precision-reviewer",
      proposed: () => {
        throw new Error("protected transition must not propose");
      },
    });

    expect(stripPolicyEffects(after)).toEqual(warnFinding);
    expect(after?.policy_effects).toEqual([
      {
        pass_id: "judgment.confidence",
        order: 140,
        action: "protected",
        before: "WARN",
        after: "WARN",
        reason_code: "below-confidence-floor",
        protected_by: "high-precision-reviewer",
        source_signatures: ["sig-confidence"],
      },
    ]);
    expect(runtime.summary("judgment.confidence")).toMatchObject({
      considered: 1,
      opportunities: 1,
      would_apply: 1,
      applied: 0,
      protected: 1,
      blocking_removed: 0,
      blocking_preserved: 1,
    });
  });

  it("keeps an explicitly ablated match unchanged and records would-apply", () => {
    const runtime = PolicyTraceRecorder.start({
      runId: "run-ablated",
      iter: 1,
      ablated: ["judgment.confidence"],
    });
    let proposedCalls = 0;

    const after = transitionFinding({
      runtime,
      passId: "judgment.confidence",
      finding: warnFinding,
      opportunity: true,
      matched: true,
      reasonCode: "below-confidence-floor",
      action: "demoted",
      proposed: () => {
        proposedCalls += 1;
        return { ...warnFinding, severity: "INFO", low_confidence: true };
      },
    });

    expect(after).toBe(warnFinding);
    expect(proposedCalls).toBe(1);
    expect(after?.policy_effects).toBeUndefined();
    expect(runtime.evaluations()[0]?.result).toBe("would-apply");
    expect(runtime.summary("judgment.confidence")).toEqual({
      pass_id: "judgment.confidence",
      status: "ran",
      considered: 1,
      opportunities: 1,
      would_apply: 1,
      applied: 0,
      protected: 0,
      blocking_removed: 0,
      blocking_preserved: 1,
      dropped: 0,
    });
  });

  it("records an applied drop without retaining a visible effect", () => {
    const runtime = PolicyTraceRecorder.start({ runId: "run-drop", iter: 1, ablated: [] });

    const after = transitionFinding({
      runtime,
      passId: "judgment.critic",
      finding: infoFinding,
      opportunity: true,
      matched: true,
      reasonCode: "critic-likely-fp",
      action: "dropped",
      proposed: () => null,
    });

    expect(after).toBeNull();
    expect(runtime.evaluations()[0]).toMatchObject({
      result: "applied",
      before: "INFO",
      after: null,
    });
    expect(runtime.summary("judgment.critic")).toMatchObject({
      considered: 1,
      opportunities: 1,
      would_apply: 1,
      applied: 1,
      blocking_removed: 0,
      blocking_preserved: 0,
      dropped: 1,
    });
  });

  it("records an applied re-anchor as blocking-preserving", () => {
    const runtime = PolicyTraceRecorder.start({ runId: "run-reanchor", iter: 1, ablated: [] });
    const proposed = {
      ...warnFinding,
      line_start: 8,
      line_end: 8,
      anchor_repaired: true,
    } satisfies Finding;

    const after = transitionFinding({
      runtime,
      passId: "evidence.fact-location",
      finding: warnFinding,
      opportunity: true,
      matched: true,
      reasonCode: "evidence-line-reanchored",
      action: "reanchored",
      proposed: () => proposed,
    });

    expect(stripPolicyEffects(after)).toEqual(proposed);
    expect(after?.policy_effects?.[0]?.action).toBe("reanchored");
    expect(runtime.summary("evidence.fact-location")).toMatchObject({
      applied: 1,
      blocking_removed: 0,
      blocking_preserved: 1,
    });
  });
});

describe("PolicyTraceRecorder fail-open telemetry", () => {
  it("returns the exact proposed result when recorder or effect attachment fails", () => {
    const runtime = PolicyTraceRecorder.start({
      runId: "run-recorder-error",
      iter: 1,
      ablated: [],
    });
    const proposed = { ...warnFinding, reviewer: { ...warnFinding.reviewer } };

    const after = transitionFinding({
      runtime,
      passId: "judgment.confidence",
      finding: warnFinding,
      opportunity: true,
      matched: true,
      reasonCode: "below-confidence-floor",
      action: "demoted",
      proposed: () => proposed,
    });

    expect(after).toBe(proposed);
    expect(after?.policy_effects).toBeUndefined();
    expect(runtime.telemetryError).toBe(true);
  });

  it("preserves a null production drop when telemetry recording fails", () => {
    const runtime = PolicyTraceRecorder.start({ runId: "run-drop-error", iter: 1, ablated: [] });

    const after = transitionFinding({
      runtime,
      passId: "judgment.critic",
      finding: infoFinding,
      opportunity: true,
      matched: true,
      reasonCode: "critic-likely-fp",
      action: "dropped",
      sourceSignatures: [],
      proposed: () => null,
    });

    expect(after).toBeNull();
    expect(runtime.telemetryError).toBe(true);
  });
});

describe("PolicyTraceRecorder pass lifecycle", () => {
  it("records an inactive pass without counters or evaluations and finalizes a valid mixed trace", () => {
    const runtime = PolicyTraceRecorder.start({ runId: "run-inactive", iter: 1, ablated: [] });
    runtime.markInactive("judgment.confidence", "configured-off");
    runtime.recordStage({
      stageId: "aggregation.cluster",
      reasonCode: "singleton",
      memberCount: 1,
      inputSignatures: [warnFinding.signature],
      outputSignature: warnFinding.signature,
    });
    runtime.linkFinal([warnFinding.signature], warnFinding.signature);
    runtime.recordStage({
      stageId: "verdict.compute",
      reasonCode: "blocking-present",
      inputSignatures: [warnFinding.signature],
      verdict: "SOFT-PASS",
    });

    const trace = runtime.finalize({
      rawResponseSha256: [],
      verdict: "SOFT-PASS",
      finalFindings: [warnFinding],
    });

    expect(runtime.telemetryError).toBe(false);
    expect(runtime.summary("judgment.confidence")).toEqual({
      pass_id: "judgment.confidence",
      status: "not-run",
      reason_code: "configured-off",
    });
    expect(runtime.evaluations()).toEqual([]);
    expect(trace?.passes.find((pass) => pass.pass_id === "judgment.confidence")).toEqual({
      pass_id: "judgment.confidence",
      status: "not-run",
      reason_code: "configured-off",
    });
  });

  it("isolates ran-versus-inactive conflicts without changing production transition semantics", () => {
    const evaluated = PolicyTraceRecorder.start({
      runId: "run-inactive-after-evaluation",
      iter: 1,
      ablated: [],
    });
    transitionFinding({
      runtime: evaluated,
      passId: "judgment.confidence",
      finding: warnFinding,
      opportunity: true,
      matched: false,
      reasonCode: "below-confidence-floor",
      action: "demoted",
      proposed: () => {
        throw new Error("predicate miss must stay lazy");
      },
    });
    evaluated.markInactive("judgment.confidence", "configured-off");

    expect(evaluated.telemetryError).toBe(true);
    expect(evaluated.summary("judgment.confidence")).toMatchObject({
      status: "ran",
      considered: 1,
    });
    expect(
      evaluated.finalize({ rawResponseSha256: [], verdict: "PASS", finalFindings: [] }),
    ).toBeNull();

    const inactive = PolicyTraceRecorder.start({
      runId: "run-evaluation-after-inactive",
      iter: 1,
      ablated: [],
    });
    inactive.markInactive("judgment.confidence", "configured-off");
    const proposed = { ...warnFinding, severity: "INFO" as const, low_confidence: true };
    const after = transitionFinding({
      runtime: inactive,
      passId: "judgment.confidence",
      finding: warnFinding,
      opportunity: true,
      matched: true,
      reasonCode: "below-confidence-floor",
      action: "demoted",
      proposed: () => proposed,
    });

    expect(after).toBe(proposed);
    expect(inactive.telemetryError).toBe(true);
    expect(inactive.summary("judgment.confidence")).toEqual({
      pass_id: "judgment.confidence",
      status: "not-run",
      reason_code: "configured-off",
    });
    expect(inactive.evaluations()).toEqual([]);
  });

  it("exposes only internal ablation membership to pass-owned marker branches", () => {
    const runtime = PolicyTraceRecorder.start({
      runId: "run-ablation-membership",
      iter: 1,
      ablated: ["judgment.confidence"],
    });

    expect(runtime.isAblated("judgment.confidence")).toBe(true);
  });

  it("lets ablation outrank protection without attaching a render-visible effect", () => {
    const runtime = PolicyTraceRecorder.start({
      runId: "run-ablated-protection",
      iter: 1,
      ablated: ["judgment.confidence"],
    });

    const after = transitionFinding({
      runtime,
      passId: "judgment.confidence",
      finding: warnFinding,
      opportunity: true,
      matched: true,
      reasonCode: "below-confidence-floor",
      action: "demoted",
      protectedBy: "high-precision-reviewer",
      proposed: () => {
        throw new Error("an ablated protected proposal must stay lazy");
      },
    });

    expect(after).toBe(warnFinding);
    expect(after?.policy_effects).toBeUndefined();
    expect(runtime.evaluations()).toEqual([
      {
        pass_id: "judgment.confidence",
        order: 140,
        result: "would-apply",
        before: "WARN",
        after: "WARN",
        reason_code: "below-confidence-floor",
        source_signatures: ["sig-confidence"],
      },
    ]);
    expect(runtime.summary("judgment.confidence")).toMatchObject({
      would_apply: 1,
      applied: 0,
      protected: 0,
      blocking_preserved: 1,
    });
  });
});

describe("policy effect merging", () => {
  it("deduplicates identical effects and restores ascending catalog order", () => {
    const earlier = {
      pass_id: "evidence.fact-location",
      order: 10,
      action: "reanchored",
      before: "WARN",
      after: "WARN",
      reason_code: "evidence-line-reanchored",
      source_signatures: ["sig-confidence"],
    } satisfies PolicyEffect;
    const later = {
      pass_id: "judgment.confidence",
      order: 140,
      action: "demoted",
      before: "WARN",
      after: "INFO",
      reason_code: "below-confidence-floor",
      source_signatures: ["sig-confidence"],
    } satisfies PolicyEffect;

    expect(mergePolicyEffects([later], [earlier, later], undefined)).toEqual([earlier, later]);
  });
});

describe("PolicyTraceRecorder finalization", () => {
  it("records contributor cardinality separately from unique cluster lineage", () => {
    const runtime = PolicyTraceRecorder.start({ runId: "run-member-count", iter: 1, ablated: [] });
    const finalWarn = { ...warnFinding, signature: "sig-shared" } satisfies Finding;

    runtime.recordStage({
      stageId: "aggregation.cluster",
      reasonCode: "clustered",
      memberCount: 2,
      inputSignatures: ["sig-shared"],
      outputSignature: "sig-shared",
    });
    runtime.linkFinal(["sig-shared"], "sig-shared");
    runtime.recordStage({
      stageId: "verdict.compute",
      reasonCode: "blocking-present",
      inputSignatures: ["sig-shared"],
      verdict: "SOFT-PASS",
    });

    const trace = runtime.finalize({
      rawResponseSha256: [],
      verdict: "SOFT-PASS",
      finalFindings: [finalWarn],
    });

    expect(runtime.telemetryError).toBe(false);
    expect(trace?.stages[0]).toEqual({
      stage_id: "aggregation.cluster",
      order: 65,
      reason_code: "clustered",
      member_count: 2,
      input_signatures: ["sig-shared"],
      output_signature: "sig-shared",
    });
  });

  it("links cluster lineage and derives ordered final severity evidence", () => {
    const runtime = PolicyTraceRecorder.start({ runId: "run-final", iter: 2, ablated: [] });
    const finalWarn = {
      ...warnFinding,
      id: "F-010",
      signature: "sig-z-final",
    } satisfies Finding;
    const finalInfo = {
      ...infoFinding,
      id: "F-011",
      signature: "sig-a-final",
    } satisfies Finding;

    transitionFinding({
      runtime,
      passId: "judgment.confidence",
      finding: { ...warnFinding, signature: "sig-member" },
      opportunity: true,
      matched: false,
      reasonCode: "below-confidence-floor",
      action: "demoted",
      sourceSignatures: ["sig-member"],
      proposed: () => {
        throw new Error("predicate miss must stay lazy");
      },
    });
    runtime.recordStage({
      stageId: "aggregation.cluster",
      reasonCode: "clustered",
      memberCount: 2,
      inputSignatures: ["sig-z-final", "sig-member"],
      outputSignature: "sig-z-final",
    });
    runtime.recordStage({
      stageId: "aggregation.cluster",
      reasonCode: "singleton",
      memberCount: 1,
      inputSignatures: ["sig-a-final"],
      outputSignature: "sig-a-final",
    });
    runtime.linkFinal(["sig-member", "sig-z-final"], "sig-z-final");
    runtime.linkFinal(["sig-a-final"], "sig-a-final");
    runtime.recordStage({
      stageId: "verdict.compute",
      reasonCode: "blocking-present",
      inputSignatures: ["sig-z-final"],
      verdict: "SOFT-PASS",
    });

    const trace = runtime.finalize({
      rawResponseSha256: ["a".repeat(64)],
      verdict: "SOFT-PASS",
      finalFindings: [finalWarn, finalInfo],
    });

    expect(trace?.evaluations[0]?.final_signature).toBe("sig-z-final");
    expect(trace?.stages.map((stage) => [stage.order, stage.stage_id])).toEqual([
      [65, "aggregation.cluster"],
      [65, "aggregation.cluster"],
      [190, "verdict.compute"],
    ]);
    expect(trace?.final).toEqual({
      verdict: "SOFT-PASS",
      counts: { critical: 0, warn: 1, info: 1 },
      finding_signatures: ["sig-z-final", "sig-a-final"],
      finding_severities: [
        { signature: "sig-z-final", severity: "WARN" },
        { signature: "sig-a-final", severity: "INFO" },
      ],
    });
  });
});
