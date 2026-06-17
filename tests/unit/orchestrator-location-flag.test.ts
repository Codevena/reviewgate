// tests/unit/orchestrator-location-flag.test.ts
// Non-convergence #1 (field report 2026-06-17): a finding whose region was raised in an EARLIER
// iteration this cycle (passed via opts.priorLocations) is FLAGGED location_recurred (advisory,
// never demoted) so the agent doesn't blindly re-fix a re-litigated line.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { locationKey } from "../../src/core/location-recurrence.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";

const DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

function stub(finding: Finding): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp): Promise<ReviewResult> {
      return {
        reviewerId: inp.reviewerId,
        verdict: "FAIL",
        findings: [finding],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        rawText: "",
        status: "ok",
      };
    },
  };
}

function finding(): Finding {
  return {
    id: "F-001",
    signature: "s",
    severity: "WARN",
    category: "quality",
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
}

const config = {
  ...defaultConfig,
  phases: {
    ...defaultConfig.phases,
    review: { reviewers: [{ provider: "codex" as const, persona: "security" }] },
    critic: null,
    triage: null,
  },
};

async function runWith(opts: {
  priorLocations?: string[];
  priorTouchedFiles?: string[];
  iter?: number;
}): Promise<Finding | undefined> {
  const repo = mkdtempSync(join(tmpdir(), "rg-locflag-"));
  writeFileSync(join(repo, "foo.ts"), "x");
  const orch = new Orchestrator({
    repoRoot: repo,
    config,
    adapters: { codex: stub(finding()) },
    sandboxMode: "off",
    hostTier: "opus",
    diff: DIFF,
    reasonOnFailEnabled: true,
  });
  await orch.runIteration({ runId: "RUN", iter: opts.iter ?? 2, ...opts });
  const report = JSON.parse(readFileSync(join(repo, ".reviewgate", "pending.json"), "utf8"));
  return report.findings[0];
}
const run = (priorLocations: string[]) => runWith({ priorLocations });

describe("Orchestrator — location_recurred flag (#1)", () => {
  it("flags a finding whose region matches a prior-iteration location", async () => {
    const out = await run([locationKey("foo.ts", 1)]);
    expect(out?.location_recurred).toBe(true);
    expect(out?.severity).toBe("WARN"); // FLAG only — never demoted
  });

  it("does NOT flag when the region was not raised before", async () => {
    const out = await run([locationKey("other.ts", 99)]);
    expect(out?.location_recurred).toBeUndefined();
  });

  it("does NOT flag when there are no prior locations", async () => {
    const out = await run([]);
    expect(out?.location_recurred).toBeUndefined();
  });
});

describe("Orchestrator — stable_code flag (#2 bonus / G3b)", () => {
  it("flags a finding on a file the agent has NOT edited (while editing others) — the gold-case", async () => {
    const out = await runWith({ iter: 4, priorTouchedFiles: ["install-prompt.tsx"] }); // not foo.ts
    expect(out?.stable_code).toBe(true);
    expect(out?.severity).toBe("WARN"); // FLAG only — never demoted
  });

  it("does NOT flag when the agent HAS edited the finding's file", async () => {
    const out = await runWith({ iter: 4, priorTouchedFiles: ["foo.ts"] });
    expect(out?.stable_code).toBeUndefined();
  });

  it("does NOT flag at iteration 1 (no earlier review)", async () => {
    const out = await runWith({ iter: 1, priorTouchedFiles: ["install-prompt.tsx"] });
    expect(out?.stable_code).toBeUndefined();
  });

  it("does NOT flag when the agent edited nothing (no active-fixing signal)", async () => {
    const out = await runWith({ iter: 4, priorTouchedFiles: [] });
    expect(out?.stable_code).toBeUndefined();
  });
});
