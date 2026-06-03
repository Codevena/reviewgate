import { describe, expect, it } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";

describe("config confidenceFloor", () => {
  it("defaults confidenceFloor to 0.6 (S0: single-reviewer noise reduction)", () => {
    expect(defineConfig({}).phases.review.confidenceFloor).toBe(0.6);
  });

  it("honors an explicit override", () => {
    const c = defineConfig({
      phases: {
        review: {
          reviewers: [{ provider: "codex", persona: "security" }],
          confidenceFloor: 0.2,
        },
      },
    } as Parameters<typeof defineConfig>[0]);
    expect(c.phases.review.confidenceFloor).toBe(0.2);
  });
});
