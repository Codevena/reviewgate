// tests/unit/openrouter-cost.test.ts
import { describe, expect, it } from "bun:test";
import { estimateCostUsd } from "../../src/providers/openrouter.ts";

describe("estimateCostUsd", () => {
  it("returns 0 when no price configured", () => {
    expect(estimateCostUsd(1000, 500, undefined)).toBe(0);
  });
  it("computes from price per million tokens", () => {
    expect(estimateCostUsd(1_000_000, 0, 0.5)).toBeCloseTo(0.5, 6);
  });
  it("sums input + output tokens", () => {
    expect(estimateCostUsd(500_000, 500_000, 2)).toBeCloseTo(2, 6);
  });
});
