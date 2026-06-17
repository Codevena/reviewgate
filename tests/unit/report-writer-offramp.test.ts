// tests/unit/report-writer-offramp.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportWriter } from "../../src/core/report-writer.ts";
import type { PendingReport } from "../../src/schemas/pending-report.ts";

function report(iter: number): PendingReport {
  return {
    schema: "reviewgate.pending.v1",
    run_id: "r1",
    iter,
    max_iter: 10,
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
    findings: [],
    cost_usd_total: 0,
    duration_ms_total: 1,
    generated_at: "2026-06-17T00:00:00Z",
    git: { sha: "abc1234", branch: "main", dirty_files: [] },
  };
}

describe("report-writer off-ramp tip (#5)", () => {
  it("renders the converging tip from iteration 2 onward (gate mode)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-offramp-"));
    await new ReportWriter(dir).write(report(2));
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).toContain("Converging tip");
    expect(md).toContain("reviewer_was_wrong");
  });

  it("omits the tip on iteration 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-offramp1-"));
    await new ReportWriter(dir).write(report(1));
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).not.toContain("Converging tip");
  });

  it("omits the tip in one-shot mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-offramp-os-"));
    await new ReportWriter(dir).write(report(2), { mode: "one-shot" });
    const md = readFileSync(join(dir, ".reviewgate", "plan-review.md"), "utf8");
    expect(md).not.toContain("Converging tip");
  });
});
