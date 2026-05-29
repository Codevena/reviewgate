import { describe, expect, it } from "bun:test";
import { PROTECTED_PREFIXES } from "../../src/research/plan-refs.ts";

describe("plan-refs protects agy artifacts", () => {
  it("includes .antigravitycli/ in PROTECTED_PREFIXES", () => {
    expect(PROTECTED_PREFIXES).toContain(".antigravitycli/");
  });
});
