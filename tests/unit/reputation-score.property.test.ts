// tests/unit/reputation-score.property.test.ts
//
// Property-based robustness for the reputation scoring math (weakness #2: subtle
// state/number bugs hid in the learning subsystems — F-023/F-025 lived here).
// fast-check throws hostile inputs (future/NaN/garbage timestamps, extreme
// half-lives, huge event counts) at the pure functions and asserts the invariants
// hold for EVERY generated case, not just the hand-picked examples.
import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { type RepEvent, decayedCount, trustScore } from "../../src/core/reputation/score.ts";

// An arbitrary RepEvent whose ts may be valid, far past, far future, or garbage.
const tsArb = fc.oneof(
  fc
    .date({ min: new Date("2000-01-01"), max: new Date("2035-01-01"), noInvalidDate: true })
    .map((d) => d.toISOString()),
  fc.constantFrom("not-a-date", "", "9999-13-40T99:99:99Z", "NaN", "Infinity"),
);
const eventArb: fc.Arbitrary<RepEvent> = fc.record({ ts: tsArb, eid: fc.string() });
const eventsArb = fc.array(eventArb, { maxLength: 40 });
const now = new Date("2026-05-29T00:00:00Z");
const halfLifeArb = fc.double({ min: 0.1, max: 3650, noNaN: true });

describe("reputation score — property invariants", () => {
  it("decayedCount is always finite and >= 0 (never throws on hostile ts)", () => {
    fc.assert(
      fc.property(eventsArb, halfLifeArb, (events, hl) => {
        let v = 0;
        expect(() => {
          v = decayedCount(events, now, hl);
        }).not.toThrow();
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it("a garbage/unparseable-ts event contributes exactly zero (F-025)", () => {
    fc.assert(
      fc.property(eventsArb, halfLifeArb, (events, hl) => {
        const withGarbage = [...events, { ts: "totally-not-a-date", eid: "x" }];
        expect(decayedCount(withGarbage, now, hl)).toBeCloseTo(decayedCount(events, now, hl), 9);
      }),
    );
  });

  it("trustScore stays strictly inside (0,1) for ALL inputs", () => {
    fc.assert(
      fc.property(eventsArb, eventsArb, halfLifeArb, (correct, wrong, hl) => {
        const t = trustScore(correct, wrong, now, hl);
        expect(t).toBeGreaterThan(0);
        expect(t).toBeLessThan(1);
        expect(Number.isFinite(t)).toBe(true);
      }),
    );
  });

  it("trustScore is 0.5 at zero data and monotonic in evidence", () => {
    expect(trustScore([], [], now, 45)).toBeCloseTo(0.5, 9);
    fc.assert(
      fc.property(eventsArb, eventsArb, (correct, wrong) => {
        const base = trustScore(correct, wrong, now, 45);
        // One more CORRECT (a recent, valid event) must not LOWER trust …
        const more = trustScore([...correct, { ts: now.toISOString(), eid: "c" }], wrong, now, 45);
        expect(more).toBeGreaterThanOrEqual(base - 1e-9);
        // … and one more WRONG must not RAISE it.
        const worse = trustScore(correct, [...wrong, { ts: now.toISOString(), eid: "w" }], now, 45);
        expect(worse).toBeLessThanOrEqual(base + 1e-9);
      }),
    );
  });
});
