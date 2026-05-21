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

  it("omitting docs (or empty) keeps the brain/fp hash byte-identical (cache continuity)", () => {
    const base = computeBehaviorHash({ brain: [{ id: "B-1", status: "active" }], fp: [] });
    expect(
      computeBehaviorHash({ brain: [{ id: "B-1", status: "active" }], fp: [], docs: [] }),
    ).toBe(base);
  });

  it("appends a docs segment keyed on name@version:responseHash (sorted)", () => {
    const h = computeBehaviorHash({
      brain: [],
      fp: [],
      docs: [
        { name: "next", version: "15.1.8", responseHash: "h2" },
        { name: "zod", version: "3.25.0", responseHash: "h1" },
      ],
    });
    expect(h).toBe("|docs:next@15.1.8:h2,zod@3.25.0:h1");
  });

  it("a docs responseHash change DOES change the hash", () => {
    const before = computeBehaviorHash({
      brain: [],
      fp: [],
      docs: [{ name: "zod", version: "3.25.0", responseHash: "h1" }],
    });
    const after = computeBehaviorHash({
      brain: [],
      fp: [],
      docs: [{ name: "zod", version: "3.25.0", responseHash: "h2" }],
    });
    expect(after).not.toBe(before);
  });

  it("a null docs version renders as name@:hash", () => {
    const h = computeBehaviorHash({
      brain: [],
      fp: [],
      docs: [{ name: "left-pad", version: null, responseHash: "hh" }],
    });
    expect(h).toBe("|docs:left-pad@:hh");
  });
});
