import { describe, expect, it } from "bun:test";
import { defaultConfig } from "../../src/config/defaults.ts";
import { defineConfig } from "../../src/config/define-config.ts";

describe("phases.implicitOutcomes config", () => {
  it("defaults to enabled with cap 5000", () => {
    expect(defaultConfig.phases.implicitOutcomes).toEqual({ enabled: true, cap: 5000 });
  });
  it("accepts an override", () => {
    const parsed = defineConfig({
      phases: { implicitOutcomes: { enabled: false, cap: 100 } },
    } as Parameters<typeof defineConfig>[0]);
    expect(parsed.phases.implicitOutcomes).toEqual({ enabled: false, cap: 100 });
  });
});
