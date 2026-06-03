import { describe, expect, it } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";

describe("default OpenRouter config", () => {
  it("defaults the model to the cheaper deepseek-v4-flash", () => {
    expect(defineConfig({}).providers.openrouter?.model).toBe("deepseek/deepseek-v4-flash");
  });

  // The upstream pin is MODEL-COUPLED and must NOT live in defaults: defineConfig
  // deep-merges defaults UNDER the user config, so a default pin would leak onto a
  // user's overridden model (e.g. wizard "auto-route", a non-deepseek model) and
  // mis-route it. The pin lives in the explicit configs that also set the model
  // (init scaffold — see init.test.ts — and reviewgate.config.ts).
  it("does NOT pin an upstream in defaults (so a model override is never mis-pinned)", () => {
    expect(defineConfig({}).providers.openrouter?.openrouterProvider).toBeUndefined();
  });

  it("preserves auto-route: an overridden model with no pin stays un-pinned", () => {
    const cfg = defineConfig({
      providers: { openrouter: { enabled: true, model: "some/other-model" } },
    } as Parameters<typeof defineConfig>[0]);
    expect(cfg.providers.openrouter?.openrouterProvider).toBeUndefined();
  });
});
