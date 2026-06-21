// tests/unit/report-writer-docs-review.test.ts — P11
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
      category: "correctness",
      rule_id: "r",
      file: "docs/spec.md",
      line_start: 1,
      line_end: 1,
      message: "claims Next.js Server Components in a React/Vite app",
      details: "d",
      reviewer: { provider: "codex", model: "m", persona: "security" },
      confidence: 0.9,
      consensus: "singleton",
    },
  ],
  cost_usd_total: 0,
  duration_ms_total: 1,
  generated_at: "2026-06-21T00:00:00Z",
  git: { sha: "abc1234", branch: "main", dirty_files: ["docs/spec.md"] },
};

describe("report-writer docs-review banner (P11)", () => {
  it("renders the spec/docs-review banner when docs_review is set, WITHOUT changing severity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-docs-"));
    await new ReportWriter(dir).write({ ...base, docs_review: true });
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).toContain("Spec / docs review");
    expect(md).toContain("prose, not code");
    // the finding is NOT demoted — it still renders as a gated CRITICAL.
    expect(md).toContain("CRITICAL");
  });

  it("omits the banner when docs_review is absent (a normal code review)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-docs2-"));
    await new ReportWriter(dir).write(base);
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).not.toContain("Spec / docs review");
  });
});
