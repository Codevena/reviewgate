import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "../../src/config/define-config.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";

function recordingStub(seen: { persona?: string; prompt?: string }): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
      seen.persona = inp.persona;
      seen.prompt = readFileSync(inp.promptFile, "utf8");
      return {
        reviewerId: inp.reviewerId,
        verdict: "PASS",
        findings: [],
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        status: "ok",
      } satisfies ReviewResult;
    },
  };
}

const docDiff =
  "diff --git a/docs/superpowers/specs/x.md b/docs/superpowers/specs/x.md\n--- a/docs/superpowers/specs/x.md\n+++ b/docs/superpowers/specs/x.md\n@@ -1 +1 @@\n-a\n+b\n";

describe("Orchestrator doc review", () => {
  it("forcePersona forces a review on a doc-only diff and uses that persona", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-doc1-"));
    writeFileSync(join(repo, "x.md"), "x");
    const seen: { persona?: string; prompt?: string } = {};
    const orch = new Orchestrator({
      repoRoot: repo,
      config: defineConfig({ cache: { enabled: false, reviewTtlDays: 7 } }),
      adapters: { codex: recordingStub(seen) },
      sandboxMode: "off",
      hostTier: "opus",
      diff: docDiff,
      reasonOnFailEnabled: true,
      forcePersona: "plan",
    });
    const r = await orch.runIteration({ runId: "RUN", iter: 1 });
    expect(r.verdict).toBe("PASS");
    expect(seen.persona).toBe("plan");
    expect(seen.prompt).toContain("implementation plan");
  });

  it("auto path: docReview-enabled config reviews matching doc-only diff with the configured persona", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-doc2-"));
    writeFileSync(join(repo, "x.md"), "x");
    const seen: { persona?: string; prompt?: string } = {};
    const orch = new Orchestrator({
      repoRoot: repo,
      config: defineConfig({
        cache: { enabled: false, reviewTtlDays: 7 },
        docReview: { enabled: true, globs: ["docs/superpowers/specs/**"], persona: "plan" },
      }),
      adapters: { codex: recordingStub(seen) },
      sandboxMode: "off",
      hostTier: "opus",
      diff: docDiff,
      reasonOnFailEnabled: true,
    });
    await orch.runIteration({ runId: "RUN", iter: 1 });
    expect(seen.persona).toBe("plan");
  });
});
