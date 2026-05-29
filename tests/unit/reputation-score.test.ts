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

  it("an unparseable timestamp contributes zero weight (corrupt entry is no evidence)", () => {
    const now = new Date("2026-05-25T00:00:00Z");
    const w = decayedCount([{ ts: "not-a-date", eid: "bad" }], now, 45);
    expect(w).toBe(0);
  });

  it("a future (clock-skewed) event decays by the magnitude of its skew, not held at weight 1 forever", () => {
    const now = new Date("2026-05-25T00:00:00Z");
    // ts is one half-life in the FUTURE (clock skew across machines sharing a repo)
    const oneHalfLifeAhead = new Date(now.getTime() + 45 * DAY).toISOString();
    const w = decayedCount([{ ts: oneHalfLifeAhead, eid: "skew" }], now, 45);
    // weight must reflect decay by |age|, i.e. ~0.5, NOT a permanent 1
    expect(w).toBeGreaterThan(0.49);
    expect(w).toBeLessThan(0.51);
  });

  it("a far-future skewed event eventually fades toward zero instead of pinning trust", () => {
    const now = new Date("2026-05-25T00:00:00Z");
    // ts is ten half-lives in the future → 0.5^10 ≈ 0.001
    const farFuture = new Date(now.getTime() + 10 * 45 * DAY).toISOString();
    const w = decayedCount([{ ts: farFuture, eid: "skew2" }], now, 45);
    expect(w).toBeLessThan(0.01);
  });
});
