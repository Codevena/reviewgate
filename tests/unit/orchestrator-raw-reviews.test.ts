// tests/unit/orchestrator-raw-reviews.test.ts
// P1a: opt-in `captureRawReviews` surfaces the per-provider, pre-aggregation
// findings on IterationResult.rawReviews (deep-cloned so downstream demote/
// aggregate passes can't mutate the snapshot). Feeds the bench per-provider layer.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function stub(
  id: ProviderAdapter["id"],
  findings: Finding[],
  completeText?: string,
): ProviderAdapter {
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
    ...(completeText !== undefined ? { complete: async () => completeText } : {}),
  };
}

function f(sig: string, provider: string, persona: string): Finding {
  return {
    id: "F-1",
    signature: sig,
    severity: "WARN",
    category: "security",
    rule_id: "r",
    file: "foo.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider, model: "m", persona },
    confidence: 0.8,
    consensus: "singleton",
  };
}

const DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

function baseConfig() {
  return {
    ...defaultConfig,
    phases: {
      ...defaultConfig.phases,
      review: { reviewers: [{ provider: "codex" as const, persona: "security" }] },
      critic: null,
      triage: null,
    },
  };
}

describe("Orchestrator captureRawReviews", () => {
  it("does NOT populate rawReviews when the flag is off (default)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-raw-off-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const orch = new Orchestrator({
      repoRoot: repo,
      config: baseConfig(),
      adapters: { codex: stub("codex", [f("s", "codex", "security")]) },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
    });
    const result = await orch.runIteration({ runId: "RUN", iter: 1 });
    expect(result.rawReviews).toBeUndefined();
  });

  it("captures per-provider pre-aggregation findings with identity + status when on", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-raw-on-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const orch = new Orchestrator({
      repoRoot: repo,
      config: baseConfig(),
      adapters: { codex: stub("codex", [f("s", "codex", "security")]) },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
      captureRawReviews: true,
    });
    const result = await orch.runIteration({ runId: "RUN", iter: 1 });
    expect(result.rawReviews).toBeDefined();
    expect(result.rawReviews).toHaveLength(1);
    const rr = result.rawReviews?.[0];
    expect(rr?.provider).toBe("codex");
    expect(rr?.persona).toBe("security");
    expect(rr?.reviewerId).toBe("codex-security");
    expect(rr?.status).toBe("ok");
    expect(rr?.findings).toHaveLength(1);
    expect(rr?.findings[0]?.signature).toBe("s");
  });

  it("deep-clones the snapshot: a critic demotion (WARN→INFO) does NOT mutate rawReviews", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-raw-frozen-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const finding = f("sigW", "codex", "security");
    const criticText = `{"verdicts":[{"signature":"${finding.signature}","verdict":"likely_fp","reason":"stylistic only"}]}`;
    const config = {
      ...defaultConfig,
      providers: {
        ...defaultConfig.providers,
        gemini: { enabled: true, auth: "oauth" as const, model: "gemini-3-flash", timeoutMs: 1000 },
      },
      phases: {
        ...defaultConfig.phases,
        review: { reviewers: [{ provider: "codex" as const, persona: "security" }] },
        critic: { provider: "gemini" as const, persona: "fp-filter" },
        triage: null,
      },
    };
    const orch = new Orchestrator({
      repoRoot: repo,
      config,
      adapters: {
        codex: stub("codex", [{ ...finding, severity: "WARN", category: "quality" }]),
        gemini: stub("gemini", [], criticText),
      },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
      captureRawReviews: true,
    });
    const result = await orch.runIteration({ runId: "RUN", iter: 1 });
    // Aggregated finding was demoted WARN→INFO by the critic…
    const report = JSON.parse(readFileSync(join(repo, ".reviewgate", "pending.json"), "utf8"));
    expect(report.findings[0].severity).toBe("INFO");
    // …but the raw snapshot must still show the reviewer's ORIGINAL WARN.
    expect(result.rawReviews?.[0]?.findings[0]?.severity).toBe("WARN");
  });
});
