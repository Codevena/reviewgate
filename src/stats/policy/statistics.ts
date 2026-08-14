import type { CaseResult } from "../../schemas/bench-result.ts";
import type { PolicyMeasurement } from "../../schemas/policy-measurement.ts";
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

type PolicyStatistics = PolicyMeasurement["passes"][number]["evidence"]["statistics"];
type PolicyCaseEffect = PolicyStatistics["case_effects"][number];

export interface PolicyBenchCaseEffect {
  readonly caseId: string;
  readonly repeat: 1 | 2 | 3;
  readonly errorReduction: number;
  readonly baseline: CaseResult;
  readonly ablated: CaseResult;
  readonly baselineDossier: { ref: string; sha256: string };
  readonly ablatedDossier: { ref: string; sha256: string };
}

interface TruthCounts {
  blocking_fp: number;
  blocking_fn: number;
  blocking_tp: number;
}

function truthCounts(row: CaseResult): TruthCounts {
  if (row.policy_truth === undefined) {
    throw new RangeError(`case ${row.id} has no policy truth`);
  }
  return {
    blocking_fp: row.policy_truth.findings.filter(
      (finding) => finding.outcome === "FP" && finding.severity !== "INFO",
    ).length,
    blocking_fn: row.policy_truth.fn_label_indexes.length,
    blocking_tp: row.policy_truth.findings.filter(
      (finding) => finding.outcome === "TP" && finding.severity !== "INFO",
    ).length,
  };
}

function addTruth(left: TruthCounts, right: TruthCounts): TruthCounts {
  return {
    blocking_fp: left.blocking_fp + right.blocking_fp,
    blocking_fn: left.blocking_fn + right.blocking_fn,
    blocking_tp: left.blocking_tp + right.blocking_tp,
  };
}

function zeroTruth(): TruthCounts {
  return { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 };
}

function pairedDelta(baseline: number | null, ablated: number | null) {
  if (baseline === null || ablated === null) {
    return { baseline: null, ablated: null, delta: null };
  }
  return { baseline, ablated, delta: ablated - baseline };
}

function unavailableDelta() {
  return { baseline: null, ablated: null, delta: null };
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function traceOutcome(row: CaseResult): {
  blocking: number;
  severity: { critical: number; warn: number; info: number };
  verdict: "PASS" | "SOFT-PASS" | "FAIL";
} | null {
  const final = row.policy_trace?.trace?.final;
  if (
    final === undefined ||
    (final.verdict !== "PASS" && final.verdict !== "SOFT-PASS" && final.verdict !== "FAIL")
  ) {
    return null;
  }
  return {
    blocking: final.counts.critical + final.counts.warn,
    severity: final.counts,
    verdict: final.verdict,
  };
}

/**
 * The sole calculation for source-bound Bench case effects. Assembly and final publication
 * verification call this with their independently verified inputs so neither accepts a merely
 * self-consistent persisted statistic.
 */
export function policyBenchStatistics(
  caseEffects: readonly PolicyBenchCaseEffect[],
  seed: number,
): {
  collapsed: CollapsedCaseEffect[];
  repeatMeans: [number, number, number];
  statistics: PolicyStatistics;
} {
  const ordered = [...caseEffects].sort(
    (left, right) =>
      compareCodeUnits(left.caseId, right.caseId) ||
      left.repeat - right.repeat ||
      compareCodeUnits(left.baselineDossier.ref, right.baselineDossier.ref),
  );
  const collapsed = collapseCaseRepeats(ordered);
  const values = collapsed.map((row) => row.mean);
  const interval = percentileBootstrap95(values, 10_000, seed) ?? { lo: 0, hi: 0 };
  const repeatMeans = ([1, 2, 3] as const).map((repeat) => {
    const rows = ordered.filter((row) => row.repeat === repeat);
    return rows.length === 0
      ? 0
      : rows.reduce((total, row) => total + row.errorReduction, 0) / rows.length;
  }) as [number, number, number];
  const baselineTruth = ordered.reduce(
    (total, effect) => addTruth(total, truthCounts(effect.baseline)),
    zeroTruth(),
  );
  const ablatedTruth = ordered.reduce(
    (total, effect) => addTruth(total, truthCounts(effect.ablated)),
    zeroTruth(),
  );
  const baselineCounts = ordered.reduce(
    (total, effect) => ({
      tp: total.tp + effect.baseline.counts.tp,
      fp: total.fp + effect.baseline.counts.fp,
      fn: total.fn + effect.baseline.counts.fn,
    }),
    { tp: 0, fp: 0, fn: 0 },
  );
  const ablatedCounts = ordered.reduce(
    (total, effect) => ({
      tp: total.tp + effect.ablated.counts.tp,
      fp: total.fp + effect.ablated.counts.fp,
      fn: total.fn + effect.ablated.counts.fn,
    }),
    { tp: 0, fp: 0, fn: 0 },
  );
  const rate = (numerator: number, denominator: number): number | null =>
    denominator === 0 ? null : numerator / denominator;
  const traceOutcomes = ordered.map((effect) => ({
    baseline: traceOutcome(effect.baseline),
    ablated: traceOutcome(effect.ablated),
  }));
  const traceMetricsAvailable = traceOutcomes.every(
    (outcome) => outcome.baseline !== null && outcome.ablated !== null,
  );
  const traceDeltas = (() => {
    if (!traceMetricsAvailable) {
      return {
        blocking: unavailableDelta(),
        severity: {
          critical: unavailableDelta(),
          warn: unavailableDelta(),
          info: unavailableDelta(),
        },
        verdict: {
          pass: unavailableDelta(),
          soft_pass: unavailableDelta(),
          fail: unavailableDelta(),
        },
      };
    }
    const baseline = traceOutcomes.map(
      (outcome) => outcome.baseline as NonNullable<typeof outcome.baseline>,
    );
    const ablated = traceOutcomes.map(
      (outcome) => outcome.ablated as NonNullable<typeof outcome.ablated>,
    );
    const sum = (values: readonly number[]): number =>
      values.reduce((total, value) => total + value, 0);
    const verdictCount = (
      values: readonly (typeof baseline)[number][],
      verdict: (typeof baseline)[number]["verdict"],
    ): number => values.filter((value) => value.verdict === verdict).length;
    return {
      blocking: pairedDelta(
        sum(baseline.map((value) => value.blocking)),
        sum(ablated.map((value) => value.blocking)),
      ),
      severity: {
        critical: pairedDelta(
          sum(baseline.map((value) => value.severity.critical)),
          sum(ablated.map((value) => value.severity.critical)),
        ),
        warn: pairedDelta(
          sum(baseline.map((value) => value.severity.warn)),
          sum(ablated.map((value) => value.severity.warn)),
        ),
        info: pairedDelta(
          sum(baseline.map((value) => value.severity.info)),
          sum(ablated.map((value) => value.severity.info)),
        ),
      },
      verdict: {
        pass: pairedDelta(verdictCount(baseline, "PASS"), verdictCount(ablated, "PASS")),
        soft_pass: pairedDelta(
          verdictCount(baseline, "SOFT-PASS"),
          verdictCount(ablated, "SOFT-PASS"),
        ),
        fail: pairedDelta(verdictCount(baseline, "FAIL"), verdictCount(ablated, "FAIL")),
      },
    };
  })();
  return {
    collapsed,
    repeatMeans,
    statistics: {
      case_effects: ordered.map(
        (effect): PolicyCaseEffect => ({
          case_id: effect.caseId,
          repeat: effect.repeat,
          error_reduction: effect.errorReduction,
          baseline_dossier: effect.baselineDossier,
          ablated_dossier: effect.ablatedDossier,
        }),
      ),
      raw_effects: ordered.map((effect) => effect.errorReduction),
      mean_error_reduction:
        values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length,
      median_error_reduction: median(values),
      repeat_directions:
        ordered.length === 0
          ? []
          : repeatMeans.map((mean, index) => ({
              repeat: (index + 1) as 1 | 2 | 3,
              mean_error_reduction: mean,
              direction: mean > 0 ? "positive" : mean < 0 ? "negative" : "zero",
            })),
      error_components: {
        blocking_fp: pairedDelta(baselineTruth.blocking_fp, ablatedTruth.blocking_fp),
        blocking_fn: pairedDelta(baselineTruth.blocking_fn, ablatedTruth.blocking_fn),
      },
      precision_delta: pairedDelta(
        rate(baselineCounts.tp, baselineCounts.tp + baselineCounts.fp),
        rate(ablatedCounts.tp, ablatedCounts.tp + ablatedCounts.fp),
      ),
      recall_delta: pairedDelta(
        rate(baselineCounts.tp, baselineCounts.tp + baselineCounts.fn),
        rate(ablatedCounts.tp, ablatedCounts.tp + ablatedCounts.fn),
      ),
      blocking_count_delta: traceDeltas.blocking,
      severity_deltas: traceDeltas.severity,
      verdict_deltas: traceDeltas.verdict,
      interval,
      p_value: exactTwoSidedSignTest(values),
      adjusted_p_value: 1,
    },
  };
}

/** Shared descriptive Rig/Dogfood calculation for source-bound independent units. */
export function policyIndependentSequenceStatistics(
  values: readonly number[],
  seed: number,
  truthEffects?: { baseline: TruthCounts; ablated: TruthCounts },
): PolicyStatistics {
  const interval = percentileBootstrap95(values, 10_000, seed) ?? { lo: 0, hi: 0 };
  const mean =
    values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
  return {
    case_effects: [],
    raw_effects: [...values],
    mean_error_reduction: mean,
    median_error_reduction: median(values),
    repeat_directions: [],
    error_components:
      truthEffects === undefined
        ? { blocking_fp: unavailableDelta(), blocking_fn: unavailableDelta() }
        : {
            blocking_fp: pairedDelta(
              truthEffects.baseline.blocking_fp,
              truthEffects.ablated.blocking_fp,
            ),
            blocking_fn: pairedDelta(
              truthEffects.baseline.blocking_fn,
              truthEffects.ablated.blocking_fn,
            ),
          },
    precision_delta: unavailableDelta(),
    recall_delta: unavailableDelta(),
    blocking_count_delta: unavailableDelta(),
    severity_deltas: {
      critical: unavailableDelta(),
      warn: unavailableDelta(),
      info: unavailableDelta(),
    },
    verdict_deltas: {
      pass: unavailableDelta(),
      soft_pass: unavailableDelta(),
      fail: unavailableDelta(),
    },
    interval,
    p_value: exactTwoSidedSignTest(values),
    adjusted_p_value: 1,
  };
}
