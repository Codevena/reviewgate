import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFindingFacts } from "../../src/core/fact-check.ts";
import {
  type GroundingVerdict,
  applyGroundingJudgeVerdicts,
  groundFindings,
} from "../../src/core/grounding.ts";
import { demoteHypotheticalCriticals } from "../../src/core/hypothetical-demote.ts";
import type {
  PolicyPassId,
  PolicyProtectionCode,
  PolicyReasonCode,
} from "../../src/core/policy/catalog.ts";
import { type PolicyRuntime, PolicyTraceRecorder } from "../../src/core/policy/trace.ts";
import { demoteSelfRefuting } from "../../src/core/self-refutation.ts";
import type { Finding } from "../../src/schemas/finding.ts";

type NumericSummary = readonly [number, number, number, number, number, number, number, number];

const createdDirs: string[] = [];

afterAll(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

function mkFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    signature: "sig-policy",
    severity: "WARN",
    category: "quality",
    rule_id: "policy-contract",
    file: "src/x.ts",
    line_start: 1,
    line_end: 1,
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

function stripPolicyEffects(finding: Finding | undefined): Finding | undefined {
  if (finding === undefined) return undefined;
  const { policy_effects: _policyEffects, ...legacy } = finding;
  return legacy as Finding;
}

function numericSummary(recorder: PolicyRuntime, passId: PolicyPassId): NumericSummary {
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
  finding: Finding | undefined,
  expected: {
    pass_id: PolicyPassId;
    order: number;
    action: "demoted" | "protected" | "reanchored";
    before: Finding["severity"];
    after: Finding["severity"];
    reason_code: PolicyReasonCode;
    protected_by?: PolicyProtectionCode;
  },
): void {
  if (finding === undefined) throw new Error("expected one finding");
  expect(finding?.policy_effects).toEqual([
    {
      ...expected,
      source_signatures: [finding.signature],
    },
  ]);
}

function factRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "reviewgate-policy-preaggregation-"));
  createdDirs.push(dir);
  writeFileSync(join(dir, "one-line.ts"), "const present = true;\n");
  return dir;
}

describe("pre-aggregation policy numeric contracts", () => {
  it("records fact-location no-opportunity and predicate-miss rows", () => {
    const dir = factRepo();
    const absentRuntime = runtime("fact-absent");
    const validRuntime = runtime("fact-valid");

    validateFindingFacts(
      [mkFinding({ file: "absent.ts", line_start: 9, line_end: 9 })],
      dir,
      new Set(),
      absentRuntime,
    );
    validateFindingFacts(
      [mkFinding({ file: "one-line.ts", line_start: 1, line_end: 1 })],
      dir,
      new Set(),
      validRuntime,
    );

    expect(numericSummary(absentRuntime, "evidence.fact-location")).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(numericSummary(validRuntime, "evidence.fact-location")).toEqual([
      1, 1, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("records fact-location active, ablated, and re-anchor actions without legacy drift", () => {
    const dir = factRepo();
    const finding = mkFinding({
      signature: "sig-fact-demote",
      file: "one-line.ts",
      line_start: 9,
      line_end: 9,
    });
    const activeRuntime = runtime("fact-active");
    const ablatedRuntime = runtime("fact-ablated", ["evidence.fact-location"]);

    const legacy = validateFindingFacts([finding], dir, new Set());
    const active = validateFindingFacts([finding], dir, new Set(), activeRuntime);
    const ablated = validateFindingFacts([finding], dir, new Set(), ablatedRuntime);

    expect(stripPolicyEffects(active[0])).toEqual(legacy[0]);
    expect(active[0]).toMatchObject({ severity: "INFO", fact_invalid: true });
    expect(ablated[0]).toEqual(finding);
    expect(numericSummary(activeRuntime, "evidence.fact-location")).toEqual([
      1, 1, 1, 1, 0, 1, 0, 0,
    ]);
    expect(numericSummary(ablatedRuntime, "evidence.fact-location")).toEqual([
      1, 1, 1, 0, 0, 0, 1, 0,
    ]);
    expectEffect(active[0], {
      pass_id: "evidence.fact-location",
      order: 10,
      action: "demoted",
      before: "WARN",
      after: "INFO",
      reason_code: "location-out-of-range",
    });

    const reanchorFinding = mkFinding({
      signature: "sig-fact-reanchor",
      severity: "CRITICAL",
      file: "one-line.ts",
      line_start: 99,
      line_end: 99,
      evidence_line: "const present = true;",
    });
    const reanchorRuntime = runtime("fact-reanchor");
    const reanchored = validateFindingFacts([reanchorFinding], dir, new Set(), reanchorRuntime);

    expect(reanchored[0]).toMatchObject({
      severity: "CRITICAL",
      line_start: 1,
      line_end: 1,
      anchor_repaired: true,
    });
    expect(numericSummary(reanchorRuntime, "evidence.fact-location")).toEqual([
      1, 1, 1, 1, 0, 0, 1, 0,
    ]);
    expectEffect(reanchored[0], {
      pass_id: "evidence.fact-location",
      order: 10,
      action: "reanchored",
      before: "CRITICAL",
      after: "CRITICAL",
      reason_code: "evidence-line-reanchored",
    });
  });

  it("records an INFO fact-invalid mutation without invalidating trace or ablation", () => {
    const dir = factRepo();
    const finding = mkFinding({
      signature: "sig-fact-info",
      severity: "INFO",
      file: "one-line.ts",
      line_start: 9,
      line_end: 9,
    });
    const activeRuntime = runtime("fact-info-active");
    const ablatedRuntime = runtime("fact-info-ablated", ["evidence.fact-location"]);

    const legacy = validateFindingFacts([finding], dir, new Set());
    const active = validateFindingFacts([finding], dir, new Set(), activeRuntime);
    const ablated = validateFindingFacts([finding], dir, new Set(), ablatedRuntime);

    expect(stripPolicyEffects(active[0])).toEqual(legacy[0]);
    expect(active[0]).toMatchObject({ severity: "INFO", fact_invalid: true });
    expect(activeRuntime.telemetryError).toBe(false);
    expect(numericSummary(activeRuntime, "evidence.fact-location")).toEqual([
      1, 1, 1, 1, 0, 0, 0, 0,
    ]);
    expect(activeRuntime.evaluations()).toEqual([
      {
        pass_id: "evidence.fact-location",
        order: 10,
        result: "applied",
        before: "INFO",
        after: "INFO",
        reason_code: "location-out-of-range",
        source_signatures: ["sig-fact-info"],
      },
    ]);
    expectEffect(active[0], {
      pass_id: "evidence.fact-location",
      order: 10,
      action: "demoted",
      before: "INFO",
      after: "INFO",
      reason_code: "location-out-of-range",
    });

    expect(ablated[0]).toEqual(finding);
    expect(ablatedRuntime.telemetryError).toBe(false);
    expect(numericSummary(ablatedRuntime, "evidence.fact-location")).toEqual([
      1, 1, 1, 0, 0, 0, 0, 0,
    ]);
    expect(ablatedRuntime.evaluations()).toEqual([
      {
        pass_id: "evidence.fact-location",
        order: 10,
        result: "would-apply",
        before: "INFO",
        after: "INFO",
        reason_code: "location-out-of-range",
        source_signatures: ["sig-fact-info"],
      },
    ]);
  });

  it("records self-refutation no-opportunity and predicate-miss rows", () => {
    const infoRuntime = runtime("self-info");
    const ordinaryRuntime = runtime("self-ordinary");

    demoteSelfRefuting([mkFinding({ severity: "INFO", details: "No issue." })], true, infoRuntime);
    demoteSelfRefuting([mkFinding({ severity: "WARN" })], true, ordinaryRuntime);

    expect(numericSummary(infoRuntime, "evidence.self-refutation")).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(numericSummary(ordinaryRuntime, "evidence.self-refutation")).toEqual([
      1, 1, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("records self-refutation active, ablated, and closed protections without legacy drift", () => {
    const finding = mkFinding({ signature: "sig-self", details: "Checked carefully. No issue." });
    const activeRuntime = runtime("self-active");
    const ablatedRuntime = runtime("self-ablated", ["evidence.self-refutation"]);

    const legacy = demoteSelfRefuting([finding]);
    const active = demoteSelfRefuting([finding], true, activeRuntime);
    const ablated = demoteSelfRefuting([finding], true, ablatedRuntime);

    expect(stripPolicyEffects(active[0])).toEqual(legacy[0]);
    expect(active[0]).toMatchObject({ severity: "INFO", self_refuted: true });
    expect(ablated[0]).toEqual(finding);
    expect(numericSummary(activeRuntime, "evidence.self-refutation")).toEqual([
      1, 1, 1, 1, 0, 1, 0, 0,
    ]);
    expect(numericSummary(ablatedRuntime, "evidence.self-refutation")).toEqual([
      1, 1, 1, 0, 0, 0, 1, 0,
    ]);
    expectEffect(active[0], {
      pass_id: "evidence.self-refutation",
      order: 20,
      action: "demoted",
      before: "WARN",
      after: "INFO",
      reason_code: "terminal-self-refutation",
    });

    for (const [protectedFinding, protectedBy] of [
      [
        mkFinding({
          signature: "sig-self-security",
          category: "correctness",
          details: "Checked carefully. No issue.",
        }),
        "security-correctness-floor",
      ],
      [
        mkFinding({
          signature: "sig-self-deterministic",
          deterministic: true,
          details: "Checked carefully. No issue.",
        }),
        "deterministic-ground-truth",
      ],
    ] as const) {
      const protectedRuntime = runtime(`self-${protectedBy}`);
      const protectedResult = demoteSelfRefuting([protectedFinding], true, protectedRuntime);
      expect(stripPolicyEffects(protectedResult[0])).toEqual(protectedFinding);
      expect(numericSummary(protectedRuntime, "evidence.self-refutation")).toEqual([
        1, 1, 1, 0, 1, 0, 1, 0,
      ]);
      expectEffect(protectedResult[0], {
        pass_id: "evidence.self-refutation",
        order: 20,
        action: "protected",
        before: "WARN",
        after: "WARN",
        reason_code: "terminal-self-refutation",
        protected_by: protectedBy,
      });
    }
  });

  it("records hypothetical no-opportunity and predicate-miss rows", () => {
    const warnRuntime = runtime("hypothetical-warn");
    const presentRuntime = runtime("hypothetical-present");

    demoteHypotheticalCriticals(
      [mkFinding({ severity: "WARN", details: "Currently safe; future change." })],
      true,
      warnRuntime,
    );
    demoteHypotheticalCriticals(
      [
        mkFinding({
          severity: "CRITICAL",
          details: "Currently safe in theory, but this already fails right now.",
        }),
      ],
      true,
      presentRuntime,
    );

    expect(numericSummary(warnRuntime, "judgment.hypothetical")).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(numericSummary(presentRuntime, "judgment.hypothetical")).toEqual([
      1, 1, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("records hypothetical active, ablated, and closed protections without legacy drift", () => {
    const finding = mkFinding({
      signature: "sig-hypothetical",
      severity: "CRITICAL",
      details: "This is currently safe, but a future change could break it.",
    });
    const activeRuntime = runtime("hypothetical-active");
    const ablatedRuntime = runtime("hypothetical-ablated", ["judgment.hypothetical"]);

    const legacy = demoteHypotheticalCriticals([finding]);
    const active = demoteHypotheticalCriticals([finding], true, activeRuntime);
    const ablated = demoteHypotheticalCriticals([finding], true, ablatedRuntime);

    expect(stripPolicyEffects(active[0])).toEqual(legacy[0]);
    expect(active[0]).toMatchObject({
      severity: "WARN",
      hypothetical_demoted: true,
      demoted_from_critical: true,
    });
    expect(ablated[0]).toEqual(finding);
    expect(numericSummary(activeRuntime, "judgment.hypothetical")).toEqual([
      1, 1, 1, 1, 0, 0, 1, 0,
    ]);
    expect(numericSummary(ablatedRuntime, "judgment.hypothetical")).toEqual([
      1, 1, 1, 0, 0, 0, 1, 0,
    ]);
    expectEffect(active[0], {
      pass_id: "judgment.hypothetical",
      order: 30,
      action: "demoted",
      before: "CRITICAL",
      after: "WARN",
      reason_code: "hypothetical-critical",
    });

    for (const [protectedFinding, protectedBy] of [
      [
        { ...finding, signature: "sig-hypothetical-security", category: "security" },
        "security-correctness-floor",
      ],
      [
        { ...finding, signature: "sig-hypothetical-deterministic", deterministic: true },
        "deterministic-ground-truth",
      ],
    ] as const) {
      const protectedRuntime = runtime(`hypothetical-${protectedBy}`);
      const protectedResult = demoteHypotheticalCriticals(
        [protectedFinding],
        true,
        protectedRuntime,
      );
      expect(stripPolicyEffects(protectedResult[0])).toEqual(protectedFinding);
      expect(numericSummary(protectedRuntime, "judgment.hypothetical")).toEqual([
        1, 1, 1, 0, 1, 0, 1, 0,
      ]);
      expectEffect(protectedResult[0], {
        pass_id: "judgment.hypothetical",
        order: 30,
        action: "protected",
        before: "CRITICAL",
        after: "CRITICAL",
        reason_code: "hypothetical-critical",
        protected_by: protectedBy,
      });
    }
  });

  it("records token grounding no-opportunity and predicate-miss rows", () => {
    const warnRuntime = runtime("token-warn");
    const presentRuntime = runtime("token-present");
    const corpus = ":root { --present-token: #fff; }";

    groundFindings(
      [mkFinding({ severity: "WARN", details: "Missing --absent-token." })],
      corpus,
      warnRuntime,
    );
    groundFindings(
      [mkFinding({ severity: "CRITICAL", details: "The --present-token is wrong." })],
      corpus,
      presentRuntime,
    );

    expect(numericSummary(warnRuntime, "evidence.grounding-token")).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(numericSummary(presentRuntime, "evidence.grounding-token")).toEqual([
      1, 1, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("records token grounding active, ablated, and protection rows without legacy drift", () => {
    const finding = mkFinding({
      signature: "sig-token",
      severity: "CRITICAL",
      details: "The --absent-token breaks the theme.",
    });
    const activeRuntime = runtime("token-active");
    const ablatedRuntime = runtime("token-ablated", ["evidence.grounding-token"]);

    const legacy = groundFindings([finding], "const present = true;");
    const active = groundFindings([finding], "const present = true;", activeRuntime);
    const ablated = groundFindings([finding], "const present = true;", ablatedRuntime);

    expect(stripPolicyEffects(active[0])).toEqual(legacy[0]);
    expect(active[0]).toMatchObject({
      severity: "WARN",
      grounding_demoted: true,
      demoted_from_critical: true,
    });
    expect(ablated[0]).toEqual(finding);
    expect(numericSummary(activeRuntime, "evidence.grounding-token")).toEqual([
      1, 1, 1, 1, 0, 0, 1, 0,
    ]);
    expect(numericSummary(ablatedRuntime, "evidence.grounding-token")).toEqual([
      1, 1, 1, 0, 0, 0, 1, 0,
    ]);
    expectEffect(active[0], {
      pass_id: "evidence.grounding-token",
      order: 40,
      action: "demoted",
      before: "CRITICAL",
      after: "WARN",
      reason_code: "cited-token-absent",
    });

    const protectedFinding = {
      ...finding,
      signature: "sig-token-security",
      category: "security" as const,
    };
    const protectedRuntime = runtime("token-protected");
    const protectedResult = groundFindings(
      [protectedFinding],
      "const present = true;",
      protectedRuntime,
    );
    expect(stripPolicyEffects(protectedResult[0])).toEqual(protectedFinding);
    expect(numericSummary(protectedRuntime, "evidence.grounding-token")).toEqual([
      1, 1, 1, 0, 1, 0, 1, 0,
    ]);
    expectEffect(protectedResult[0], {
      pass_id: "evidence.grounding-token",
      order: 40,
      action: "protected",
      before: "CRITICAL",
      after: "CRITICAL",
      reason_code: "cited-token-absent",
      protected_by: "security-correctness-floor",
    });
  });

  it("records LLM grounding no-opportunity and predicate-miss rows", () => {
    const absentRuntime = runtime("llm-absent");
    const groundedRuntime = runtime("llm-grounded");
    const finding = mkFinding({ severity: "CRITICAL" });

    applyGroundingJudgeVerdicts([finding], new Map(), absentRuntime);
    applyGroundingJudgeVerdicts(
      [finding],
      new Map<string, GroundingVerdict>([[finding.signature, { grounded: true }]]),
      groundedRuntime,
    );

    expect(numericSummary(absentRuntime, "judgment.grounding-llm")).toEqual([
      1, 0, 0, 0, 0, 0, 0, 0,
    ]);
    expect(numericSummary(groundedRuntime, "judgment.grounding-llm")).toEqual([
      1, 1, 0, 0, 0, 0, 0, 0,
    ]);
  });

  it("records LLM grounding active, ablated, and protection rows without legacy drift", () => {
    const finding = mkFinding({ signature: "sig-llm", severity: "CRITICAL" });
    const verdicts = new Map<string, GroundingVerdict>([
      [finding.signature, { grounded: false, reason: "not present" }],
    ]);
    const activeRuntime = runtime("llm-active");
    const ablatedRuntime = runtime("llm-ablated", ["judgment.grounding-llm"]);

    const legacy = applyGroundingJudgeVerdicts([finding], verdicts);
    const active = applyGroundingJudgeVerdicts([finding], verdicts, activeRuntime);
    const ablated = applyGroundingJudgeVerdicts([finding], verdicts, ablatedRuntime);

    expect(stripPolicyEffects(active[0])).toEqual(legacy[0]);
    expect(active[0]).toMatchObject({
      severity: "WARN",
      grounding_demoted: true,
      demoted_from_critical: true,
    });
    expect(ablated[0]).toEqual(finding);
    expect(numericSummary(activeRuntime, "judgment.grounding-llm")).toEqual([
      1, 1, 1, 1, 0, 0, 1, 0,
    ]);
    expect(numericSummary(ablatedRuntime, "judgment.grounding-llm")).toEqual([
      1, 1, 1, 0, 0, 0, 1, 0,
    ]);
    expectEffect(active[0], {
      pass_id: "judgment.grounding-llm",
      order: 50,
      action: "demoted",
      before: "CRITICAL",
      after: "WARN",
      reason_code: "judge-ungrounded",
    });

    const protectedFinding = {
      ...finding,
      signature: "sig-llm-correctness",
      category: "correctness" as const,
    };
    const protectedRuntime = runtime("llm-protected");
    const protectedResult = applyGroundingJudgeVerdicts(
      [protectedFinding],
      new Map([[protectedFinding.signature, { grounded: false }]]),
      protectedRuntime,
    );
    expect(stripPolicyEffects(protectedResult[0])).toEqual(protectedFinding);
    expect(numericSummary(protectedRuntime, "judgment.grounding-llm")).toEqual([
      1, 1, 1, 0, 1, 0, 1, 0,
    ]);
    expectEffect(protectedResult[0], {
      pass_id: "judgment.grounding-llm",
      order: 50,
      action: "protected",
      before: "CRITICAL",
      after: "CRITICAL",
      reason_code: "judge-ungrounded",
      protected_by: "security-correctness-floor",
    });
  });
});
