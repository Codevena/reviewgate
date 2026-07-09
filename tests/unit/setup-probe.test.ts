import { describe, expect, it } from "bun:test";
import { probeModel } from "../../src/cli/setup/probe.ts";
import type { ProviderAdapter } from "../../src/providers/adapter-base.ts";

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
});
