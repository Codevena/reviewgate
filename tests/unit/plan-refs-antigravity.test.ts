import { describe, expect, it } from "bun:test";
import { isAgyArtifactPath } from "../../src/research/plan-refs.ts";

describe("plan-refs protects agy artifacts", () => {
  it("matches .antigravitycli at root AND in a subdir, not lookalikes", () => {
    expect(isAgyArtifactPath(".antigravitycli/x")).toBe(true);
    expect(isAgyArtifactPath("sub/.antigravitycli/y")).toBe(true);
    expect(isAgyArtifactPath("x.antigravitycli")).toBe(false);
    expect(isAgyArtifactPath(".antigravityclient/z")).toBe(false);
  });
});
