// tests/unit/bench-metrics.test.ts
// reviewgate bench — Wilson-CI metric builder (spec §5.2). Every rate is reported
// with its raw num/den and a Wilson 95% CI so a one-case swing at N≈20 can't read
// as a real delta. The MetricSchema invariant (ci_lo <= value <= ci_hi; null when
// den=0) is load-bearing — a metric that violates it fails schema validation and a
// headline number could never be written.
import { describe, expect, it } from "bun:test";
import { makeMetric, wilson } from "../../src/bench/metrics.ts";
import { MetricSchema } from "../../src/schemas/bench-result.ts";

describe("makeMetric", () => {
  it("returns all-null value/CI when the denominator is zero", () => {
    const m = makeMetric(0, 0);
    expect(m.num).toBe(0);
    expect(m.den).toBe(0);
    expect(m.value).toBeNull();
    expect(m.ci_lo).toBeNull();
    expect(m.ci_hi).toBeNull();
    expect(() => MetricSchema.parse(m)).not.toThrow();
  });

  it("sets value=num/den and a finite CI for a normal rate", () => {
    const m = makeMetric(17, 20);
    expect(m.value).toBeCloseTo(0.85, 10);
    expect(m.ci_lo).not.toBeNull();
    expect(m.ci_hi).not.toBeNull();
    // The point estimate always lies inside the reported interval.
    expect(m.ci_lo as number).toBeLessThanOrEqual(m.value as number);
    expect(m.ci_hi as number).toBeGreaterThanOrEqual(m.value as number);
    expect(() => MetricSchema.parse(m)).not.toThrow();
  });

  it("keeps a perfect rate's CI inside [0,1] and containing 1.0", () => {
    const m = makeMetric(20, 20);
    expect(m.value).toBe(1);
    expect(m.ci_lo as number).toBeGreaterThanOrEqual(0);
    expect(m.ci_lo as number).toBeLessThanOrEqual(1);
    expect(m.ci_hi).toBe(1);
    expect(() => MetricSchema.parse(m)).not.toThrow();
  });

  it("keeps a zero rate's CI inside [0,1] and containing 0.0", () => {
    const m = makeMetric(0, 20);
    expect(m.value).toBe(0);
    expect(m.ci_lo).toBe(0);
    expect(m.ci_hi as number).toBeGreaterThanOrEqual(0);
    expect(m.ci_hi as number).toBeLessThanOrEqual(1);
    expect(() => MetricSchema.parse(m)).not.toThrow();
  });

  it("produces a schema-valid metric across a sweep of counts", () => {
    for (let den = 0; den <= 30; den++) {
      for (let num = 0; num <= den; num++) {
        const m = makeMetric(num, den);
        expect(() => MetricSchema.parse(m)).not.toThrow();
      }
    }
  });

  it("throws when num exceeds den (a caller bug, not a valid rate)", () => {
    expect(() => makeMetric(5, 3)).toThrow();
  });

  it("throws on a negative or non-integer count", () => {
    expect(() => makeMetric(-1, 3)).toThrow();
    expect(() => makeMetric(1.5, 3)).toThrow();
  });
});

describe("wilson", () => {
  it("brackets the point estimate for a mid-range proportion", () => {
    const { lo, hi } = wilson(10, 20);
    expect(lo).toBeLessThan(0.5);
    expect(hi).toBeGreaterThan(0.5);
    expect(lo).toBeGreaterThanOrEqual(0);
    expect(hi).toBeLessThanOrEqual(1);
  });

  it("narrows as the sample grows", () => {
    const small = wilson(8, 10);
    const large = wilson(80, 100);
    expect(large.hi - large.lo).toBeLessThan(small.hi - small.lo);
  });
});
