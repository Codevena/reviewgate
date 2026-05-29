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
});
