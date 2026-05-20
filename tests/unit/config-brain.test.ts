// tests/unit/config-brain.test.ts
import { describe, expect, it } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";

describe("brain config", () => {
  it("defaults brain to null (off)", () => {
    expect(defineConfig({}).phases.brain).toBeNull();
  });
  it("accepts a brain block with curator + embeddings", () => {
    const c = defineConfig({
      phases: {
        brain: {
          enabled: true,
          maxPromptTokens: 1500,
          curator: { provider: "claude-code", persona: "curator" },
          embeddings: { provider: "openrouter", model: "qwen/qwen3-embedding-8b" },
          egressAllowlist: ["docs.example.com"],
        },
      },
    } as Parameters<typeof defineConfig>[0]);
    expect(c.phases.brain?.enabled).toBe(true);
    expect(c.phases.brain?.embeddings?.model).toContain("embedding");
  });
});
