// tests/unit/orchestrator-fail-closed.test.ts
//
// Finding A (fail-open) regression: the gate must NEVER emit PASS when zero
// reviewers ran successfully — a capped/unavailable/misconfigured panel would
// otherwise silently pass every turn. Zero ok runs → verdict ERROR (the
// LoopDriver then blocks with "reviewer error").
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import type { Finding } from "../../src/schemas/finding.ts";

const DIFF = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n";

function cfg() {
  return {
    ...defaultConfig,
    phases: {
      review: { reviewers: [{ provider: "codex" as const, persona: "security" }] },
      critic: null,
      triage: null,
    },
  };
}

function mk(adapter: ProviderAdapter, repo: string) {
  return new Orchestrator({
    repoRoot: repo,
    config: cfg(),
    adapters: { codex: adapter },
    sandboxMode: "off",
    hostTier: "opus",
    diff: DIFF,
    reasonOnFailEnabled: true,
  });
}

const okStub = (findings: Finding[]): ProviderAdapter => ({
  id: "codex",
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
});

describe("Orchestrator fail-closed (Finding A)", () => {
  it("emits ERROR (not PASS) when the reviewer returns status:error", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fc-err-"));
    const erroring: ProviderAdapter = {
      id: "codex",
      async preflight() {
        return { available: true, version: "x", authMode: "oauth", error: null };
      },
      async review(inp) {
        return {
          reviewerId: inp.reviewerId,
          verdict: "PASS",
          findings: [],
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
          durationMs: 1,
          exitCode: 1,
          rawEventsPath: "",
          rawText: "",
          status: "error",
          statusDetail: "quota exceeded",
        } satisfies ReviewResult;
      },
    };
    const result = await mk(erroring, repo).runIteration({ runId: "RUN", iter: 1 });
    expect(result.verdict).toBe("ERROR");
    const report = JSON.parse(readFileSync(join(repo, ".reviewgate", "pending.json"), "utf8"));
    // ERROR is written as FAIL in the report (never PASS), and the real failed
    // reviewer record is preserved (not a placeholder).
    expect(report.verdict).toBe("FAIL");
    expect(report.reviewers[0].status).toBe("error");
  });

  it("emits ERROR when every reviewer THROWS (0 settled runs)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fc-throw-"));
    const throwing: ProviderAdapter = {
      id: "codex",
      async preflight() {
        return { available: true, version: "x", authMode: "oauth", error: null };
      },
      async review() {
        throw new Error("spawn failed");
      },
    };
    const result = await mk(throwing, repo).runIteration({ runId: "RUN", iter: 1 });
    expect(result.verdict).toBe("ERROR");
  });

  it("REGRESSION: a successful reviewer with zero findings still PASSes", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-fc-ok-"));
    const result = await mk(okStub([]), repo).runIteration({ runId: "RUN", iter: 1 });
    expect(result.verdict).toBe("PASS");
  });
});
