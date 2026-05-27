import { describe, expect, it } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";

describe("docReview.referencedFilesBudgetBytes", () => {
  it("defaults to 32000", () => {
    expect(defineConfig({}).docReview.referencedFilesBudgetBytes).toBe(32_000);
  });
  it("accepts an override", () => {
    expect(
      defineConfig({
        docReview: {
          enabled: true,
          globs: ["docs/**"],
          persona: "plan",
          referencedFilesBudgetBytes: 8000,
        },
      }).docReview.referencedFilesBudgetBytes,
    ).toBe(8000);
  });
});
