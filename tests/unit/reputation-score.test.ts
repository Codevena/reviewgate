import { describe, expect, it } from "bun:test";
import { decayedCount, isUnreliable, trustScore } from "../../src/core/reputation/score.ts";

const DAY = 24 * 60 * 60 * 1000;

describe("reputation score", () => {
  it("decays an event to ~half its weight after one half-life", () => {
    const now = new Date("2026-05-25T00:00:00Z");
    const oneHalfLifeAgo = new Date(now.getTime() - 45 * DAY).toISOString();
    const w = decayedCount([{ ts: oneHalfLifeAgo, eid: "e1" }], now, 45);
    expect(w).toBeGreaterThan(0.49);
    expect(w).toBeLessThan(0.51);
  });

  it("trustScore uses Beta(1,1) smoothing → 0.5 at zero data", () => {
    const now = new Date();
    expect(trustScore([], [], now, 45)).toBeCloseTo(0.5, 5);
  });

  it("trustScore drops as recent wrong events dominate", () => {
    const now = new Date();
    const recent = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ ts: now.toISOString(), eid: `e${i}` }));
    expect(trustScore(recent(1), recent(9), now, 45)).toBeCloseTo(2 / 12, 2);
  });

  it("isUnreliable requires BOTH enough samples AND trust below floor", () => {
    expect(isUnreliable({ trust: 0.1, samples: 3 }, 8, 0.35)).toBe(false);
    expect(isUnreliable({ trust: 0.5, samples: 20 }, 8, 0.35)).toBe(false);
    expect(isUnreliable({ trust: 0.1, samples: 20 }, 8, 0.35)).toBe(true);
  });
});
