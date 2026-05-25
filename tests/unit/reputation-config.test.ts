import { describe, expect, it } from "bun:test";
import { defaultConfig } from "../../src/config/defaults.ts";
import { ConfigSchema } from "../../src/config/define-config.ts";

describe("phases.reputation config", () => {
  it("is enabled by default with the spec's defaults", () => {
    expect(defaultConfig.phases.reputation).toEqual({
      enabled: true,
      minSamples: 8,
      trustFloor: 0.35,
      halfLifeDays: 45,
    });
  });
  it("validates and is overridable", () => {
    const parsed = ConfigSchema.parse({
      ...defaultConfig,
      phases: { ...defaultConfig.phases, reputation: { enabled: false } },
    });
    expect(parsed.phases.reputation.enabled).toBe(false);
    expect(parsed.phases.reputation.minSamples).toBe(8);
  });
});
