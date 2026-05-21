import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportWriter } from "../../src/core/report-writer.ts";
import type { PendingReport } from "../../src/schemas/pending-report.ts";
import { pendingMdPath, planReviewMdPath } from "../../src/utils/paths.ts";

function report(): PendingReport {
  return {
    schema: "reviewgate.pending.v1",
    run_id: "RUN",
    iter: 1,
    max_iter: 3,
    verdict: "PASS",
    counts: { critical: 0, warn: 0, info: 0 },
    reviewers: [
      {
        id: "codex-plan",
        provider: "codex",
        model: "gpt-5.4",
        persona: "plan",
        status: "ok",
        cost_usd: 0,
        duration_ms: 1,
      },
    ],
    findings: [],
    cost_usd_total: 0,
    duration_ms_total: 1,
    generated_at: new Date().toISOString(),
    git: { sha: "0".repeat(40), branch: "main", dirty_files: [] },
  };
}

describe("ReportWriter one-shot mode", () => {
  it("gate mode (default) keeps the decisions-loop instructions", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rep1-"));
    await new ReportWriter(repo).write(report());
    const md = readFileSync(pendingMdPath(repo), "utf8");
    expect(md).toContain("Required actions");
  });

  it("one-shot mode omits the decisions-loop instructions", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rep2-"));
    await new ReportWriter(repo).write(report(), { mode: "one-shot" });
    const md = readFileSync(planReviewMdPath(repo), "utf8");
    expect(md).not.toContain("Required actions");
    expect(md).not.toContain("decisions/");
    expect(md).toContain("Reviewgate Report");
  });
});
