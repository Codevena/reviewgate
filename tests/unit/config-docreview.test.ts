import { describe, expect, it } from "bun:test";
import { defaultConfig } from "../../src/config/defaults.ts";
import { defineConfig } from "../../src/config/define-config.ts";

describe("docReview config", () => {
  it("defaults to ENABLED with a plan persona and non-empty (plan/spec-scoped) globs", () => {
    expect(defaultConfig.docReview.enabled).toBe(true);
    expect(defaultConfig.docReview.persona).toBe("plan");
    expect(defaultConfig.docReview.globs.length).toBeGreaterThan(0);
  });

  it("parses and lets a user enable it via defineConfig", () => {
    const cfg = defineConfig({ docReview: { enabled: true, globs: ["docs/**"], persona: "plan" } });
    expect(cfg.docReview.enabled).toBe(true);
    expect(cfg.docReview.globs).toEqual(["docs/**"]);
  });

  it("applies the schema default (enabled) when the user omits docReview", () => {
    const cfg = defineConfig({});
    expect(cfg.docReview.enabled).toBe(true);
    expect(cfg.docReview.persona).toBe("plan");
  });

  it("lets a user opt OUT explicitly", () => {
    const cfg = defineConfig({
      docReview: { enabled: false, globs: ["docs/**"], persona: "plan" },
    });
    expect(cfg.docReview.enabled).toBe(false);
  });
});
