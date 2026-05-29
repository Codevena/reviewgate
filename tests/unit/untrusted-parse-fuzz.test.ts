// tests/unit/untrusted-parse-fuzz.test.ts
//
// Behavioral regression net for the fail-OPEN crash class: feed every untrusted
// parser entry point a battery of adversarial inputs and assert it NEVER throws
// and fails CLOSED (null / empty). Complements the structural guard — even if a
// raw JSON.parse slips past, this catches a parser that crashes on hostile output.
import { describe, expect, it } from "bun:test";
import { parseCriticOutput } from "../../src/core/critic.ts";
import { parseReviewOutput } from "../../src/providers/review-output.ts";

// Valid-JSON-but-non-object payloads are the sharp edge: they parse fine, then a
// blind `.field` access throws. Plus truncated/garbage/huge/deeply-nested.
const HOSTILE: string[] = [
  "",
  "   ",
  "null",
  "42",
  "true",
  "false",
  '"a bare string"',
  "[]",
  "[1,2,3]",
  "[null, 42]",
  "{}",
  "{",
  "}{",
  '{"a":', // truncated
  "not json at all",
  "```json\nnull\n```",
  '```json\n{"verdicts": 42}\n```',
  '{"findings": 42}',
  '{"findings": null}',
  '{"verdicts": {"x": "keep"}}',
  '{"verdicts": [null, 42, "x"]}',
  `{"deep": ${"[".repeat(200)}${"]".repeat(200)}}`,
  `{"big": "${"x".repeat(100_000)}"}`,
];

describe("untrusted parsers fail closed on hostile input (never throw)", () => {
  it("parseReviewOutput returns null (never throws) for every hostile input", () => {
    for (const h of HOSTILE) {
      expect(() => parseReviewOutput(h)).not.toThrow();
      // It may parse a well-formed review; for these hostile inputs it must not.
      const r = parseReviewOutput(h);
      expect(r === null || (typeof r === "object" && Array.isArray(r.findings))).toBe(true);
    }
  });

  it("parseCriticOutput returns an empty map (never throws) for every hostile input", () => {
    for (const h of HOSTILE) {
      expect(() => parseCriticOutput(h)).not.toThrow();
      expect(parseCriticOutput(h).size).toBe(0);
    }
  });
});
