import { describe, expect, it } from "bun:test";
import { computeBehaviorHash } from "../../src/cache/behavior-hash.ts";

describe("computeBehaviorHash", () => {
  it("is empty when both inputs are empty", () => {
    expect(computeBehaviorHash({ brain: [], fp: [] })).toBe("");
  });

  it("empty fp reproduces the brain-only id:status hash (cache continuity)", () => {
    const brain = [
      { id: "B-2", status: "active" },
      { id: "B-1", status: "candidate" },
    ];
    // exact legacy format: `${id}:${status}` sorted, comma-joined
    expect(computeBehaviorHash({ brain, fp: [] })).toBe("B-1:candidate,B-2:active");
  });

  it("appends an fp segment keyed on signature:stage (sorted), id is ignored", () => {
    const fpA = computeBehaviorHash({
      brain: [],
      fp: [
        { signature: "sigB", stage: "active", id: "FP-002" },
        { signature: "sigA", stage: "sticky", id: "FP-001" },
      ],
    });
    expect(fpA).toBe("|fp:sigA:sticky,sigB:active");
    // changing only the cosmetic id does NOT change the hash
    const fpB = computeBehaviorHash({
      brain: [],
      fp: [
        { signature: "sigB", stage: "active", id: "FP-999" },
        { signature: "sigA", stage: "sticky", id: "FP-998" },
      ],
    });
    expect(fpB).toBe(fpA);
  });

  it("a stage change DOES change the hash", () => {
    const before = computeBehaviorHash({
      brain: [],
      fp: [{ signature: "s", stage: "active", id: "FP-1" }],
    });
    const after = computeBehaviorHash({
      brain: [],
      fp: [{ signature: "s", stage: "sticky", id: "FP-1" }],
    });
    expect(after).not.toBe(before);
  });
});
