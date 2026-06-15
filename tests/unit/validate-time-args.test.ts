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

  it("accepts a valid ISO date-time with a non-UTC offset (must not be rejected)", () => {
    expect(validateSince("2026-05-01T23:00:00-05:00")).toBeNull();
    expect(validateSince("2026-05-01T12:00:00.500Z")).toBeNull();
  });

  it("rejects ambiguous, locale-dependent date strings (wrong-window risk)", () => {
    // "05/01/2026" is May 1st or Jan 5th depending on locale — new Date() would
    // silently parse it into the WRONG window. Must be rejected.
    expect(validateSince("05/01/2026")).not.toBeNull();
    expect(validateSince("May 1, 2026")).not.toBeNull();
    expect(validateSince("2026/05/01")).not.toBeNull();
    expect(validateSince("1714521600")).not.toBeNull(); // bare epoch
  });

  it("rejects calendar overflows that new Date() silently rolls over", () => {
    // new Date('2026-02-30') => Mar 2; 2026-04-31 => May 1. Both must be rejected
    // rather than silently accepted as a different (real) day.
    expect(validateSince("2026-02-30")).not.toBeNull();
    expect(validateSince("2026-04-31")).not.toBeNull();
    expect(validateSince("2026-13-01")).not.toBeNull();
    expect(validateSince("2026-00-10")).not.toBeNull();
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
