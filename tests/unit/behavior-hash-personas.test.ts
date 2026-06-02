import { describe, expect, it } from "bun:test";
import { computeBehaviorHash } from "../../src/cache/behavior-hash.ts";

const base = { brain: [], fp: [] };

describe("computeBehaviorHash personas segment", () => {
  it("is byte-identical to legacy when personas is empty/absent", () => {
    expect(computeBehaviorHash(base)).toBe(computeBehaviorHash({ ...base, personas: [] }));
  });
  it("changes the hash when a persona delta entry is present", () => {
    const a = computeBehaviorHash(base);
    const b = computeBehaviorHash({ ...base, personas: ["security:abc123"] });
    expect(b).not.toBe(a);
    expect(b).toContain("|personas:");
  });
  it("is order-independent for delta entries", () => {
    const x = computeBehaviorHash({ ...base, personas: ["security:1", "plan:2"] });
    const y = computeBehaviorHash({ ...base, personas: ["plan:2", "security:1"] });
    expect(x).toBe(y);
  });
});
