// tests/unit/signature-recurrence.test.ts
import { describe, expect, it } from "bun:test";
import { recurringBlockingSignatures } from "../../src/core/signature-recurrence.ts";

const B = (...s: string[]) => new Set(s);

describe("recurringBlockingSignatures", () => {
  it("returns a blocking sig present in each of the last K rows", () => {
    const history = [
      ["s1", "a"],
      ["s1", "b"],
      ["s1", "c"],
    ];
    expect(recurringBlockingSignatures(history, B("s1"), 3)).toEqual(["s1"]);
  });

  it("excludes a sig that recurs but is NOT in the blocking set (advisory)", () => {
    const history = [
      ["s1", "x"],
      ["s1", "y"],
      ["s1", "z"],
    ];
    expect(recurringBlockingSignatures(history, B("x"), 3)).toEqual([]); // x only in row 1
    expect(recurringBlockingSignatures(history, B("nope"), 3)).toEqual([]);
  });

  it("excludes a sig missing from any of the last K rows (a gap breaks the streak)", () => {
    const history = [["s1"], [], ["s1"]]; // empty middle row (ERROR iter)
    expect(recurringBlockingSignatures(history, B("s1"), 3)).toEqual([]);
  });

  it("only considers the LAST K rows", () => {
    const history = [["s1"], ["s1"], ["nope"], ["nope"]]; // last 2 rows lack s1
    expect(recurringBlockingSignatures(history, B("s1"), 2)).toEqual([]);
  });

  it("returns [] when history is shorter than the threshold, or threshold <= 0", () => {
    expect(recurringBlockingSignatures([["s1"]], B("s1"), 3)).toEqual([]);
    expect(recurringBlockingSignatures([["s1"], ["s1"]], B("s1"), 0)).toEqual([]);
  });

  it("returns all recurring blocking sigs, sorted + unique", () => {
    const history = [
      ["s2", "s1"],
      ["s1", "s2"],
      ["s2", "s1"],
    ];
    expect(recurringBlockingSignatures(history, B("s1", "s2"), 3)).toEqual(["s1", "s2"]);
  });
});
