// tests/unit/orchestrator-collaborator-context.test.ts
// N5: with phases.review.collaboratorContext enabled, the reviewer prompt must carry
// the source of a relatively-imported, UNCHANGED collaborator so a premise about an
// imported symbol can be verified instead of guessed. OFF by default → no section.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "../../src/config/define-config.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";

function recordingStub(seen: { prompt?: string }): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp) {
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

const diff = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "rg-collab-orch-"));
  // foo.ts (changed) imports bar.ts (UNCHANGED) — bar carries the premise marker.
  writeFileSync(join(repo, "foo.ts"), "import { bar } from './bar';\nexport const x = bar;\n");
  writeFileSync(join(repo, "bar.ts"), "export const bar = 'FLEX_FLEX_COL_MARKER';\n");
  return repo;
}

function orch(repo: string, seen: { prompt?: string }, enabled: boolean) {
  return new Orchestrator({
    repoRoot: repo,
    config: defineConfig({
      cache: { enabled: false, reviewTtlDays: 7 },
      phases: {
        triage: null,
        review: enabled ? { collaboratorContext: { enabled: true } } : {},
      },
    }),
    adapters: { codex: recordingStub(seen) },
    sandboxMode: "off",
    hostTier: "opus",
    diff,
    reasonOnFailEnabled: true,
  });
}

describe("Orchestrator collaborator context (N5)", () => {
  it("injects the imported collaborator's source when enabled", async () => {
    const repo = makeRepo();
    const seen: { prompt?: string } = {};
    await orch(repo, seen, true).runIteration({ runId: "RUN", iter: 1 });
    const prompt = seen.prompt ?? "";
    expect(prompt).toContain("Imported collaborators");
    expect(prompt).toContain("FLEX_FLEX_COL_MARKER"); // bar.ts source (unchanged) is present
  });

  it("omits the collaborator section when disabled (default)", async () => {
    const repo = makeRepo();
    const seen: { prompt?: string } = {};
    await orch(repo, seen, false).runIteration({ runId: "RUN", iter: 1 });
    const prompt = seen.prompt ?? "";
    expect(prompt).not.toContain("Imported collaborators");
    expect(prompt).not.toContain("FLEX_FLEX_COL_MARKER");
  });
});
