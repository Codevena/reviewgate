// tests/unit/orchestrator-fallback.test.ts
// Quota-failover routing: when the primary reviewer is quota-exhausted and the
// slot declares a `fallback` chain, the orchestrator re-runs the SAME persona on
// the first available fallback provider. Only quota exhaustion triggers it.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type {
  ProviderAdapter,
  ReviewResult,
  ReviewStatus,
} from "../../src/providers/adapter-base.ts";

function fixedStatus(id: ProviderAdapter["id"], status: ReviewStatus): ProviderAdapter {
  return {
    id,
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      return {
        reviewerId: inp.reviewerId,
        verdict: status === "ok" ? "PASS" : "ERROR",
        findings: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: status === "ok" ? 0 : 1,
        rawEventsPath: "",
        rawText: "",
        status,
        ...(status === "ok" ? {} : { statusDetail: `${id} ${status}` }),
      } satisfies ReviewResult;
    },
  };
}

const DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

function makeConfig(fallback?: ("gemini" | "claude-code")[]) {
  return {
    ...defaultConfig,
    providers: {
      ...defaultConfig.providers,
      gemini: {
        enabled: false,
        auth: "oauth" as const,
        model: "gemini-3-flash-preview",
        timeoutMs: 1000,
      },
    },
    phases: {
      review: {
        reviewers: [
          { provider: "codex" as const, persona: "security", ...(fallback ? { fallback } : {}) },
        ],
      },
      critic: null,
      triage: null,
    },
  };
}

async function runWith(
  config: ReturnType<typeof makeConfig>,
  adapters: Record<string, ProviderAdapter>,
) {
  const repo = mkdtempSync(join(tmpdir(), "rg-fb-"));
  writeFileSync(join(repo, "foo.ts"), "x");
  const orch = new Orchestrator({
    repoRoot: repo,
    // biome-ignore lint/suspicious/noExplicitAny: test config shape
    config: config as any,
    adapters,
    sandboxMode: "off",
    hostTier: "opus",
    diff: DIFF,
    reasonOnFailEnabled: true,
    // Hermetic: a fallback candidate is "available" iff a stub adapter was given.
    providerAvailable: (id) => Boolean(adapters[id]),
  });
  await orch.runIteration({ runId: "RUN", iter: 1 });
  return JSON.parse(readFileSync(join(repo, ".reviewgate", "pending.json"), "utf8"));
}

describe("Orchestrator quota failover", () => {
  it("fails over to the gemini fallback when codex is quota-exhausted", async () => {
    const report = await runWith(makeConfig(["gemini"]), {
      codex: fixedStatus("codex", "quota-exhausted"),
      gemini: fixedStatus("gemini", "ok"),
    });
    // The slot's recorded reviewer is the fallback that actually ran.
    expect(report.reviewers.length).toBe(1);
    expect(report.reviewers[0].provider).toBe("gemini");
    expect(report.reviewers[0].status).toBe("ok");
    expect(report.reviewers[0].status_detail).toContain("fallback from codex");
  });

  it("does NOT fail over on a plain error (only quota triggers it)", async () => {
    const report = await runWith(makeConfig(["gemini"]), {
      codex: fixedStatus("codex", "error"),
      gemini: fixedStatus("gemini", "ok"),
    });
    expect(report.reviewers[0].provider).toBe("codex");
    expect(report.reviewers[0].status).toBe("error");
  });

  it("keeps the quota-exhausted result when no fallback chain is declared", async () => {
    const report = await runWith(makeConfig(undefined), {
      codex: fixedStatus("codex", "quota-exhausted"),
      gemini: fixedStatus("gemini", "ok"),
    });
    expect(report.reviewers[0].provider).toBe("codex");
    expect(report.reviewers[0].status).toBe("quota-exhausted");
  });
});
