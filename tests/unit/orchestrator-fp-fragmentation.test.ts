// tests/unit/orchestrator-fp-fragmentation.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import type { FpLedgerEntry } from "../../src/schemas/fp-ledger.ts";
import { knownFpPath } from "../../src/utils/paths.ts";

const DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

function stub(): ProviderAdapter {
  const f: Finding = {
    id: "F",
    signature: "real",
    severity: "CRITICAL",
    category: "security",
    rule_id: "r",
    file: "foo.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
  };
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      return {
        reviewerId: inp.reviewerId,
        verdict: "FAIL",
        findings: [f],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

function fpEntry(signature: string, rule_id: string, ts: string): FpLedgerEntry {
  return {
    id: signature,
    signature,
    rule_id,
    category: "security",
    file: "bar.ts",
    symbol: "",
    stage: "candidate",
    rejects: [{ run_id: "r", provider: "codex", ts, reason: "fp" }],
    distinct_providers: ["codex"],
    first_seen_at: ts,
    last_seen_at: ts,
    created_at: ts,
  };
}

// A fragmenting class on bar.ts: 3 distinct candidate signatures, 1 recent reject each,
// single provider → can't promote (per-signature OR cluster) → flagged.
function seedFragmentingLedger(repo: string): void {
  const ts = new Date().toISOString();
  const index = {
    schema: "reviewgate.fpledger.v1",
    entries: [
      fpEntry("s1", "color-hsl", ts),
      fpEntry("s2", "css-var", ts),
      fpEntry("s3", "hsl-usage", ts),
    ],
  };
  const p = knownFpPath(repo);
  mkdirSync(dirname(p), { recursive: true }); // fresh temp repo → .reviewgate/ may not exist yet
  writeFileSync(p, JSON.stringify(index));
}

function makeConfig(fpFragmentationHint: boolean) {
  return {
    ...defaultConfig,
    phases: {
      ...defaultConfig.phases,
      review: {
        reviewers: [{ provider: "codex" as const, persona: "security" }],
        fpFragmentationHint,
      },
      fpLedger: { enabled: true },
      critic: null,
      triage: null,
    },
  };
}

describe("orchestrator surfaces FP fragmentation (#4)", () => {
  it("renders the fragmenting-class banner for a fragmenting ledger when the hint is on", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-orch-frag-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    seedFragmentingLedger(repo);
    const orch = new Orchestrator({
      repoRoot: repo,
      config: makeConfig(true),
      adapters: { codex: stub() },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
    });
    await orch.runIteration({ runId: "RUN", iter: 1 });
    const md = readFileSync(join(repo, ".reviewgate", "pending.md"), "utf8");
    expect(md).toContain("Fragmenting false-positive class");
    expect(md).toContain("bar.ts");
  });

  it("does NOT render the banner when the hint is off", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-orch-frag-off-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    seedFragmentingLedger(repo);
    const orch = new Orchestrator({
      repoRoot: repo,
      config: makeConfig(false),
      adapters: { codex: stub() },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
    });
    await orch.runIteration({ runId: "RUN", iter: 1 });
    const md = readFileSync(join(repo, ".reviewgate", "pending.md"), "utf8");
    expect(md).not.toContain("Fragmenting false-positive class");
  });
});
