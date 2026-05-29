// tests/unit/safe-json.test.ts
import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { parseUntrusted, safeJsonParse } from "../../src/utils/safe-json.ts";

// Adversarial inputs an untrusted reviewer/CLI/LLM boundary can produce.
const HOSTILE = [
  "",
  "   ",
  "null",
  "42",
  "true",
  '"a string"',
  "[]",
  "[1,2,3]",
  "[null, 42]",
  "{",
  "}{",
  "not json at all",
  '{"a":', // truncated
  '{"verdicts": [null, 42, "x"]}',
];

describe("safeJsonParse", () => {
  it("never throws on hostile input and returns undefined on failure", () => {
    for (const h of HOSTILE.filter((s) => s.trim() === "" || /[{}[\]]/.test(s) === false)) {
      expect(() => safeJsonParse(h)).not.toThrow();
    }
    expect(safeJsonParse("not json")).toBeUndefined();
    expect(safeJsonParse('{"a":')).toBeUndefined(); // truncated
    expect(safeJsonParse("")).toBeUndefined();
  });

  it("parses valid JSON of every shape (object/array/primitive/null)", () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
    expect(safeJsonParse("[1,2]")).toEqual([1, 2]);
    expect(safeJsonParse("42")).toBe(42);
    expect(safeJsonParse("null")).toBeNull(); // valid JSON null (the classic crash source)
  });
});

describe("parseUntrusted", () => {
  const Schema = z.object({ verdict: z.enum(["PASS", "FAIL"]), n: z.number().optional() });

  it("never throws and returns null on ANY parse-or-validation failure", () => {
    for (const h of HOSTILE) {
      expect(() => parseUntrusted(h, Schema)).not.toThrow();
      expect(parseUntrusted(h, Schema)).toBeNull();
    }
    // valid JSON but wrong shape → null (not a throw, not a partial object)
    expect(parseUntrusted('{"verdict":"MAYBE"}', Schema)).toBeNull();
    expect(parseUntrusted("null", Schema)).toBeNull();
    expect(parseUntrusted("[1,2]", Schema)).toBeNull();
  });

  it("returns the validated, typed value on a schema match", () => {
    expect(parseUntrusted('{"verdict":"PASS","n":3}', Schema)).toEqual({ verdict: "PASS", n: 3 });
  });
});
