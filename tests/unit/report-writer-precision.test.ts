// tests/unit/report-writer-precision.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportWriter } from "../../src/core/report-writer.ts";
import type { PendingReport } from "../../src/schemas/pending-report.ts";

const report: PendingReport = {
  schema: "reviewgate.pending.v1",
  run_id: "r1",
  iter: 1,
  max_iter: 3,
  verdict: "FAIL",
  counts: { critical: 1, warn: 0, info: 0 },
  reviewers: [
    {
      id: "codex",
      provider: "codex",
      model: "m",
      persona: "security",
      status: "ok",
      cost_usd: 0,
      duration_ms: 1,
    },
  ],
  findings: [
    {
      id: "F-001",
      signature: "s",
      severity: "CRITICAL",
      category: "security",
      rule_id: "r",
      file: "a.ts",
      line_start: 1,
      line_end: 1,
      message: "m",
      details: "d",
      reviewer: { provider: "codex", model: "m", persona: "security" },
      confidence: 0.9,
      consensus: "singleton",
      reviewer_precision: [
        { provider: "codex", tp: 22, fp: 3, precision: 22 / 25 },
        { provider: "openrouter", tp: 7, fp: 10, precision: 7 / 17 },
      ],
    },
  ],
  cost_usd_total: 0,
  duration_ms_total: 1,
  generated_at: "2026-06-16T00:00:00Z",
  git: { sha: "abc1234", branch: "main", dirty_files: ["a.ts"] },
};

describe("report-writer renders reviewer_precision (#8)", () => {
  it("renders a Reviewer track record line with each provider's precision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-pp-rep-"));
    await new ReportWriter(dir).write(report);
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).toContain("Reviewer track record:");
    expect(md).toContain("codex 88% (22 TP / 3 FP)");
    expect(md).toContain("openrouter 41% (7 TP / 10 FP)");
  });

  it("omits the line when no finding carries reviewer_precision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-pp-rep2-"));
    const f0 = report.findings[0];
    if (!f0) throw new Error("fixture");
    const { reviewer_precision: _omit, ...noPrec } = f0;
    await new ReportWriter(dir).write({ ...report, findings: [noPrec] });
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).not.toContain("Reviewer track record:");
  });
});

describe("report-writer P1 low-precision advisory", () => {
  it("renders a loud advisory for a CRITICAL raised SOLELY by a low-precision reviewer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-pp-lo-"));
    const f0 = report.findings[0];
    if (!f0) throw new Error("fixture");
    const lowFinding = {
      ...f0,
      reviewer: { provider: "openrouter", model: "m", persona: "security" },
      reviewer_precision: [{ provider: "openrouter", tp: 8, fp: 12, precision: 0.4 }],
    };
    await new ReportWriter(dir).write({ ...report, findings: [lowFinding] });
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).toContain("low-precision reviewer");
    expect(md).toContain("openrouter 40%");
    expect(md).toContain("verify the cited code");
    // The finding is NOT demoted — it still renders as a gated CRITICAL.
    expect(md).toContain("CRITICAL");
  });

  it("does NOT add the advisory when a high-precision reviewer also raised it (corroboration)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-pp-hi-"));
    // the default fixture: codex 88% + openrouter 41% → corroborated → no advisory
    await new ReportWriter(dir).write(report);
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).not.toContain("low-precision reviewer");
  });
});
