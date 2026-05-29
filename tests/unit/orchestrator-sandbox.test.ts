// tests/unit/orchestrator-sandbox.test.ts
// Sandbox wiring: when sandboxMode !== "off" the orchestrator builds a per-reviewer
// SandboxProfile and forwards { profile, mode } to each adapter's review() (instead
// of the old blanket "refuse → ERROR" behavior). strict + isolation-unavailable
// still fails closed for that reviewer; permissive runs the panel.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import type {
  ProviderAdapter,
  ReviewInput,
  ReviewResult,
} from "../../src/providers/adapter-base.ts";
import { SandboxUnavailableError } from "../../src/sandbox/errors.ts";

const DIFF = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n";

function makeConfig() {
  return {
    ...defaultConfig,
    phases: {
      review: {
        reviewers: [{ provider: "codex" as const, persona: "security" }],
      },
      critic: null,
      triage: null,
    },
  };
}

function makeOrch(
  repo: string,
  adapters: Record<string, ProviderAdapter>,
  sandboxMode: "strict" | "permissive" | "off",
) {
  return new Orchestrator({
    repoRoot: repo,
    // biome-ignore lint/suspicious/noExplicitAny: test config shape
    config: makeConfig() as any,
    adapters,
    sandboxMode,
    hostTier: "opus",
    diff: DIFF,
    reasonOnFailEnabled: true,
    providerAvailable: (id) => Boolean(adapters[id]),
  });
}

describe("Orchestrator sandbox wiring", () => {
  it("permissive: reviews (NOT ERROR) and passes a defined sandbox profile to the adapter", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-sbx-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    let calls = 0;
    let received: ReviewInput["sandbox"];
    const stub: ProviderAdapter = {
      id: "codex",
      async preflight() {
        return { available: true, version: "x", authMode: "oauth", error: null };
      },
      async review(inp) {
        calls += 1;
        received = inp.sandbox;
        return {
          reviewerId: inp.reviewerId,
          verdict: "PASS",
          findings: [],
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
          durationMs: 1,
          exitCode: 0,
          rawEventsPath: "",
          rawText: "",
          status: "ok",
        } satisfies ReviewResult;
      },
    };
    const result = await makeOrch(repo, { codex: stub }, "permissive").runIteration({
      runId: "RUN",
      iter: 1,
    });
    // Pre-change this was ALWAYS "ERROR" for mode !== "off". Now it reviews.
    expect(result.verdict).not.toBe("ERROR");
    expect(calls).toBe(1);
    expect(received).toBeDefined();
    expect(received?.mode).toBe("permissive");
    expect(received?.profile.sandboxRequested).toBe(true);
    expect(received?.profile.fs.readAllow).toContain(repo);
  });

  it("strict + isolation-unavailable: that reviewer fails closed (ERROR), never silent PASS", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-sbx-strict-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const stub: ProviderAdapter = {
      id: "codex",
      async preflight() {
        return { available: true, version: "x", authMode: "oauth", error: null };
      },
      async review() {
        // Mirror spawnSafely under strict + sandbox-exec unavailable.
        throw new SandboxUnavailableError("sandbox-exec unavailable on this host");
      },
    };
    const result = await makeOrch(repo, { codex: stub }, "strict").runIteration({
      runId: "RUN",
      iter: 1,
    });
    expect(result.verdict).toBe("ERROR");
    const report = JSON.parse(readFileSync(join(repo, ".reviewgate", "pending.json"), "utf8")) as {
      reviewers: Array<{ status: string; status_detail?: string }>;
    };
    expect(report.reviewers[0]?.status).toBe("error");
    expect(report.reviewers[0]?.status_detail ?? "").toContain("sandbox strict unavailable");
  });
});
