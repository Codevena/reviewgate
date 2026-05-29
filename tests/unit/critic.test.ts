// tests/unit/critic.test.ts
import { describe, expect, it } from "bun:test";
import { parseCriticOutput } from "../../src/core/critic.ts";

describe("parseCriticOutput", () => {
  it("maps signatures to keep/likely_fp", () => {
    const m = parseCriticOutput(
      '{"verdicts":[{"signature":"sigA","verdict":"likely_fp","reason":"style only"},{"signature":"sigB","verdict":"keep"}]}',
    );
    expect(m.get("sigA")).toEqual({ verdict: "likely_fp", reason: "style only" });
    expect(m.get("sigB")?.verdict).toBe("keep");
  });

  it("returns an empty map on garbage (fail-open: nothing demoted)", () => {
    expect(parseCriticOutput("not json").size).toBe(0);
  });

  it("returns an empty map (no throw) when verdicts is a non-iterable value", () => {
    // Adversarial reviewer-LLM output: valid JSON whose `verdicts` key is an
    // object/number/string instead of an array. `verdicts ?? []` does NOT guard
    // this (the value is truthy), so a naive for-of throws an uncaught TypeError
    // that crashes the whole gate process → fail-OPEN. Must fail closed: no throw,
    // zero demotions.
    expect(() => parseCriticOutput('{"verdicts":{"sig1":"keep"}}')).not.toThrow();
    expect(parseCriticOutput('{"verdicts":{"sig1":"keep"}}').size).toBe(0);
    expect(parseCriticOutput('{"verdicts":42}').size).toBe(0);
    expect(parseCriticOutput('{"verdicts":"keep"}').size).toBe(0);
  });

  it("returns an empty map (no throw) when the whole payload is null/primitive JSON", () => {
    // JSON.parse("null") returns null (valid JSON, no parse error) → accessing
    // `.verdicts` on it throws an uncaught TypeError → gate crash (fail-OPEN).
    // Same for arrays/numbers/strings at the top level.
    expect(() => parseCriticOutput("null")).not.toThrow();
    expect(parseCriticOutput("null").size).toBe(0);
    expect(parseCriticOutput("42").size).toBe(0);
    expect(parseCriticOutput("[1,2]").size).toBe(0);
    expect(parseCriticOutput('"a string"').size).toBe(0);
  });

  it("skips null/primitive array elements without throwing (still maps valid ones)", () => {
    // `verdicts` is an array but holds null/primitive elements: accessing
    // `el.signature` on null throws TypeError → uncaught gate crash (fail-OPEN).
    // Each element must be guarded as an object; valid entries still map.
    const m = parseCriticOutput(
      '{"verdicts":[null,42,"keep",{"signature":"sigA","verdict":"keep"}]}',
    );
    expect(m.size).toBe(1);
    expect(m.get("sigA")?.verdict).toBe("keep");
  });
});
