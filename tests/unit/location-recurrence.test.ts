// tests/unit/location-recurrence.test.ts
// Non-convergence (field report 2026-06-17): the LOCATION-keyed sibling of signature-recurrence —
// a file:line region re-raised across N consecutive reviewed iterations regardless of signature.
import { describe, expect, it } from "bun:test";
import { locationKey, recurringBlockingLocations } from "../../src/core/location-recurrence.ts";

describe("locationKey", () => {
  it("buckets nearby lines to the same region (drift tolerance)", () => {
    expect(locationKey("a.ts", 72)).toBe(locationKey("a.ts", 73)); // same 10-line bucket
    expect(locationKey("a.ts", 71)).toBe(locationKey("a.ts", 80)); // 71..80 share bucket 70
  });
  it("different files / far-apart lines → different regions", () => {
    expect(locationKey("a.ts", 72)).not.toBe(locationKey("b.ts", 72));
    expect(locationKey("a.ts", 12)).not.toBe(locationKey("a.ts", 72));
  });
  it("clamps non-positive / non-finite line numbers", () => {
    expect(locationKey("a.ts", 0)).toBe(locationKey("a.ts", 1));
    expect(locationKey("a.ts", Number.NaN)).toBe(locationKey("a.ts", 1));
  });
});

describe("recurringBlockingLocations", () => {
  const R = locationKey("install-prompt.tsx", 72); // the field gold-case region

  it("returns a region present (blocking) in EVERY one of the last N rows", () => {
    const history = [[R], [R], [R]]; // 3 consecutive rows, same region, (different signatures)
    expect(recurringBlockingLocations(history, new Set([R]), 3)).toEqual([R]);
  });
  it("a gap (region absent in one row) breaks the streak", () => {
    const history = [[R], ["other.ts:0"], [R]];
    expect(recurringBlockingLocations(history, new Set([R]), 3)).toEqual([]);
  });
  it("returns [] when history has fewer than threshold rows", () => {
    expect(recurringBlockingLocations([[R], [R]], new Set([R]), 3)).toEqual([]);
  });
  it("returns [] when threshold < 1", () => {
    expect(recurringBlockingLocations([[R], [R], [R]], new Set([R]), 0)).toEqual([]);
  });
  it("only counts regions in the current blocking set", () => {
    const history = [[R], [R], [R]];
    expect(recurringBlockingLocations(history, new Set(), 3)).toEqual([]);
  });
  it("uses the LAST N rows (older rows beyond the window are ignored)", () => {
    const history = [["x:0"], [R], [R], [R]]; // window of 3 = last three, all R
    expect(recurringBlockingLocations(history, new Set([R]), 3)).toEqual([R]);
  });
});
