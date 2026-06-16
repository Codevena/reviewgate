// tests/unit/provider-precision-config.test.ts
import { describe, expect, it } from "bun:test";
import { defaultConfig } from "../../src/config/defaults.ts";
import { defineConfig } from "../../src/config/define-config.ts";

describe("#8 providerPrecisionContext config", () => {
  it("defaults to true in defaultConfig", () => {
    expect(defaultConfig.phases.review.providerPrecisionContext).toBe(true);
  });

  it("re-defaults to true when omitted from a user config", () => {
    const parsed = defineConfig({
      phases: { review: { reviewers: [{ provider: "codex", persona: "security" }] } },
    });
    expect(parsed.phases.review.providerPrecisionContext).toBe(true);
  });
});
