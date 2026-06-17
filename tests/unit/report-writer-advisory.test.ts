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
  it("renders a scope_demoted finding under 'Existing code', not the decision flow (#2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-rwadv-"));
    await new ReportWriter(dir).write(report());
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    // #2: out-of-diff (scope_demoted) findings go into the fenced "Existing code" section,
    // NOT the in-scope Advisory list.
    expect(md).toContain("## Existing code");
    const existingIdx = md.indexOf("## Existing code");
    expect(md.indexOf("F-002")).toBeGreaterThan(existingIdx); // F-002 under Existing code
    expect(md).toContain("F-001");
    // Decision instruction scopes to blocking findings, not "each finding".
    expect(md).toContain("CRITICAL/WARN");
    expect(md).not.toContain("For each finding below");
  });

  it("keeps in-scope INFO under '## Advisory' and out-of-diff INFO under '## Existing code' (#2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-rwadv-"));
    const r = report();
    const base = r.findings[0];
    if (!base) throw new Error("fixture changed");
    r.findings = [
      { ...base, id: "F-001", severity: "CRITICAL" as const, scope_demoted: undefined },
      { ...base, id: "F-INFO", severity: "INFO" as const, scope_demoted: undefined, file: "a.ts" },
      {
        ...base,
        id: "F-REPO",
        severity: "INFO" as const,
        scope_demoted: true,
        file: "untouched.ts",
      },
    ];
    r.counts = { critical: 1, warn: 0, info: 2 };
    await new ReportWriter(dir).write(r);
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    const advIdx = md.indexOf("## Advisory");
    const repoIdx = md.indexOf("## Existing code");
    expect(advIdx).toBeGreaterThan(-1);
    expect(repoIdx).toBeGreaterThan(advIdx); // Existing code comes after in-scope Advisory
    // F-INFO (in-scope) under Advisory, before Existing code; F-REPO under Existing code.
    expect(md.indexOf("F-INFO")).toBeGreaterThan(advIdx);
    expect(md.indexOf("F-INFO")).toBeLessThan(repoIdx);
    expect(md.indexOf("F-REPO")).toBeGreaterThan(repoIdx);
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
    // The fixture's lone advisory (F-002) is scope_demoted → "Existing code" section is
    // still rendered in one-shot; only the agent-loop train hint is suppressed.
    expect(md).toContain("## Existing code");
    expect(md).not.toContain("train Reviewgate on advisory hallucinations");
  });

  it("F3 Phase 2: a fp_cluster_match-tagged WARN routes into Advisory and shows the cluster badge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-rwadv-"));
    const r = report();
    const [crit, adv] = r.findings;
    if (!crit || !adv) throw new Error("fixture changed");
    // Replace F-002 advisory with a WARN that carries fp_cluster_match.suppressed
    // → must route to Advisory and render the new 📚 badge with the cluster key.
    r.findings = [
      crit,
      {
        ...adv,
        id: "F-002",
        severity: "WARN" as const,
        scope_demoted: undefined,
        fp_cluster_match: {
          cluster_key: "prisma@prisma/schema.prisma",
          member_ids: ["FP-001", "FP-002", "FP-004"],
          suppressed: true,
        },
      },
    ];
    r.counts = { critical: 1, warn: 0, info: 1 };
    await new ReportWriter(dir).write(r);
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    // F-002 is in Advisory, not WARN.
    expect(md).toContain("F-002");
    expect(md).toContain("Advisory");
    expect(md).toContain("📚 active FP cluster prisma@prisma/schema.prisma");
    // CRITICAL section still holds F-001 — cluster routing doesn't affect blockers.
    expect(md).toContain("F-001");
  });
});
