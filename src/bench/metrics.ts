// reviewgate bench — rate → metric with a Wilson 95% CI (spec §5.2).
//
// Every headline number bench reports is a proportion (precision, recall, clean
// FP-rate, per-provider coverage). At the smoke-test N the corpus targets (~20–30
// cases) a bare point estimate is dangerously over-read — one case flipping moves
// precision by 5pp. Reporting the Wilson score interval alongside the raw num/den
// makes the uncertainty legible, and the runner emits `MetricSchema`-valid objects
// so an internally-inconsistent rate can never be persisted.

import type { Metric } from "../schemas/bench-result.ts";

// 95% two-sided normal quantile. Hard-coded (no stats dep) — bench only ever needs
// the 95% interval the spec pins.
const Z = 1.959963984540054;

/** Wilson score interval [lo, hi] for `num` successes in `den` trials, clamped to [0,1]. */
export function wilson(num: number, den: number): { lo: number; hi: number } {
  if (den <= 0) return { lo: 0, hi: 1 };
  const p = num / den;
  const z2 = Z * Z;
  const denom = 1 + z2 / den;
  const center = (p + z2 / (2 * den)) / denom;
  const margin = (Z * Math.sqrt((p * (1 - p)) / den + z2 / (4 * den * den))) / denom;
  const lo = Math.max(0, center - margin);
  const hi = Math.min(1, center + margin);
  return { lo, hi };
}

/**
 * Build a schema-valid {@link Metric} from raw counts.
 *
 * `den === 0` → value/CI are null (an undefined rate, never `0`). Otherwise value =
 * num/den and the CI is the Wilson interval, additionally clamped so the point
 * estimate always lies inside it (`ci_lo <= value <= ci_hi`) — the invariant
 * `MetricSchema.superRefine` enforces. Rounding drift in the clamp direction is
 * impossible because we clamp *to* value, not near it.
 */
export function makeMetric(num: number, den: number): Metric {
  if (!Number.isInteger(num) || !Number.isInteger(den)) {
    throw new Error(`makeMetric: counts must be integers (num=${num}, den=${den})`);
  }
  if (num < 0 || den < 0) {
    throw new Error(`makeMetric: counts must be non-negative (num=${num}, den=${den})`);
  }
  if (num > den) {
    throw new Error(`makeMetric: num must be <= den (num=${num}, den=${den})`);
  }
  if (den === 0) {
    return { num: 0, den: 0, value: null, ci_lo: null, ci_hi: null };
  }
  const value = num / den;
  const { lo, hi } = wilson(num, den);
  // Guarantee ci_lo <= value <= ci_hi regardless of any float wobble in wilson().
  const ci_lo = Math.max(0, Math.min(lo, value));
  const ci_hi = Math.min(1, Math.max(hi, value));
  return { num, den, value, ci_lo, ci_hi };
}
