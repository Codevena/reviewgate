// tests/unit/orchestrator-fallback.test.ts
// Failover routing: when the primary reviewer produces a non-ok result
// (quota-exhausted, timeout, or error) and the slot declares a `fallback`
// chain, the orchestrator re-runs the SAME persona on the first available
// fallback provider that returns "ok".
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
        model: "gemini-3.5-flash",
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
  signal?: AbortSignal,
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
  await orch.runIteration({ runId: "RUN", iter: 1, ...(signal ? { signal } : {}) });
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

  // Updated: failover now triggers on ANY non-ok primary status (not only quota).
  // A primary that errors should also try its declared fallback chain.
  it("DOES fail over on a plain error (any non-ok status now triggers failover)", async () => {
    const report = await runWith(makeConfig(["gemini"]), {
      codex: fixedStatus("codex", "error"),
      gemini: fixedStatus("gemini", "ok"),
    });
    // Failover happened — gemini result is recorded, not the errored codex.
    expect(report.reviewers[0].provider).toBe("gemini");
    expect(report.reviewers[0].status).toBe("ok");
    expect(report.reviewers[0].status_detail).toContain("fallback from codex");
  });

  it("does NOT walk the fallback chain when the run is deadline-aborted mid-review (F-045)", async () => {
    // A self-deadline abort tears down the whole run — every fallback would be
    // instantly aborted too, wasting subprocess spawns and muddying statusDetail.
    // Simulate the deadline firing DURING the primary review: the primary aborts
    // the signal and returns non-ok; the failover loop must then NOT walk the chain.
    const ac = new AbortController();
    const codexAborts: ProviderAdapter = {
      id: "codex",
      async preflight() {
        return { available: true, version: "x", authMode: "oauth", error: null };
      },
      async review(inp) {
        ac.abort(); // the self-deadline fires mid-review
        return {
          reviewerId: inp.reviewerId,
          verdict: "ERROR",
          findings: [],
          usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
          durationMs: 1,
          exitCode: 1,
          rawEventsPath: "",
          rawText: "",
          status: "error",
          statusDetail: "deadline-aborted",
        };
      },
    };
    // Spy: did the fallback's review() actually get invoked?
    let geminiCalled = false;
    const geminiSpy: ProviderAdapter = {
      id: "gemini",
      async preflight() {
        return { available: true, version: "x", authMode: "oauth", error: null };
      },
      async review(inp) {
        geminiCalled = true;
        return { ...(await fixedStatus("gemini", "ok").review(inp)) };
      },
    };
    const repo = mkdtempSync(join(tmpdir(), "rg-fb-abort-"));
    writeFileSync(join(repo, "foo.ts"), "x");
    const orch = new Orchestrator({
      repoRoot: repo,
      // biome-ignore lint/suspicious/noExplicitAny: test config shape
      config: makeConfig(["gemini"]) as any,
      adapters: { codex: codexAborts, gemini: geminiSpy },
      sandboxMode: "off",
      hostTier: "opus",
      diff: DIFF,
      reasonOnFailEnabled: true,
      providerAvailable: (id) => id === "codex" || id === "gemini",
    });
    // runIteration legitimately throws once the deadline-aborted signal trips a
    // later throwIfAborted (the real LoopDriver catches this). The point is the
    // fallback must NOT have been spawned during the panel's failover loop.
    await orch.runIteration({ runId: "RUN", iter: 1, signal: ac.signal }).catch(() => undefined);
    expect(geminiCalled).toBe(false); // fallback chain was NOT walked on abort
  });

  it("keeps the quota-exhausted result when no fallback chain is declared", async () => {
    const report = await runWith(makeConfig(undefined), {
      codex: fixedStatus("codex", "quota-exhausted"),
      gemini: fixedStatus("gemini", "ok"),
    });
    expect(report.reviewers[0].provider).toBe("codex");
    expect(report.reviewers[0].status).toBe("quota-exhausted");
  });

  // Step B — NEW: primary timeout triggers failover
  it("fails over to opencode when claude-code times out", async () => {
    const config = {
      ...makeConfig(),
      providers: {
        ...defaultConfig.providers,
        "claude-code": {
          enabled: true as true,
          auth: "oauth" as const,
          model: "claude-sonnet-4-6",
          timeoutMs: 1000,
        },
        opencode: { enabled: false, auth: "oauth" as const, model: "default", timeoutMs: 1000 },
      },
      phases: {
        review: {
          reviewers: [
            {
              provider: "claude-code" as const,
              persona: "security" as const,
              fallback: ["opencode" as const],
            },
          ],
        },
        critic: null,
        triage: null,
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: test config override — enabled:true vs enabled:false literal conflict
    const report = await runWith(config as any, {
      "claude-code": fixedStatus("claude-code", "timeout"),
      opencode: fixedStatus("opencode", "ok"),
    });
    expect(report.reviewers[0].provider).toBe("opencode");
    expect(report.reviewers[0].status).toBe("ok");
    expect(report.reviewers[0].status_detail).toContain("fallback from claude-code");
    expect(report.reviewers[0].status_detail).toContain("timeout");
  });

  // Step B — NEW: primary error triggers failover
  it("fails over to opencode when claude-code returns error", async () => {
    const config = {
      ...makeConfig(),
      providers: {
        ...defaultConfig.providers,
        "claude-code": {
          enabled: true as true,
          auth: "oauth" as const,
          model: "claude-sonnet-4-6",
          timeoutMs: 1000,
        },
        opencode: { enabled: false, auth: "oauth" as const, model: "default", timeoutMs: 1000 },
      },
      phases: {
        review: {
          reviewers: [
            {
              provider: "claude-code" as const,
              persona: "security" as const,
              fallback: ["opencode" as const],
            },
          ],
        },
        critic: null,
        triage: null,
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: test config override — enabled:true vs enabled:false literal conflict
    const report = await runWith(config as any, {
      "claude-code": fixedStatus("claude-code", "error"),
      opencode: fixedStatus("opencode", "ok"),
    });
    expect(report.reviewers[0].provider).toBe("opencode");
    expect(report.reviewers[0].status).toBe("ok");
    expect(report.reviewers[0].status_detail).toContain("fallback from claude-code");
    expect(report.reviewers[0].status_detail).toContain("error");
  });

  // Step B — NEW: when a fallback also fails, walk to the next one
  it("continues to the next fallback when an intermediate fallback also fails", async () => {
    const config = {
      ...makeConfig(),
      providers: {
        ...defaultConfig.providers,
        "claude-code": {
          enabled: true as true,
          auth: "oauth" as const,
          model: "claude-sonnet-4-6",
          timeoutMs: 1000,
        },
        opencode: { enabled: false, auth: "oauth" as const, model: "default", timeoutMs: 1000 },
      },
      phases: {
        review: {
          reviewers: [
            {
              provider: "claude-code" as const,
              persona: "security" as const,
              fallback: ["opencode" as const, "codex" as const],
            },
          ],
        },
        critic: null,
        triage: null,
      },
    };
    // biome-ignore lint/suspicious/noExplicitAny: test config override — enabled:true vs enabled:false literal conflict
    const report = await runWith(config as any, {
      "claude-code": fixedStatus("claude-code", "timeout"),
      opencode: fixedStatus("opencode", "error"),
      codex: fixedStatus("codex", "ok"),
    });
    // Walked past opencode (error) to codex (ok).
    // statusDetail records the IMMEDIATE predecessor in the chain (opencode failed,
    // so codex's annotation says "fallback from opencode").
    expect(report.reviewers[0].provider).toBe("codex");
    expect(report.reviewers[0].status).toBe("ok");
    expect(report.reviewers[0].status_detail).toContain("fallback from opencode");
  });
});
