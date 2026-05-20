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
});
