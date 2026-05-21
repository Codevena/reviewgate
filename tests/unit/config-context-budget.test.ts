import { describe, expect, it } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";

describe("fileContextBudgetBytes config", () => {
  it("defaults to 32000", () => {
    expect(defineConfig({}).phases.review.fileContextBudgetBytes).toBe(32_000);
  });

  it("accepts an override", () => {
    const c = defineConfig({
      phases: {
        review: {
          reviewers: [{ provider: "codex", persona: "security" }],
          fileContextBudgetBytes: 16_000,
        },
      },
    } as Parameters<typeof defineConfig>[0]);
    expect(c.phases.review.fileContextBudgetBytes).toBe(16_000);
  });
});
