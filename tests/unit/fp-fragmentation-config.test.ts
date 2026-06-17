// tests/unit/fp-fragmentation-config.test.ts
import { describe, expect, it } from "bun:test";
import { defaultConfig } from "../../src/config/defaults.ts";
import { defineConfig } from "../../src/config/define-config.ts";

describe("#4 fpFragmentationHint config", () => {
  it("defaults to true in defaultConfig", () => {
    expect(defaultConfig.phases.review.fpFragmentationHint).toBe(true);
  });

  it("re-defaults to true when omitted from a user config (deepMerge)", () => {
    const parsed = defineConfig({
      phases: { review: { reviewers: [{ provider: "codex", persona: "security" }] } },
    });
    expect(parsed.phases.review.fpFragmentationHint).toBe(true);
  });
});
