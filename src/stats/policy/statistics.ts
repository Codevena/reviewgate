import { compareCodeUnits } from "../../utils/compare.ts";

const BOOTSTRAP_RESAMPLES = 10_000;
const LOWER_PERCENTILE = 0.025;
const UPPER_PERCENTILE = 0.975;

export interface RepeatCaseEffect {
  caseId: string;
  repeat: 1 | 2 | 3;
  errorReduction: number;
}

export interface CollapsedCaseEffect {
  caseId: string;
  mean: number;
  repeats: [number, number, number];
}

export type RepeatDirection = "positive" | "negative" | "zero" | "conflict" | "insufficient";

export interface PolicyHolmFamilies {
  singleton: readonly number[];
  interaction: readonly number[];
}

export interface AdjustedPolicyHolmFamilies {
  singleton: number[];
  interaction: number[];
}

function assertFiniteValues(values: readonly number[], name: string): void {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new RangeError(`${name} must contain only finite numbers`);
  }
}

/**
 * Collapses the three independent captures for every case into its case-level effect.
 * A partial case is not statistically independent evidence and is rejected rather than imputed.
 */
export function collapseCaseRepeats(rows: readonly RepeatCaseEffect[]): CollapsedCaseEffect[] {
  const byCase = new Map<string, Map<number, number>>();

  for (const row of rows) {
    if (!Number.isInteger(row.repeat) || row.repeat < 1 || row.repeat > 3) {
      throw new RangeError(`repeat must be 1, 2, or 3 for case ${row.caseId}`);
    }
    if (!Number.isFinite(row.errorReduction)) {
      throw new RangeError(`error reduction must be finite for case ${row.caseId}`);
    }

    const repeats = byCase.get(row.caseId) ?? new Map<number, number>();
    if (repeats.has(row.repeat)) {
      throw new Error(`duplicate repeat ${row.repeat} for case ${row.caseId}`);
    }
    repeats.set(row.repeat, row.errorReduction);
    byCase.set(row.caseId, repeats);
  }

  return [...byCase.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([caseId, byRepeat]) => {
      const first = byRepeat.get(1);
      const second = byRepeat.get(2);
      const third = byRepeat.get(3);
      if (first === undefined || second === undefined || third === undefined) {
        throw new Error(`case ${caseId} must contain exactly three repeats`);
      }
      const repeats: [number, number, number] = [first, second, third];
      return {
        caseId,
        mean: (first + second + third) / 3,
        repeats,
      };
    });
}

/** Mulberry32: local, reproducible, unsigned-32-bit pseudo-random generator. */
function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

/**
 * The short form supplies only the preregistered seed. The long form makes the locked
 * 10,000-resample contract explicit for call sites that carry it in their inputs.
 */
export function percentileBootstrap95(
  values: readonly number[],
  seed: number,
): { lo: number; hi: number } | null;
export function percentileBootstrap95(
  values: readonly number[],
  resamples: 10_000,
  seed: number,
): { lo: number; hi: number } | null;
export function percentileBootstrap95(
  values: readonly number[],
  resamplesOrSeed: number,
  maybeSeed?: number,
): { lo: number; hi: number } | null {
  assertFiniteValues(values, "bootstrap values");
  const resamples = maybeSeed === undefined ? BOOTSTRAP_RESAMPLES : resamplesOrSeed;
  const seed = maybeSeed === undefined ? resamplesOrSeed : maybeSeed;
  if (resamples !== BOOTSTRAP_RESAMPLES) {
    throw new RangeError(`bootstrap requires exactly ${BOOTSTRAP_RESAMPLES} resamples`);
  }
  if (!Number.isSafeInteger(seed)) {
    throw new RangeError("bootstrap seed must be a safe integer");
  }
  if (values.length === 0) return null;

  const next = createPrng(seed);
  const means = new Array<number>(BOOTSTRAP_RESAMPLES);
  for (let resample = 0; resample < BOOTSTRAP_RESAMPLES; resample += 1) {
    let total = 0;
    for (let draw = 0; draw < values.length; draw += 1) {
      total += values[Math.floor(next() * values.length)] ?? 0;
    }
    means[resample] = total / values.length;
  }

  means.sort((left, right) => left - right);
  return {
    lo: means[Math.floor(LOWER_PERCENTILE * (BOOTSTRAP_RESAMPLES - 1))] ?? 0,
    hi: means[Math.ceil(UPPER_PERCENTILE * (BOOTSTRAP_RESAMPLES - 1))] ?? 0,
  };
}

/** Exact binomial two-sided sign test; zeros do not contribute evidence. */
export function exactTwoSidedSignTest(values: readonly number[]): number {
  assertFiniteValues(values, "sign-test values");
  const nonzero = values.filter((value) => value !== 0);
  if (nonzero.length === 0) return 1;

  const positive = nonzero.filter((value) => value > 0).length;
  const tailCount = Math.min(positive, nonzero.length - positive);
  let probability = 2 ** -nonzero.length;
  let lowerTail = probability;
  for (let successes = 0; successes < tailCount; successes += 1) {
    probability *= (nonzero.length - successes) / (successes + 1);
    lowerTail += probability;
  }
  return Math.min(1, 2 * lowerTail);
}

/** Holm-Bonferroni adjusted p-values, returned in each input's original order. */
export function holmAdjust(pValues: readonly number[]): number[] {
  assertFiniteValues(pValues, "p-values");
  if (pValues.some((value) => value < 0 || value > 1)) {
    throw new RangeError("p-values must be within [0, 1]");
  }

  const ordered = pValues
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value || left.index - right.index);
  const adjusted = new Array<number>(pValues.length);
  let cumulativeMaximum = 0;
  for (const [rank, entry] of ordered.entries()) {
    cumulativeMaximum = Math.max(
      cumulativeMaximum,
      Math.min(1, entry.value * (ordered.length - rank)),
    );
    adjusted[entry.index] = cumulativeMaximum;
  }
  return adjusted;
}

/** The preregistered 18-singleton and four-interaction correction families never mix. */
export function holmAdjustPolicyFamilies(families: PolicyHolmFamilies): AdjustedPolicyHolmFamilies {
  if (families.singleton.length !== 18 || families.interaction.length !== 4) {
    throw new RangeError("expected 18 singleton and 4 interaction p-values");
  }
  return {
    singleton: holmAdjust(families.singleton),
    interaction: holmAdjust(families.interaction),
  };
}

export function repeatDirection(repeatMeans: readonly [number, number, number]): RepeatDirection {
  assertFiniteValues(repeatMeans, "repeat means");
  const positive = repeatMeans.filter((value) => value > 0).length;
  const negative = repeatMeans.filter((value) => value < 0).length;

  if (positive > 0 && negative > 0) return "conflict";
  if (positive >= 2) return "positive";
  if (negative >= 2) return "negative";
  if (positive === 0 && negative === 0) return "zero";
  return "insufficient";
}
