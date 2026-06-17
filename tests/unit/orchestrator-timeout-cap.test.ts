// tests/unit/orchestrator-timeout-cap.test.ts
// #7 (field report 2026-06-17): a small low-risk diff clamps each reviewer's per-run timeout
// to the conservative triage cap; a large diff keeps the provider's full timeout. The full
// panel still runs (no reviewer dropped).
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import { SMALL_DIFF_REVIEWER_TIMEOUT_MS } from "../../src/triage/matrix.ts";

const SMALL_DIFF =
  "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";
const BIG_DIFF = `diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1,40 @@\n-a\n${Array.from(
  { length: 40 },
  (_, i) => `+line${i}`,
).join("\n")}\n`;

function capturingStub(seen: { timeoutMs?: number }): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "x", authMode: "oauth", error: null };
    },
    async review(inp): Promise<ReviewResult> {
      seen.timeoutMs = inp.cfg.timeoutMs;
      return {
        reviewerId: inp.reviewerId,
        verdict: "PASS",
        findings: [],
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

function configFor() {
  return {
    ...defaultConfig,
    providers: {
      ...defaultConfig.providers,
      codex: { ...defaultConfig.providers.codex, timeoutMs: 300_000 },
    },
    phases: {
      ...defaultConfig.phases,
      review: { reviewers: [{ provider: "codex" as const, persona: "security" }] },
      critic: null,
      triage: null,
    },
  };
}

async function runWith(diff: string): Promise<number | undefined> {
  const repo = mkdtempSync(join(tmpdir(), "rg-tcap-"));
  writeFileSync(join(repo, "foo.ts"), "x");
  const seen: { timeoutMs?: number } = {};
  const orch = new Orchestrator({
    repoRoot: repo,
    config: configFor(),
    adapters: { codex: capturingStub(seen) },
    sandboxMode: "off",
    hostTier: "opus",
    diff,
    reasonOnFailEnabled: true,
  });
  await orch.runIteration({ runId: "RUN", iter: 1 });
  return seen.timeoutMs;
}

describe("Orchestrator — size-aware reviewer timeout cap (#7)", () => {
  it("clamps a small diff's reviewer timeout to the conservative cap", async () => {
    expect(await runWith(SMALL_DIFF)).toBe(SMALL_DIFF_REVIEWER_TIMEOUT_MS);
  });

  it("leaves a large diff's reviewer timeout at the provider's full value", async () => {
    expect(await runWith(BIG_DIFF)).toBe(300_000);
  });

  it("a cap-imposed timeout on a small diff does NOT cool down the reviewer (carve-out)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-tcap-nocool-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const timingOutStub: ProviderAdapter = {
      id: "codex",
      async preflight() {
        return { available: true, version: "x", authMode: "oauth", error: null };
      },
      async review(inp): Promise<ReviewResult> {
        return {
          reviewerId: inp.reviewerId,
          verdict: "ERROR",
          findings: [],
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
          durationMs: inp.cfg.timeoutMs ?? 0,
          exitCode: 1,
          rawEventsPath: "",
          status: "timeout",
        };
      },
    };
    const orch = new Orchestrator({
      repoRoot: repo,
      config: configFor(),
      adapters: { codex: timingOutStub },
      sandboxMode: "off",
      hostTier: "opus",
      diff: SMALL_DIFF, // triage cap active → a timeout here is gate-imposed, not provider fault
      reasonOnFailEnabled: true,
    });
    await orch.runIteration({ runId: "RUN", iter: 1 });
    const cdPath = join(repo, ".reviewgate", "quota-cooldowns.json");
    const codexEntry = existsSync(cdPath)
      ? JSON.parse(readFileSync(cdPath, "utf8")).providers?.codex
      : undefined;
    expect(codexEntry).toBeUndefined();
  });
});
