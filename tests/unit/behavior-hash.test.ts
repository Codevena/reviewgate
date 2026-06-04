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

  it("refs segment: absent → byte-identical to no-refs; present → distinct", () => {
    const base = { brain: [], fp: [] };
    const noRefs = computeBehaviorHash(base);
    expect(computeBehaviorHash({ ...base, refs: undefined })).toBe(noRefs);
    const a = computeBehaviorHash({ ...base, refs: "hashA" });
    const b = computeBehaviorHash({ ...base, refs: "hashB" });
    expect(a).not.toBe(noRefs);
    expect(a).not.toBe(b);
  });

  it("appends an adj segment only when present, and a changed adj set changes the hash (S1)", () => {
    const base = { brain: [{ id: "B-1", status: "active" }], fp: [] };
    const none = computeBehaviorHash(base);
    // continuity: absent/undefined adjudications must not perturb the hash
    expect(computeBehaviorHash({ ...base, adjudications: undefined })).toBe(none);
    const a = computeBehaviorHash({ ...base, adjudications: "adjHashA" });
    const b = computeBehaviorHash({ ...base, adjudications: "adjHashB" });
    expect(a).toBe(`${none}|adj:adjHashA`);
    expect(a).not.toBe(none);
    expect(a).not.toBe(b);
  });

  it("collab segment: absent → byte-identical; a changed collaborator corpus changes the hash (N5)", () => {
    const base = { brain: [{ id: "B-1", status: "active" }], fp: [] };
    const none = computeBehaviorHash(base);
    // continuity: absent/undefined collaborators must not perturb the hash
    expect(computeBehaviorHash({ ...base, collaborators: undefined })).toBe(none);
    const a = computeBehaviorHash({ ...base, collaborators: "collabHashA" });
    const b = computeBehaviorHash({ ...base, collaborators: "collabHashB" });
    expect(a).toBe(`${none}|collab:collabHashA`);
    expect(a).not.toBe(none);
    expect(a).not.toBe(b);
  });
});
