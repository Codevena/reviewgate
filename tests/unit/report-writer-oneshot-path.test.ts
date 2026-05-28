import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
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
        model: "gpt-5.5",
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

describe("one-shot report path isolation", () => {
  it("one-shot writes plan-review.md and does NOT touch the gate's pending.md", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-osp-"));
    await new ReportWriter(repo).write(report(), { mode: "one-shot" });
    expect(existsSync(planReviewMdPath(repo))).toBe(true);
    expect(readFileSync(planReviewMdPath(repo), "utf8")).toContain("Reviewgate Report");
    // The gate's report path must remain untouched by a one-shot review.
    expect(existsSync(pendingMdPath(repo))).toBe(false);
  });

  it("gate mode still writes pending.md (default)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-osp2-"));
    await new ReportWriter(repo).write(report());
    expect(existsSync(pendingMdPath(repo))).toBe(true);
    expect(existsSync(planReviewMdPath(repo))).toBe(false);
  });
});
