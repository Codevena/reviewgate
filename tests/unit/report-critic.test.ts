import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportWriter } from "../../src/core/report-writer.ts";
import { type PendingReport, PendingReportSchema } from "../../src/schemas/pending-report.ts";
import { pendingJsonPath } from "../../src/utils/paths.ts";

function base(): PendingReport {
  return {
    schema: "reviewgate.pending.v1",
    run_id: "r1",
    iter: 1,
    max_iter: 3,
    verdict: "FAIL",
    counts: { critical: 1, warn: 0, info: 0 },
    reviewers: [],
    findings: [],
    cost_usd_total: 0,
    duration_ms_total: 0,
    generated_at: "2026-05-21T00:00:00Z",
    git: { sha: "0".repeat(40), branch: "main", dirty_files: [] },
  };
}

describe("report critic observability field", () => {
  it("persists critic status/verdicts/demoted in pending.json", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-rep-critic-"));
    await new ReportWriter(repo).write({
      ...base(),
      critic: { provider: "gemini", status: "ran", verdicts: 3, demoted: 1 },
    });
    const read = PendingReportSchema.parse(JSON.parse(readFileSync(pendingJsonPath(repo), "utf8")));
    expect(read.critic?.status).toBe("ran");
    expect(read.critic?.verdicts).toBe(3);
    expect(read.critic?.demoted).toBe(1);
  });

  it("accepts a report WITHOUT critic (backward-compatible)", () => {
    const parsed = PendingReportSchema.parse(base());
    expect(parsed.critic).toBeUndefined();
  });

  it("accepts the 'empty' status (configured-but-silent critic)", () => {
    const parsed = PendingReportSchema.parse({
      ...base(),
      critic: { provider: "gemini", status: "empty", verdicts: 0, demoted: 0 },
    });
    expect(parsed.critic?.status).toBe("empty");
  });
});
