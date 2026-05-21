import { describe, expect, it } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";
import { defaultConfig } from "../../src/config/defaults.ts";

describe("docReview config", () => {
  it("defaults to disabled with a plan persona and non-empty globs", () => {
    expect(defaultConfig.docReview.enabled).toBe(false);
    expect(defaultConfig.docReview.persona).toBe("plan");
    expect(defaultConfig.docReview.globs.length).toBeGreaterThan(0);
  });

  it("parses and lets a user enable it via defineConfig", () => {
    const cfg = defineConfig({ docReview: { enabled: true, globs: ["docs/**"], persona: "plan" } });
    expect(cfg.docReview.enabled).toBe(true);
    expect(cfg.docReview.globs).toEqual(["docs/**"]);
  });

  it("applies the schema default when the user omits docReview", () => {
    const cfg = defineConfig({});
    expect(cfg.docReview.enabled).toBe(false);
    expect(cfg.docReview.persona).toBe("plan");
  });
});
