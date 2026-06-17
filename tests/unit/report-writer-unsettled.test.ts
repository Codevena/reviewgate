// tests/unit/report-writer-unsettled.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportWriter } from "../../src/core/report-writer.ts";
import type { PendingReport } from "../../src/schemas/pending-report.ts";

const base: PendingReport = {
  schema: "reviewgate.pending.v1",
  run_id: "r1",
  iter: 1,
  max_iter: 3,
  verdict: "FAIL",
  counts: { critical: 0, warn: 0, info: 0 },
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
  findings: [],
  cost_usd_total: 0,
  duration_ms_total: 1,
  generated_at: "2026-06-17T00:00:00Z",
  git: { sha: "abc1234", branch: "main", dirty_files: [] },
};

describe("report-writer workspace_unsettled banner (#7)", () => {
  it("renders the not-quiescent banner when workspace_unsettled is present", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-uns-"));
    await new ReportWriter(dir).write({
      ...base,
      workspace_unsettled: { last_write_ms_ago: 120, waited_ms: 1500 },
    });
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).toContain("Workspace not quiescent");
    expect(md).toContain("120ms");
    expect(md).toContain("1500ms");
  });

  it("omits the banner when workspace_unsettled is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-uns2-"));
    await new ReportWriter(dir).write(base);
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).not.toContain("Workspace not quiescent");
  });
});
