import { describe, expect, it } from "bun:test";
import { defineConfig } from "../../src/config/define-config.ts";
import { renderHouseRules } from "../../src/core/house-rules.ts";

describe("config houseRules", () => {
  it("defaults to an empty list", () => {
    expect(defineConfig({}).phases.review.houseRules).toEqual([]);
  });

  it("preserves maintainer-set rules", () => {
    const c = defineConfig({
      phases: { review: { reviewers: [{ provider: "codex", persona: "security" }], houseRules: ["uses hex tokens"] } },
    } as Parameters<typeof defineConfig>[0]);
    expect(c.phases.review.houseRules).toEqual(["uses hex tokens"]);
  });
});

describe("renderHouseRules", () => {
  it("returns empty string for no rules", () => {
    expect(renderHouseRules([])).toBe("");
  });

  it("ignores blank / whitespace-only rules", () => {
    expect(renderHouseRules(["   ", ""])).toBe("");
  });

  it("renders rules as a trusted, authoritative section", () => {
    const out = renderHouseRules([
      "This repo uses hex color tokens (e.g. #F5F1EB), NOT shadcn HSL tuples — never flag a hex value as a missing HSL wrapper.",
    ]);
    expect(out).toContain("house rules");
    expect(out.toUpperCase()).toContain("TRUSTED");
    expect(out).toContain("hex color tokens");
    // instructs the reviewer to treat them as ground truth
    expect(out.toLowerCase()).toContain("never raise a finding that contradicts");
  });

  it("lists each rule as a bullet, trimming whitespace", () => {
    const out = renderHouseRules(["  rule one  ", "rule two"]);
    expect(out).toContain("- rule one");
    expect(out).toContain("- rule two");
  });
});
