// tests/unit/report-writer-low-trust-collapse.test.ts
// #3/#5 (field report 2026-06-17): solo low-track-record INFO notes are folded into a
// collapsed block so a noisy low-precision reviewer doesn't dilute the agent's read.
// Render-only — nothing is dropped (every note stays in pending.json + the foldable block);
// security/correctness and corroborated/blocking findings are never collapsed.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportWriter } from "../../src/core/report-writer.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import type { PendingReport } from "../../src/schemas/pending-report.ts";

function f(over: Partial<Finding>): Finding {
  return {
    id: "F-001",
    signature: "s",
    severity: "INFO",
    category: "quality",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "openrouter", model: "x", persona: "security" },
    confidence: 0.5,
    consensus: "singleton",
    ...over,
  };
}
const lowTrust = [{ provider: "openrouter", tp: 5, fp: 12, precision: 5 / 17 }]; // 29%
const highTrust = [{ provider: "codex", tp: 14, fp: 1, precision: 14 / 15 }];

function report(findings: Finding[]): PendingReport {
  return {
    schema: "reviewgate.pending.v1",
    run_id: "r",
    iter: 1,
    max_iter: 3,
    verdict: "PASS",
    counts: { critical: 0, warn: 0, info: findings.length },
    reviewers: [],
    findings,
    cost_usd_total: 0,
    duration_ms_total: 0,
    generated_at: "t",
    git: { sha: "0000000", branch: "main", dirty_files: [] },
  } as PendingReport;
}

async function md(
  findings: Finding[],
  opts?: { collapseLowTrustSoloInfo?: boolean },
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "rg-lowtrust-"));
  await new ReportWriter(dir).write(report(findings), opts);
  return readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
}

describe("renderMd low-track-record collapse (#3/#5)", () => {
  it("folds a solo low-precision INFO into a <details> block (still present)", async () => {
    const out = await md([f({ id: "F-LOW", reviewer_precision: lowTrust })]);
    expect(out).toContain("<details>");
    expect(out).toContain("low-track-record advisory note");
    expect(out).toContain("openrouter 29%");
    expect(out).toContain("F-LOW"); // never dropped
  });

  it("does NOT collapse a high-precision reviewer's INFO", async () => {
    const out = await md([
      f({
        id: "F-HI",
        reviewer: { provider: "codex", model: "x", persona: "security" },
        reviewer_precision: highTrust,
      }),
    ]);
    expect(out).not.toContain("<details>");
    expect(out).toContain("F-HI");
  });

  it("never collapses a security/correctness INFO even from a low-trust reviewer", async () => {
    const out = await md([f({ id: "F-SEC", category: "security", reviewer_precision: lowTrust })]);
    expect(out).not.toContain("<details>");
    expect(out).toContain("F-SEC");
  });

  it("never collapses a corroborated (majority) INFO", async () => {
    const out = await md([f({ id: "F-MAJ", consensus: "majority", reviewer_precision: lowTrust })]);
    expect(out).not.toContain("<details>");
  });

  it("is a no-op when the toggle is off", async () => {
    const out = await md([f({ id: "F-LOW", reviewer_precision: lowTrust })], {
      collapseLowTrustSoloInfo: false,
    });
    expect(out).not.toContain("<details>");
    expect(out).toContain("F-LOW");
  });
});
