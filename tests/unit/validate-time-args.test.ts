// tests/unit/validate-time-args.test.ts
import { describe, expect, it } from "bun:test";
import { validateSince, validateWeek } from "../../src/cli/validate-time-args.ts";

describe("validateSince", () => {
  it("accepts a valid ISO date (returns null)", () => {
    expect(validateSince("2026-05-01")).toBeNull();
    expect(validateSince("2026-05-01T00:00:00Z")).toBeNull();
  });

  it("returns an actionable message naming the expected format on garbage", () => {
    const msg = validateSince("yesterday");
    expect(msg).not.toBeNull();
    expect(msg).toContain("yesterday");
    expect(msg).toContain("--since");
    // names a concrete expected format rather than dumping a stack trace
    expect(msg).toMatch(/ISO|\d{4}-\d{2}-\d{2}/);
  });
});

describe("validateWeek", () => {
  it("accepts a valid ISO week string (returns null)", () => {
    expect(validateWeek("2026-W12")).toBeNull();
  });

  it("returns an actionable message naming YYYY-Www on garbage", () => {
    const msg = validateWeek("not-a-week");
    expect(msg).not.toBeNull();
    expect(msg).toContain("not-a-week");
    expect(msg).toContain("--week");
    expect(msg).toContain("YYYY-Www");
  });

  it("returns a message for an out-of-range week", () => {
    expect(validateWeek("2026-W99")).not.toBeNull();
  });
});
