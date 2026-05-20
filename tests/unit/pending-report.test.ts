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
          model: "gpt-5.4",
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
          model: "gpt-5.4",
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
});
