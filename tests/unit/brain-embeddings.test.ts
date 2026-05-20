// tests/unit/brain-embeddings.test.ts
import { describe, expect, it } from "bun:test";
import { cosineSimilarity } from "../../src/core/brain/embeddings.ts";
import { OpenRouterAdapter } from "../../src/providers/openrouter.ts";

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
  });

  it("returns -1.0 for opposite vectors", () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
  });

  it("handles arbitrary float vectors", () => {
    const a = [0.1, 0.2, 0.3];
    const b = [0.3, 0.2, 0.1];
    const result = cosineSimilarity(a, b);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
  });

  it("throws when lengths differ", () => {
    expect(() => cosineSimilarity([1, 2], [1])).toThrow();
  });

  it("throws for zero-length vectors", () => {
    expect(() => cosineSimilarity([], [])).toThrow();
  });
});

describe("OpenRouterAdapter.embed (mocked fetch)", () => {
  function makeEmbedFetch(vector: number[]): typeof fetch {
    return (async () =>
      new Response(
        JSON.stringify({
          data: [{ embedding: vector, index: 0 }],
          model: "text-embedding-3-small",
          usage: { prompt_tokens: 5, total_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
  }

  it("returns the embedding vector from the API response", async () => {
    const expected = [0.1, 0.2, 0.3];
    const adapter = new OpenRouterAdapter({ fetchImpl: makeEmbedFetch(expected) });
    process.env.OPENROUTER_API_KEY = "test-key";
    const result = await adapter.embed("hello world", {
      apiKeyEnv: "OPENROUTER_API_KEY",
      model: "text-embedding-3-small",
    });
    expect(result).toEqual(expected);
  });

  it("throws when the API key is missing", async () => {
    const adapter = new OpenRouterAdapter({ fetchImpl: makeEmbedFetch([]) });
    process.env.OPENROUTER_API_KEY = "";
    await expect(
      adapter.embed("hello", { apiKeyEnv: "OPENROUTER_API_KEY", model: "text-embedding-3-small" }),
    ).rejects.toThrow();
  });

  it("throws when the response contains an empty embedding", async () => {
    const adapter = new OpenRouterAdapter({ fetchImpl: makeEmbedFetch([]) });
    process.env.OPENROUTER_API_KEY = "test-key";
    await expect(
      adapter.embed("hello", { apiKeyEnv: "OPENROUTER_API_KEY", model: "text-embedding-3-small" }),
    ).rejects.toThrow();
  });

  it("throws when the response data array is missing", async () => {
    const badFetch = (async () =>
      new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const adapter = new OpenRouterAdapter({ fetchImpl: badFetch });
    process.env.OPENROUTER_API_KEY = "test-key";
    await expect(
      adapter.embed("hello", { apiKeyEnv: "OPENROUTER_API_KEY", model: "text-embedding-3-small" }),
    ).rejects.toThrow();
  });
});
