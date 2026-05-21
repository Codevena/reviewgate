// tests/unit/report-status-detail.test.ts
// TDD: written BEFORE schema/orchestrator changes — must fail first.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportWriter } from "../../src/core/report-writer.ts";
import { type PendingReport, PendingReportSchema } from "../../src/schemas/pending-report.ts";

const baseReportWithError: PendingReport = {
  schema: "reviewgate.pending.v1",
  run_id: "r-err-1",
  iter: 1,
  max_iter: 3,
  verdict: "FAIL",
  counts: { critical: 0, warn: 0, info: 0 },
  reviewers: [
    {
      id: "codex",
      provider: "codex",
      model: "gpt-5.4",
      persona: "security",
      status: "error",
      cost_usd: 0,
      duration_ms: 5432,
      status_detail: "codex exit=1: quota exhausted",
    },
  ],
  findings: [],
  cost_usd_total: 0,
  duration_ms_total: 5432,
  generated_at: "2026-05-21T00:00:00Z",
  git: { sha: "deadbeef", branch: "fix/review-context-reliability", dirty_files: [] },
};

describe("status_detail in PendingReport", () => {
  it("schema accepts a reviewer entry WITH status_detail", () => {
    expect(() => PendingReportSchema.parse(baseReportWithError)).not.toThrow();
  });

  it("schema accepts a reviewer entry WITHOUT status_detail (backward-compat)", () => {
    const report = {
      ...baseReportWithError,
      reviewers: [
        {
          id: "codex",
          provider: "codex",
          model: "gpt-5.4",
          persona: "security",
          status: "ok" as const,
          cost_usd: 0,
          duration_ms: 1234,
          // No status_detail field — must still parse fine
        },
      ],
    };
    expect(() => PendingReportSchema.parse(report)).not.toThrow();
  });

  it("ReportWriter writes status_detail to pending.json and it round-trips correctly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-status-detail-"));
    const w = new ReportWriter(dir);
    await w.write(baseReportWithError);
    const json = JSON.parse(readFileSync(join(dir, ".reviewgate", "pending.json"), "utf8"));
    expect(json.reviewers[0].status_detail).toBe("codex exit=1: quota exhausted");
  });

  it("ReportWriter omits status_detail key when not set (exactOptionalPropertyTypes-safe)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-status-detail-absent-"));
    const w = new ReportWriter(dir);
    const reportWithoutDetail: PendingReport = {
      ...baseReportWithError,
      reviewers: [
        {
          id: "codex",
          provider: "codex",
          model: "gpt-5.4",
          persona: "security",
          status: "ok",
          cost_usd: 0,
          duration_ms: 999,
        },
      ],
    };
    await w.write(reportWithoutDetail);
    const json = JSON.parse(readFileSync(join(dir, ".reviewgate", "pending.json"), "utf8"));
    // Key must be absent (not set to undefined) — exactOptionalPropertyTypes compliance
    expect(Object.hasOwn(json.reviewers[0], "status_detail")).toBe(false);
  });
});
