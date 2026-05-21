import { describe, expect, it } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";

describe("config scopeToDiff", () => {
  it("defaults scopeToDiff to true", () => {
    expect(defineConfig({}).phases.review.scopeToDiff).toBe(true);
  });

  it("honors an explicit false", () => {
    const c = defineConfig({
      phases: {
        review: {
          reviewers: [{ provider: "codex", persona: "security" }],
          scopeToDiff: false,
        },
      },
    } as Parameters<typeof defineConfig>[0]);
    expect(c.phases.review.scopeToDiff).toBe(false);
  });
});
