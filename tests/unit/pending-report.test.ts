import { describe, expect, it } from "bun:test";
import { type PendingReport, PendingReportSchema } from "../../src/schemas/pending-report.ts";

const baseFinding = {
  id: "F-001",
  signature: "sig1",
  severity: "WARN" as const,
  category: "security" as const,
  rule_id: "r",
  file: "a.ts",
  line_start: 1,
  line_end: 1,
  message: "m",
  details: "d",
  reviewer: { provider: "codex", model: "x", persona: "security" },
  confidence: 0.8,
  consensus: "singleton" as const,
};

const policyPassIds = [
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

const policyPasses = policyPassIds.map((pass_id) => ({
  pass_id,
  status: "ran" as const,
  considered: 0,
  opportunities: 0,
  would_apply: 0,
  applied: 0,
  protected: 0,
  blocking_removed: 0,
  blocking_preserved: 0,
  dropped: 0,
}));

describe("PendingReportSchema", () => {
  it("accepts a minimal PASS report with no findings", () => {
    const r: PendingReport = {
      schema: "reviewgate.pending.v1",
      run_id: "01HXQ",
      iter: 1,
      max_iter: 3,
      verdict: "PASS",
      counts: { critical: 0, warn: 0, info: 0 },
      reviewers: [
        {
          id: "codex",
          provider: "codex",
          model: "gpt-5.5",
          persona: "security",
          status: "ok",
          cost_usd: 0,
          duration_ms: 1234,
        },
      ],
      findings: [],
      cost_usd_total: 0,
      duration_ms_total: 1234,
      generated_at: "2026-05-20T14:32:11Z",
      git: { sha: "abc", branch: "main", dirty_files: [] },
    };
    expect(() => PendingReportSchema.parse(r)).not.toThrow();
  });

  it("accepts an optional top-level whole_diff_attributable and defaults to absent (S2)", () => {
    const base = {
      schema: "reviewgate.pending.v1" as const,
      run_id: "x",
      iter: 1,
      max_iter: 3,
      verdict: "PASS" as const,
      counts: { critical: 0, warn: 0, info: 0 },
      reviewers: [],
      findings: [],
      cost_usd_total: 0,
      duration_ms_total: 0,
      generated_at: "x",
      git: { sha: "x", branch: "x", dirty_files: [] },
    };
    expect(
      PendingReportSchema.parse({ ...base, whole_diff_attributable: false })
        .whole_diff_attributable,
    ).toBe(false);
    expect(
      PendingReportSchema.parse({ ...base, whole_diff_attributable: true }).whole_diff_attributable,
    ).toBe(true);
    expect(PendingReportSchema.parse(base).whole_diff_attributable).toBeUndefined();
  });

  it("rejects verdict outside the allowed set", () => {
    expect(() =>
      PendingReportSchema.parse({
        schema: "reviewgate.pending.v1",
        run_id: "x",
        iter: 1,
        max_iter: 3,
        verdict: "MAYBE",
        counts: { critical: 0, warn: 0, info: 0 },
        reviewers: [],
        findings: [],
        cost_usd_total: 0,
        duration_ms_total: 0,
        generated_at: "x",
        git: { sha: "x", branch: "x", dirty_files: [] },
      }),
    ).toThrow();
  });

  it("accepts SOFT-PASS verdict with WARN findings", () => {
    const r = {
      schema: "reviewgate.pending.v1" as const,
      run_id: "x",
      iter: 1,
      max_iter: 3,
      verdict: "SOFT-PASS" as const,
      counts: { critical: 0, warn: 1, info: 0 },
      reviewers: [
        {
          id: "codex",
          provider: "codex",
          model: "gpt-5.5",
          persona: "security",
          status: "ok" as const,
          cost_usd: 0,
          duration_ms: 1,
        },
      ],
      findings: [baseFinding],
      cost_usd_total: 0,
      duration_ms_total: 1,
      generated_at: "x",
      git: { sha: "x", branch: "x", dirty_files: [] },
    };
    expect(() => PendingReportSchema.parse(r)).not.toThrow();
  });

  it("accepts an optional complete policy summary without changing the outer literal", () => {
    const report = {
      schema: "reviewgate.pending.v1" as const,
      run_id: "x",
      iter: 1,
      max_iter: 3,
      verdict: "PASS" as const,
      counts: { critical: 0, warn: 0, info: 0 },
      reviewers: [],
      findings: [],
      policy_summary: {
        catalog_version: "reviewgate.policy-catalog.v1" as const,
        status: "complete" as const,
        passes: policyPasses,
        policy_trace_ref: "audit/2026/08/10/policy/trace.json",
        policy_trace_sha256: "a".repeat(64),
      },
      cost_usd_total: 0,
      duration_ms_total: 0,
      generated_at: "x",
      git: { sha: "x", branch: "x", dirty_files: [] },
    };
    const parsed = PendingReportSchema.parse(report);
    expect(parsed.schema).toBe("reviewgate.pending.v1");
    expect(parsed.policy_summary?.status).toBe("complete");
  });

  it("rejects inconsistent complete/ref/hash policy summary states", () => {
    const base = {
      schema: "reviewgate.pending.v1" as const,
      run_id: "x",
      iter: 1,
      max_iter: 3,
      verdict: "PASS" as const,
      counts: { critical: 0, warn: 0, info: 0 },
      reviewers: [],
      findings: [],
      cost_usd_total: 0,
      duration_ms_total: 0,
      generated_at: "x",
      git: { sha: "x", branch: "x", dirty_files: [] },
    };
    expect(
      PendingReportSchema.safeParse({
        ...base,
        policy_summary: {
          catalog_version: "reviewgate.policy-catalog.v1",
          status: "complete",
          passes: policyPasses,
        },
      }).success,
    ).toBe(false);
    expect(
      PendingReportSchema.safeParse({
        ...base,
        policy_summary: {
          catalog_version: "reviewgate.policy-catalog.v1",
          status: "overflow",
          passes: policyPasses,
          policy_trace_ref: "trace.json",
          policy_trace_sha256: "b".repeat(64),
        },
      }).success,
    ).toBe(false);
  });
});
