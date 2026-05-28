import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportWriter } from "../../src/core/report-writer.ts";
import type { PendingReport } from "../../src/schemas/pending-report.ts";
import { planReviewMdPath } from "../../src/utils/paths.ts";

function report(): PendingReport {
  const f = (over: Record<string, unknown>) => ({
    id: "F-001",
    signature: "s",
    severity: "CRITICAL",
    category: "quality",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "x", persona: "security" },
    confidence: 0.5,
    consensus: "singleton",
    ...over,
  });
  return {
    schema: "reviewgate.pending.v1",
    run_id: "r",
    iter: 1,
    max_iter: 3,
    verdict: "FAIL",
    counts: { critical: 1, warn: 0, info: 1 },
    reviewers: [],
    findings: [
      f({ id: "F-001", severity: "CRITICAL" }),
      f({ id: "F-002", severity: "INFO", scope_demoted: true }),
    ],
    cost_usd_total: 0,
    duration_ms_total: 0,
    generated_at: "t",
    git: { sha: "0000000", branch: "main", dirty_files: [] },
  } as PendingReport;
}

describe("renderMd advisory section", () => {
  it("renders scope_demoted findings under Advisory, not the decision flow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-rwadv-"));
    await new ReportWriter(dir).write(report());
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).toContain("Advisory");
    // The advisory (F-002) and blocking (F-001) are both present.
    expect(md).toContain("F-002");
    expect(md).toContain("F-001");
    // Decision instruction scopes to blocking findings, not "each finding".
    expect(md).toContain("CRITICAL/WARN");
    expect(md).not.toContain("For each finding below");
  });

  it("emits the optional 'train Reviewgate' hint when advisory findings exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-rwadv-"));
    await new ReportWriter(dir).write(report());
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    // Header + concrete JSON template so the agent has everything to act.
    expect(md).toContain("train Reviewgate on advisory hallucinations");
    expect(md).toContain('"reviewer_was_wrong":true');
    expect(md).toContain('"verdict":"rejected"');
  });

  it("omits the optional hint when there are NO advisory findings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-rwadv-"));
    const r = report();
    r.findings = r.findings.filter((f) => f.severity !== "INFO");
    r.counts = { critical: r.counts.critical, warn: r.counts.warn, info: 0 };
    await new ReportWriter(dir).write(r);
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).not.toContain("train Reviewgate on advisory hallucinations");
    // No "Advisory" header should appear either when the list is empty.
    expect(md).not.toContain("## Advisory");
  });

  it("omits the optional hint in one-shot mode (no agent-loop = no decision flow)", async () => {
    // One-shot reports (review-plan) don't drive the decision/learn loop, so
    // the optional hint would be misleading there.
    const dir = mkdtempSync(join(tmpdir(), "rg-rwadv-"));
    await new ReportWriter(dir).write(report(), { mode: "one-shot" });
    const md = readFileSync(planReviewMdPath(dir), "utf8");
    expect(md).toContain("## Advisory"); // section header still rendered
    expect(md).not.toContain("train Reviewgate on advisory hallucinations");
  });
});
