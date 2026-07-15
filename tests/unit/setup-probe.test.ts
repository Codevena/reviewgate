import { describe, expect, it } from "bun:test";
import { devNull } from "node:os";
import { probeModel } from "../../src/cli/setup/probe.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";

function fakeAdapter(impl?: ProviderAdapter["complete"]): ProviderAdapter {
  return {
    id: "codex",
    preflight: async () => ({ available: true, version: "x", authMode: "oauth", error: null }),
    review: async () => {
      throw new Error("unused");
    },
    ...(impl ? { complete: impl } : {}),
  };
}

const base = {
  provider: "codex" as const,
  model: "gpt-5.5",
  auth: "oauth" as const,
  timeoutMs: 1000,
};

function reviewResult(status: ReviewResult["status"]): ReviewResult {
  return {
    reviewerId: "setup-probe",
    verdict: status === "ok" ? "PASS" : "ERROR",
    findings: [],
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
    durationMs: 1,
    exitCode: status === "ok" ? 0 : 1,
    rawEventsPath: "",
    rawText: status === "ok" ? '{"verdict":"PASS","findings":[]}' : "",
    status,
    ...(status === "ok" ? {} : { statusDetail: "strict schema rejected" }),
  };
}

describe("probeModel", () => {
  it("ok when complete returns non-empty text", async () => {
    const r = await probeModel(base, { adapter: fakeAdapter(async () => "OK") });
    expect(r.ok).toBe(true);
  });

  it("not ok (empty) when complete returns empty string", async () => {
    const r = await probeModel(base, { adapter: fakeAdapter(async () => "") });
    expect(r.ok).toBe(false);
  });

  it("not ok when complete throws (e.g. ModelNotFoundError)", async () => {
    const r = await probeModel(base, {
      adapter: fakeAdapter(async () => {
        throw new Error("ModelNotFoundError");
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("ModelNotFoundError");
  });

  it("skipped when the adapter has no complete() method", async () => {
    const r = await probeModel(base, { adapter: fakeAdapter() });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe(true);
    expect(r.detail).toContain("no completion API");
  });

  it("forwards baseUrl + apiKeyEnv to complete() (ollama local probe)", async () => {
    let captured: Record<string, unknown> | undefined;
    const r = await probeModel(
      {
        provider: "ollama",
        model: "glm-5.2:cloud",
        auth: "apikey",
        apiKeyEnv: "OLLAMA_API_KEY",
        baseUrl: "http://localhost:11434/v1",
        timeoutMs: 1000,
      },
      {
        adapter: fakeAdapter(async (_prompt, opts) => {
          captured = opts as unknown as Record<string, unknown>;
          return "OK";
        }),
      },
    );
    expect(r.ok).toBe(true);
    expect(captured?.baseUrl).toBe("http://localhost:11434/v1");
    expect(captured?.apiKeyEnv).toBe("OLLAMA_API_KEY");
  });

  it("uses the real strict review path for an OpenRouter reviewer tuple", async () => {
    let reviewInput: Parameters<ProviderAdapter["review"]>[0] | undefined;
    let completeCalls = 0;
    const adapter: ProviderAdapter = {
      id: "openrouter",
      preflight: async () => ({
        available: true,
        version: "v1",
        authMode: "openrouter",
        error: null,
      }),
      async review(input) {
        reviewInput = input;
        return reviewResult("ok");
      },
      async complete() {
        completeCalls++;
        return "OK";
      },
    };
    const route = { only: ["alibaba"] };
    const r = await probeModel(
      {
        provider: "openrouter",
        purpose: "reviewer",
        model: "deepseek/deepseek-v4-flash",
        auth: "openrouter",
        apiKeyEnv: "OPENROUTER_API_KEY",
        openrouterProvider: route,
        timeoutMs: 1234,
      },
      { adapter },
    );

    expect(r.ok).toBe(true);
    expect(completeCalls).toBe(0);
    expect(reviewInput?.cfg.model).toBe("deepseek/deepseek-v4-flash");
    expect(reviewInput?.cfg.openrouterProvider).toEqual(route);
    expect(reviewInput?.cfg.timeoutMs).toBe(1234);
    // Thinking models may spend the first 64 tokens entirely on hidden reasoning;
    // the default must leave enough room for the required schema response.
    expect(reviewInput?.cfg.maxTokens).toBe(256);
    expect(reviewInput?.promptText).toContain("harmless setup capability probe");
    expect(reviewInput?.workingDir).not.toContain(process.cwd());
    expect(reviewInput?.promptFile).toBe(devNull);
    expect(reviewInput?.diffPath).toBe(devNull);
    expect(reviewInput?.findingsPath).toBe(devNull);
  });

  it("fails an OpenRouter strict probe unless review status is ok", async () => {
    const adapter: ProviderAdapter = {
      id: "openrouter",
      preflight: async () => ({
        available: true,
        version: "v1",
        authMode: "openrouter",
        error: null,
      }),
      review: async () => reviewResult("error"),
    };
    const r = await probeModel(
      {
        provider: "openrouter",
        purpose: "fallback",
        model: "m",
        auth: "openrouter",
      },
      { adapter },
    );
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe(false);
    expect(r.detail).toContain("strict schema rejected");
  });

  it("uses free-form complete for an OpenRouter critic and forwards the output cap", async () => {
    let captured: Record<string, unknown> | undefined;
    let reviewCalls = 0;
    const adapter: ProviderAdapter = {
      id: "openrouter",
      preflight: async () => ({
        available: true,
        version: "v1",
        authMode: "openrouter",
        error: null,
      }),
      async review() {
        reviewCalls++;
        return reviewResult("ok");
      },
      async complete(_prompt, opts) {
        captured = opts as unknown as Record<string, unknown>;
        return '{"verdicts":[]}';
      },
    };
    const r = await probeModel(
      {
        provider: "openrouter",
        purpose: "critic",
        model: "m",
        auth: "openrouter",
        openrouterProvider: { only: ["alibaba"] },
        maxTokens: 64,
      },
      { adapter },
    );
    expect(r.ok).toBe(true);
    expect(reviewCalls).toBe(0);
    expect(captured?.maxTokens).toBe(64);
    expect(captured?.openrouterProvider).toEqual({ only: ["alibaba"] });
  });

  it("deduplicates identical successful paid tuples but not a changed route", async () => {
    let calls = 0;
    const adapter: ProviderAdapter = {
      id: "openrouter",
      preflight: async () => ({
        available: true,
        version: "v1",
        authMode: "openrouter",
        error: null,
      }),
      async review() {
        calls++;
        return reviewResult("ok");
      },
    };
    const cache = new Map();
    const input = {
      provider: "openrouter" as const,
      purpose: "reviewer" as const,
      model: "m",
      auth: "openrouter" as const,
      openrouterProvider: { only: ["alibaba"] },
    };
    expect((await probeModel(input, { adapter, cache })).ok).toBe(true);
    expect((await probeModel(input, { adapter, cache })).ok).toBe(true);
    expect(
      (
        await probeModel(
          { ...input, openrouterProvider: { only: ["deepseek"] } },
          { adapter, cache },
        )
      ).ok,
    ).toBe(true);
    expect(calls).toBe(2);
  });
});
