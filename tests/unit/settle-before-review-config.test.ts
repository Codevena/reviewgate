// tests/unit/settle-before-review-config.test.ts
import { describe, expect, it } from "bun:test";
import { defaultConfig } from "../../src/config/defaults.ts";
import { defineConfig } from "../../src/config/define-config.ts";

describe("#7 settleBeforeReview config", () => {
  it("defaults to true in defaultConfig", () => {
    expect(defaultConfig.phases.review.settleBeforeReview).toBe(true);
  });

  it("re-defaults to true when omitted from a user config (deepMerge with defaults)", () => {
    const parsed = defineConfig({
      phases: { review: { reviewers: [{ provider: "codex", persona: "security" }] } },
    });
    expect(parsed.phases.review.settleBeforeReview).toBe(true);
  });
});
