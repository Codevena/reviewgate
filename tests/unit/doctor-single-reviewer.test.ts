import { describe, expect, it } from "bun:test";
import { singleReviewerCheck } from "../../src/cli/commands/doctor.ts";
import { defineConfig } from "../../src/config/define-config.ts";

describe("singleReviewerCheck", () => {
  it("warns on the default single-reviewer config (codex only)", () => {
    const c = singleReviewerCheck(defineConfig({}));
    expect(c).not.toBeNull();
    expect(c?.status).toBe("warn");
    // names the inert suppression layers so the cause is actionable
    expect(c?.detail).toContain("consensus");
    expect(c?.detail).toContain("codex");
    expect(c?.hint).toContain("2nd");
  });

  it("is silent (null) when two providers are enabled as reviewers", () => {
    const cfg = defineConfig({
      phases: {
        review: {
          reviewers: [
            { provider: "codex", persona: "security" },
            { provider: "gemini", persona: "architecture" },
          ],
        },
      },
      providers: { gemini: { enabled: true } },
    } as Parameters<typeof defineConfig>[0]);
    expect(singleReviewerCheck(cfg)).toBeNull();
  });

  it("is silent (null) when zero reviewers are enabled (reviewersEnabledCheck owns that ERROR)", () => {
    const cfg = defineConfig({
      phases: { review: { reviewers: [{ provider: "gemini", persona: "security" }] } },
    } as Parameters<typeof defineConfig>[0]);
    // gemini is not enabled by default → 0 effective reviewers
    expect(singleReviewerCheck(cfg)).toBeNull();
  });
});
