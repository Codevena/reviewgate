// tests/unit/report-writer.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReportWriter } from "../../src/core/report-writer.ts";
import type { PendingReport } from "../../src/schemas/pending-report.ts";

const baseReport: PendingReport = {
  schema: "reviewgate.pending.v1",
  run_id: "r1",
  iter: 1,
  max_iter: 3,
  verdict: "FAIL",
  counts: { critical: 1, warn: 1, info: 0 },
  reviewers: [
    {
      id: "codex",
      provider: "codex",
      model: "gpt-5.5",
      persona: "security",
      status: "ok",
      cost_usd: 0,
      duration_ms: 1234,
    },
  ],
  findings: [
    {
      id: "F-001",
      signature: "sig1",
      severity: "CRITICAL",
      category: "security",
      rule_id: "sql-injection",
      file: "src/db.ts",
      line_start: 42,
      line_end: 42,
      message: "unsanitized SQL",
      details: "building SQL from string concat",
      reviewer: { provider: "codex", model: "gpt-5.5", persona: "security" },
      confidence: 0.9,
      consensus: "singleton",
    },
  ],
  cost_usd_total: 0,
  duration_ms_total: 1234,
  generated_at: "2026-05-20T14:32:11Z",
  git: { sha: "abc1234", branch: "main", dirty_files: ["src/db.ts"] },
};

describe("ReportWriter", () => {
  it("writes pending.md and pending.json side by side", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-rep-"));
    const w = new ReportWriter(dir);
    await w.write(baseReport);
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    const json = JSON.parse(readFileSync(join(dir, ".reviewgate", "pending.json"), "utf8"));
    expect(md).toContain("FAIL");
    expect(md).toContain("F-001");
    expect(md).toContain("src/db.ts:42"); // single-line finding → plain line
    expect(json.run_id).toBe("r1");
    expect(json.findings[0].id).toBe("F-001");
  });

  it("renders a line RANGE for a multi-line finding (line_start-line_end)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-rep-"));
    const w = new ReportWriter(dir);
    const f0 = baseReport.findings[0];
    if (!f0) throw new Error("fixture missing finding");
    await w.write({ ...baseReport, findings: [{ ...f0, line_start: 10, line_end: 18 }] });
    const md = readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    expect(md).toContain("src/db.ts:10-18");
  });

  it("writes ESCALATION.md when verdict=ESCALATE", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-rep-"));
    const w = new ReportWriter(dir);
    await w.writeEscalation({
      runId: "r1",
      iter: 3,
      maxIter: 3,
      reasonCode: "max-iterations",
      summary: "Hit max iterations without convergence.",
      perIter: [
        { iter: 1, verdict: "FAIL", crit: 2, warn: 3, costUsd: 0.22, findings: 5 },
        { iter: 2, verdict: "FAIL", crit: 1, warn: 3, costUsd: 0.18, findings: 4 },
        { iter: 3, verdict: "FAIL", crit: 1, warn: 2, costUsd: 0.15, findings: 3 },
      ],
      topFindings: baseReport.findings,
      triggeredAt: "2026-05-20T14:35:00Z",
    });
    const md = readFileSync(join(dir, ".reviewgate", "ESCALATION.md"), "utf8");
    expect(md).toContain("max-iterations");
    expect(md).toContain("r1");
    expect(md).toContain("F-001");
  });

  it("escalation report reflects post-decision status (addressed/rejected/open)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-esc-"));
    const w = new ReportWriter(dir);
    const f1 = baseReport.findings[0];
    if (!f1) throw new Error("fixture missing finding");
    const f2 = {
      ...f1,
      id: "F-002",
      signature: "sig2",
      severity: "WARN" as const,
      category: "quality" as const,
      rule_id: "style-nit",
      message: "indentation",
      details: "indent mismatch",
    };
    const f3 = {
      ...f1,
      id: "F-003",
      signature: "sig3",
      severity: "WARN" as const,
      category: "quality" as const,
      rule_id: "maybe-clip",
      message: "may clip",
      details: "layout risk",
    };
    await w.writeEscalation({
      runId: "r1",
      iter: 3,
      maxIter: 3,
      reasonCode: "max-iterations",
      summary: "Hit max iterations.",
      perIter: [{ iter: 1, verdict: "FAIL", crit: 1, warn: 2, costUsd: 0, findings: 3 }],
      topFindings: [f1, f2, f3],
      findingStatus: {
        "F-001": { state: "addressed" },
        "F-002": { state: "rejected", reason: "gap-3 is smaller than the default gap-6" },
        // F-003 intentionally absent → "open"
      },
      triggeredAt: "2026-05-20T14:35:00Z",
    });
    const md = readFileSync(join(dir, ".reviewgate", "ESCALATION.md"), "utf8");
    // Each finding's block carries its post-decision status badge.
    expect(md).toMatch(/F-001[\s\S]*✓ addressed/);
    expect(md).toMatch(/F-002[\s\S]*✗ rejected/);
    expect(md).toContain("gap-3 is smaller than the default gap-6"); // rejection reason surfaced
    expect(md).toMatch(/F-003[\s\S]*● open/);
    // One-line summary of the current (post-decision) state.
    expect(md).toContain("1 open · 1 addressed · 1 rejected");
    // Open findings sort ahead of resolved ones (so the human reads what's still live first).
    expect(md.indexOf("F-003")).toBeLessThan(md.indexOf("F-001"));
  });

  // --- Visual cues: consensus emoji + demote badges ---
  describe("finding visual cues", () => {
    const f0 = baseReport.findings[0];
    if (!f0) throw new Error("fixture missing finding");
    const renderFinding = async (overrides: Partial<typeof f0>) => {
      const dir = mkdtempSync(join(tmpdir(), "rg-rep-cue-"));
      await new ReportWriter(dir).write({ ...baseReport, findings: [{ ...f0, ...overrides }] });
      return readFileSync(join(dir, ".reviewgate", "pending.md"), "utf8");
    };

    it("singleton consensus → ⚪ in the header", async () => {
      const md = await renderFinding({ consensus: "singleton" });
      expect(md).toContain("⚪");
      expect(md).not.toContain("🟡");
      expect(md).not.toContain("🟢");
    });

    it("minority consensus → ⚪ (same weak-signal bucket as singleton)", async () => {
      const md = await renderFinding({ consensus: "minority" });
      expect(md).toContain("⚪");
    });

    it("majority consensus → 🟡 (solid)", async () => {
      const md = await renderFinding({ consensus: "majority" });
      expect(md).toContain("🟡");
      expect(md).not.toContain("⚪");
    });

    it("unanimous consensus → 🟢 (highest confidence)", async () => {
      const md = await renderFinding({ consensus: "unanimous" });
      expect(md).toContain("🟢");
    });

    it("clean finding (no demote flags) renders NO badge line", async () => {
      const md = await renderFinding({});
      expect(md).not.toContain("📍");
      expect(md).not.toContain("🧠");
      expect(md).not.toContain("📒");
      expect(md).not.toContain("🎯");
      expect(md).not.toContain("📉");
    });

    it("scope_demoted → 📍 badge", async () => {
      const md = await renderFinding({ scope_demoted: true });
      expect(md).toContain("📍 outside changed lines");
    });

    it("critic_verdict=likely_fp → 🧠 badge", async () => {
      const md = await renderFinding({ critic_verdict: "likely_fp" });
      expect(md).toContain("🧠 critic flagged as likely FP");
    });

    it("fp_ledger_match.suppressed → 📒 badge", async () => {
      const md = await renderFinding({
        fp_ledger_match: { pattern_id: "FP-001", matched_count: 1, suppressed: true },
      });
      expect(md).toContain("📒 matches known-FP pattern");
    });

    it("low_confidence → 🎯 badge", async () => {
      const md = await renderFinding({ low_confidence: true });
      expect(md).toContain("🎯 below confidence floor");
    });

    it("reputation_demoted → 📉 badge", async () => {
      const md = await renderFinding({ reputation_demoted: true });
      expect(md).toContain("📉 reviewer reputation low");
    });

    it("multiple flags render multiple badges on one blockquote line", async () => {
      const md = await renderFinding({
        scope_demoted: true,
        critic_verdict: "likely_fp",
        low_confidence: true,
      });
      expect(md).toContain("📍");
      expect(md).toContain("🧠");
      expect(md).toContain("🎯");
      // All three on one line joined by " · "
      const badgeLine = md.split("\n").find((l) => l.startsWith("> 📍"));
      expect(badgeLine).toBeDefined();
      expect(badgeLine).toContain("🧠");
      expect(badgeLine).toContain("🎯");
    });

    it("claimed_fixed_recurred (blocking CRITICAL/WARN) → asserts the fix did not resolve it", async () => {
      const md = await renderFinding({ claimed_fixed_recurred: { iter: 2 } });
      expect(md).toContain("claimed fixed @ iter 2");
      // Default fixture is CRITICAL (blocking) → the strong wording.
      expect(md).toContain("the fix did not resolve it");
      // The default fixture finding is CRITICAL; a pinned recurrence is NOT advisory,
      // so it renders in the CRITICAL section, which precedes the Advisory section.
      const findingIdx = md.indexOf("F-001");
      const advisoryIdx = md.indexOf("## Advisory");
      expect(findingIdx).toBeGreaterThan(-1);
      if (advisoryIdx > -1) expect(findingIdx).toBeLessThan(advisoryIdx);
    });

    it("claimed_fixed_recurred (scope-demoted advisory INFO) → softens to 'recurred (advisory…)', NOT 'did not resolve it'", async () => {
      // A pinned recurrence demoted to INFO by scope/fp is advisory; the strong
      // "did not resolve it" wording would mislead for an out-of-diff recurrence.
      const md = await renderFinding({
        severity: "INFO",
        scope_demoted: true,
        claimed_fixed_recurred: { iter: 3 },
      });
      expect(md).toContain("claimed fixed @ iter 3");
      expect(md).toContain("recurred (advisory");
      expect(md).not.toContain("the fix did not resolve it");
    });
  });
});
