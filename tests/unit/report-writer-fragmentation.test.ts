// tests/unit/report-writer-fragmentation.test.ts
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
  findings: [],
  cost_usd_total: 0,
  duration_ms_total: 1,
  generated_at: "2026-06-17T00:00:00Z",
  git: { sha: "abc1234", branch: "main", dirty_files: [] },
};

describe("report-writer fp_fragmentation banner (#4)", () => {
  it("renders the fragmenting-class banner with file, rule_ids, and the house-rule recommendation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-frag-"));
    await new ReportWriter(dir).write({
      ...base,
      fp_fragmentation: [
        {
          file: "src/theme.ts",
          distinct_signatures: 4,
          total_rejects: 6,
          sample_rule_ids: ["color-hsl", "css-var"],
        },
      ],
    });
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).toContain("Fragmenting false-positive class");
    expect(md).toContain("src/theme.ts");
    expect(md).toContain("color-hsl");
    expect(md).toContain("houseRules");
  });

  it("emits a paste-ready houseRules config snippet (P2: frictionless durable fix)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-frag3-"));
    await new ReportWriter(dir).write({
      ...base,
      fp_fragmentation: [
        {
          file: "src/proxy.ts",
          distinct_signatures: 5,
          total_rejects: 8,
          sample_rule_ids: ["proxy-rule"],
        },
      ],
    });
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    // A copy-paste config block, not just prose telling the agent to "add a house rule".
    expect(md).toContain("```");
    expect(md).toContain("phases:");
    expect(md).toContain("houseRules:");
    expect(md).toContain("src/proxy.ts"); // referenced in the placeholder
  });

  it("omits the banner when fp_fragmentation is absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-frag2-"));
    await new ReportWriter(dir).write(base);
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).not.toContain("Fragmenting false-positive class");
  });
});
