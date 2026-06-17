// tests/unit/report-writer-folded-concerns.test.ts
// #8 bundling (field report 2026-06-17): a cross-category merged finding must enumerate its
// folded concerns as a scannable checklist so the agent can verify one decision covers all.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportWriter } from "../../src/core/report-writer.ts";
import type { PendingReport } from "../../src/schemas/pending-report.ts";

function reportWith(findings: Record<string, unknown>[]): PendingReport {
  const base = {
    id: "F-001",
    signature: "s",
    severity: "WARN",
    category: "quality",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "x", persona: "security" },
    confidence: 0.9,
    consensus: "majority",
  };
  return {
    schema: "reviewgate.pending.v1",
    run_id: "r",
    iter: 1,
    max_iter: 3,
    verdict: "FAIL",
    counts: { critical: 0, warn: findings.length, info: 0 },
    reviewers: [],
    findings: findings.map((o) => ({ ...base, ...o })),
    cost_usd_total: 0,
    duration_ms_total: 0,
    generated_at: "t",
    git: { sha: "0000000", branch: "main", dirty_files: [] },
  } as PendingReport;
}

async function md(r: PendingReport): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "rg-folded-"));
  await new ReportWriter(dir).write(r);
  return readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
}

describe("renderMd folded-concerns enumeration (#8)", () => {
  it("enumerates distinct categories of a cross-category merged finding", async () => {
    const out = await md(
      reportWith([
        {
          id: "F-001",
          severity: "WARN",
          category: "quality",
          rule_id: "naming",
          members: [
            { signature: "s1", provider: "codex", rule_id: "naming", category: "quality" },
            { signature: "s2", provider: "gemini", rule_id: "stale-doc", category: "docs" },
          ],
        },
      ]),
    );
    expect(out).toContain("Folded concerns");
    expect(out).toContain("**quality**");
    expect(out).toContain("**docs**");
    expect(out).toContain("`stale-doc`");
  });

  it("renders NO folded-concerns block for a single-category finding", async () => {
    const out = await md(
      reportWith([
        {
          id: "F-001",
          severity: "WARN",
          category: "quality",
          members: [
            { signature: "s1", provider: "codex", rule_id: "naming", category: "quality" },
            { signature: "s2", provider: "gemini", rule_id: "naming2", category: "quality" },
          ],
        },
      ]),
    );
    expect(out).not.toContain("Folded concerns");
  });

  it("renders NO folded-concerns block for a finding with no members", async () => {
    const out = await md(reportWith([{ id: "F-001", severity: "WARN", category: "quality" }]));
    expect(out).not.toContain("Folded concerns");
  });
});
