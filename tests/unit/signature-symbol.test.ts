// tests/unit/signature-symbol.test.ts
import { describe, expect, it } from "bun:test";
import { computeSignature } from "../../src/diff/signature.ts";

describe("computeSignature with symbol context", () => {
  it("is stable when a line moves but stays in the same 5-line offset bucket within its symbol", () => {
    const a = computeSignature({
      file: "a.ts",
      ruleId: "r",
      category: "security",
      lineStart: 12,
      lineEnd: 12,
      symbolName: "foo",
      symbolStartLine: 10,
    });
    const b = computeSignature({
      file: "a.ts",
      ruleId: "r",
      category: "security",
      lineStart: 14,
      lineEnd: 14,
      symbolName: "foo",
      symbolStartLine: 10,
    });
    expect(a).toBe(b); // offsets 2 and 4 → same 5-line bucket (0)
  });
  it("differs across symbols even at the same absolute line", () => {
    const a = computeSignature({
      file: "a.ts",
      ruleId: "r",
      category: "security",
      lineStart: 12,
      lineEnd: 12,
      symbolName: "foo",
      symbolStartLine: 10,
    });
    const b = computeSignature({
      file: "a.ts",
      ruleId: "r",
      category: "security",
      lineStart: 12,
      lineEnd: 12,
      symbolName: "bar",
      symbolStartLine: 10,
    });
    expect(a).not.toBe(b);
  });
  it("differs across 5-line offset buckets within the same symbol", () => {
    const a = computeSignature({
      file: "a.ts",
      ruleId: "r",
      category: "security",
      lineStart: 12,
      lineEnd: 12,
      symbolName: "foo",
      symbolStartLine: 10,
    }); // offset 2 → bucket 0
    const b = computeSignature({
      file: "a.ts",
      ruleId: "r",
      category: "security",
      lineStart: 17,
      lineEnd: 17,
      symbolName: "foo",
      symbolStartLine: 10,
    }); // offset 7 → bucket 5
    expect(a).not.toBe(b);
  });
  it("falls back to line buckets when no symbol context (unchanged M1 behavior)", () => {
    const a = computeSignature({
      file: "a.ts",
      ruleId: "r",
      category: "security",
      lineStart: 41,
      lineEnd: 41,
    });
    const b = computeSignature({
      file: "a.ts",
      ruleId: "r",
      category: "security",
      lineStart: 49,
      lineEnd: 49,
    });
    expect(a).toBe(b);
  });
});
