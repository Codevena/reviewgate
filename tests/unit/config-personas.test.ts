import { describe, expect, it } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";

describe("phases.review.personas config", () => {
  it("accepts a personas override map", () => {
    const c = defineConfig({
      phases: { review: { personas: { security: "custom" } } },
    } as Parameters<typeof defineConfig>[0]);
    expect(c.phases.review.personas?.security).toBe("custom");
  });
  it("defaults to undefined (no override)", () => {
    const c = defineConfig({} as Parameters<typeof defineConfig>[0]);
    expect(c.phases.review.personas).toBeUndefined();
  });
});
