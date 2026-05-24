// tests/unit/determinism.test.ts
// Phase 4 #5 — kill two sources of cross-machine non-determinism that feed the
// cache key / cluster order:
//  (a) localeCompare in the aggregator sort is locale-dependent (ICU + LANG) →
//      different cluster seeds / cache keys on different machines. Use a stable
//      code-unit comparison instead.
//  (b) RG_VERSION was hardcoded "0.1.0-m1" since M1 and goes into the cache key;
//      derive it from package.json so it tracks releases.
import { describe, expect, it } from "bun:test";
import pkg from "../../package.json";
import { compareCodeUnits } from "../../src/utils/compare.ts";
import { RG_VERSION } from "../../src/version.ts";

describe("compareCodeUnits (locale-independent)", () => {
  it("orders by UTF-16 code unit, NOT locale collation", () => {
    // In many locales 'a' collates before 'B'; by code unit 'B' (0x42) < 'a' (0x61).
    expect(compareCodeUnits("B", "a")).toBeLessThan(0);
    expect(compareCodeUnits("a", "B")).toBeGreaterThan(0);
  });
  it("is reflexive and antisymmetric", () => {
    expect(compareCodeUnits("x.ts", "x.ts")).toBe(0);
    const ab = compareCodeUnits("a.ts", "b.ts");
    const ba = compareCodeUnits("b.ts", "a.ts");
    expect(Math.sign(ab)).toBe(-Math.sign(ba));
  });
  it("sorts a list identically regardless of process locale", () => {
    const items = ["Zebra", "apple", "Banana", "_under", "0digit"];
    const sorted = [...items].sort(compareCodeUnits);
    // Code-unit order: digits < uppercase < underscore < lowercase.
    expect(sorted).toEqual(["0digit", "Banana", "Zebra", "_under", "apple"]);
  });
});

describe("RG_VERSION", () => {
  it("is derived from package.json, not the old hardcoded M1 string", () => {
    expect(RG_VERSION).toBe(pkg.version);
    expect(RG_VERSION).not.toBe("0.1.0-m1");
  });
});
