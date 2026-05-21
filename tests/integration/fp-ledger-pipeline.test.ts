// tests/integration/fp-ledger-pipeline.test.ts
//
// End-to-end wiring test for M5 Part B1: an active FP-ledger entry must demote a
// matching finding to INFO through the REAL Orchestrator.runIteration pipeline
// (not just the aggregator unit) — and the opt-in gate must be honoured.
//
// Signature stability: the finding sits on `a.ts`, which is NOT written to disk,
// so applySymbolSignatures finds no enclosing symbol and preserves the reviewer's
// signature ("sigFP"). The finding is placed on a CHANGED line so the Part-A
// scopeToDiff stage keeps it blocking — isolating the FP-ledger demote as the
// only thing that can flip CRITICAL→INFO.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { FpLedgerStore } from "../../src/core/fp-ledger/store.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";

const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";

function stub(id: ProviderAdapter["id"], findings: Finding[]): ProviderAdapter {
  return {
    id,
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      return {
        reviewerId: inp.reviewerId,
        verdict: findings.length ? "FAIL" : "PASS",
        findings,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        rawText: "",
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

const finding: Finding = {
  id: "F-1",
  signature: "sigFP",
  severity: "CRITICAL",
  category: "security",
  rule_id: "r",
  file: "a.ts",
  line_start: 1,
  line_end: 1,
  message: "m",
  details: "d",
  reviewer: { provider: "codex", model: "m", persona: "security" },
  confidence: 0.9,
  consensus: "singleton",
};

function configWithFpLedger(enabled: boolean) {
  return {
    ...defaultConfig,
    phases: {
      review: { reviewers: [{ provider: "codex" as const, persona: "security" }] },
      critic: null,
      triage: null,
      ...(enabled ? { fpLedger: { enabled: true } } : {}),
    },
  };
}

async function seedActive(repo: string): Promise<string> {
  const store = new FpLedgerStore(repo);
  const meta = { rule_id: "r", category: "security" as const, file: "a.ts", symbol: "" };
  const now = new Date().toISOString();
  // 3 rejects across 2 distinct providers within 60d → "active".
  await store.recordReject("sigFP", meta, { run_id: "x", provider: "codex", reason: "x" }, now);
  await store.recordReject("sigFP", meta, { run_id: "y", provider: "gemini", reason: "x" }, now);
  await store.recordReject("sigFP", meta, { run_id: "z", provider: "codex", reason: "x" }, now);
  const snap = await store.snapshot();
  expect(snap.entries[0]?.stage).toBe("active");
  return snap.entries[0]?.id as string;
}

describe("FP-ledger pipeline (opt-in)", () => {
  it("demotes a finding matching an active FP entry to INFO (CRITICAL→INFO, FAIL→PASS)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fppipe-"));
    const fpId = await seedActive(repo);
    const orch = new Orchestrator({
      repoRoot: repo,
      config: configWithFpLedger(true),
      adapters: { codex: stub("codex", [finding]) },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
    });
    const result = await orch.runIteration({ runId: "RUN", iter: 1 });
    expect(result.verdict).toBe("PASS");
    const report = JSON.parse(readFileSync(join(repo, ".reviewgate", "pending.json"), "utf8"));
    expect(report.findings[0].severity).toBe("INFO");
    expect(report.findings[0].fp_ledger_match.suppressed).toBe(true);
    expect(report.findings[0].fp_ledger_match.pattern_id).toBe(fpId);
  });

  it("does NOT demote when fpLedger is disabled (opt-in gate; stays CRITICAL/FAIL)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fppipe-off-"));
    await seedActive(repo); // ledger present but feature off
    const orch = new Orchestrator({
      repoRoot: repo,
      config: configWithFpLedger(false),
      adapters: { codex: stub("codex", [finding]) },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
    });
    const result = await orch.runIteration({ runId: "RUN", iter: 1 });
    expect(result.verdict).toBe("FAIL");
    const report = JSON.parse(readFileSync(join(repo, ".reviewgate", "pending.json"), "utf8"));
    expect(report.findings[0].severity).toBe("CRITICAL");
    expect(report.findings[0].fp_ledger_match ?? null).toBeNull();
  });
});
