import { describe, expect, it } from "bun:test";
import { reviewersEnabledCheck } from "../../src/cli/commands/doctor.ts";
import { defineConfig } from "../../src/config/define-config.ts";

describe("reviewersEnabledCheck", () => {
  it("ok when every configured reviewer is enabled in providers (codex default)", () => {
    const c = reviewersEnabledCheck(defineConfig({}));
    expect(c.status).toBe("ok");
  });

  it("warns when a configured reviewer is NOT enabled in providers", () => {
    const cfg = defineConfig({
      phases: { review: { reviewers: [{ provider: "gemini", persona: "security" }] } },
    } as Parameters<typeof defineConfig>[0]);
    const c = reviewersEnabledCheck(cfg);
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("gemini");
    expect(c.hint).toContain("enabled");
  });

  it("lists each distinct unenabled provider once", () => {
    const cfg = defineConfig({
      phases: {
        review: {
          reviewers: [
            { provider: "gemini", persona: "security" },
            { provider: "gemini", persona: "architecture" },
            { provider: "claude-code", persona: "security" },
          ],
        },
      },
    } as Parameters<typeof defineConfig>[0]);
    const c = reviewersEnabledCheck(cfg);
    expect(c.status).toBe("warn");
    expect(c.detail).toContain("gemini");
    expect(c.detail).toContain("claude-code");
    // gemini appears once, not twice
    expect(c.detail.match(/gemini/g)?.length).toBe(1);
  });
});
