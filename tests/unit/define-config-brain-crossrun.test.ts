import { describe, expect, it } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";

describe("brain.crossRunCandidates", () => {
  it("defaults to enabled=true, ttlDays=60, maxEntries=5000 when brain is set", () => {
    const cfg = defineConfig({
      phases: {
        brain: {
          enabled: true,
          maxPromptTokens: 1500,
          embeddings: { provider: "openrouter", model: "x", apiKeyEnv: "X" },
        },
      },
    } as Parameters<typeof defineConfig>[0]);
    expect(cfg.phases.brain?.crossRunCandidates?.enabled).toBe(true);
    expect(cfg.phases.brain?.crossRunCandidates?.ttlDays).toBe(60);
    expect(cfg.phases.brain?.crossRunCandidates?.maxEntries).toBe(5000);
  });
});
