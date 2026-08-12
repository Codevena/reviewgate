import { describe, expect, test } from "bun:test";
import {
  type RepeatCaseEffect,
  collapseCaseRepeats,
  exactTwoSidedSignTest,
  holmAdjust,
  holmAdjustPolicyFamilies,
  percentileBootstrap95,
  repeatDirection,
} from "../../src/stats/policy/statistics.ts";

function effect(caseId: string, repeat: 1 | 2 | 3, errorReduction: number): RepeatCaseEffect {
  return { caseId, repeat, errorReduction };
}

const BOOTSTRAP_VALUES = [-15, -10, -5, 0, 5, 10, 15];
const BOOTSTRAP_INTERVAL = {
  lo: -7.142857142857143,
  hi: 7.142857142857143,
};

describe("policy statistics", () => {
  test("collapses the three repeats of each independent case in code-unit case order", () => {
    expect(
      collapseCaseRepeats([
        effect("ä-case", 3, -3),
        effect("z-case", 2, 2),
        effect("ä-case", 1, -1),
        effect("z-case", 1, 1),
        effect("ä-case", 2, -2),
        effect("z-case", 3, 3),
      ]),
    ).toEqual([
      { caseId: "z-case", mean: 2, repeats: [1, 2, 3] },
      { caseId: "ä-case", mean: -2, repeats: [-1, -2, -3] },
    ]);
  });

  test("rejects incomplete, duplicate, and out-of-range repeat rows", () => {
    expect(() => collapseCaseRepeats([effect("case-a", 1, 1), effect("case-a", 2, 1)])).toThrow(
      /exactly three repeats/i,
    );
    expect(() =>
      collapseCaseRepeats([
        effect("case-a", 1, 1),
        effect("case-a", 1, 2),
        effect("case-a", 2, 1),
        effect("case-a", 3, 1),
      ]),
    ).toThrow(/duplicate/i);
    expect(() =>
      collapseCaseRepeats([
        effect("case-a", 0 as 1, 1),
        effect("case-a", 2, 1),
        effect("case-a", 3, 1),
      ]),
    ).toThrow(/repeat/i);
  });

  test("uses an exact two-sided sign test over nonzero case effects", () => {
    expect(exactTwoSidedSignTest([1, 1, 1, 1])).toBe(0.125);
    expect(exactTwoSidedSignTest([-1, 0, -1, -1])).toBe(0.25);
    expect(exactTwoSidedSignTest([])).toBe(1);
  });

  test("reports only stable repeat directions", () => {
    expect(repeatDirection([1, 2, 0])).toBe("positive");
    expect(repeatDirection([-1, -2, 0])).toBe("negative");
    expect(repeatDirection([0, 0, 0])).toBe("zero");
    expect(repeatDirection([1, -1, 0])).toBe("conflict");
    expect(repeatDirection([1, 0, 0])).toBe("insufficient");
  });

  test("uses exactly 10,000 deterministic bootstrap resamples from the provided seed", () => {
    const first = percentileBootstrap95(BOOTSTRAP_VALUES, 20_260_811);
    const second = percentileBootstrap95(BOOTSTRAP_VALUES, 20_260_811);
    const otherSeed = percentileBootstrap95(BOOTSTRAP_VALUES, 20_260_812);

    expect(first).toEqual(BOOTSTRAP_INTERVAL);
    expect(second).toEqual(BOOTSTRAP_INTERVAL);
    expect(otherSeed).toEqual({ lo: -7.142857142857143, hi: 7.857142857142857 });
    expect(otherSeed).not.toEqual(first);
    expect(percentileBootstrap95([] as number[], 20_260_811)).toBeNull();
  });

  test("does not draw bootstrap samples from Math.random", () => {
    const original = Math.random;
    try {
      Math.random = () => 0;
      const lowerOnly = percentileBootstrap95(BOOTSTRAP_VALUES, 20_260_811);
      Math.random = () => 0.999999;
      const upperOnly = percentileBootstrap95(BOOTSTRAP_VALUES, 20_260_811);

      expect(lowerOnly).toEqual(BOOTSTRAP_INTERVAL);
      expect(upperOnly).toEqual(BOOTSTRAP_INTERVAL);
    } finally {
      Math.random = original;
    }
  });

  test("Holm adjustment preserves original order and cumulative sorted maxima", () => {
    const raw = [0.01, 0.04, 0.03];
    const adjusted = holmAdjust(raw);

    expect(adjusted).toEqual([0.03, 0.06, 0.06]);
    for (const [index, value] of adjusted.entries()) {
      expect(value).toBeGreaterThanOrEqual(raw[index] ?? 0);
      expect(value).toBeLessThanOrEqual(1);
    }
    expect([...adjusted].sort((left, right) => left - right)).toEqual([0.03, 0.06, 0.06]);
  });

  test("adjusts singleton and interaction p-values in their independent Holm families", () => {
    const corrected = holmAdjustPolicyFamilies({
      singleton: Array.from({ length: 18 }, () => 0.01),
      interaction: Array.from({ length: 4 }, () => 0.01),
    });

    expect(corrected.singleton).toEqual(Array.from({ length: 18 }, () => 0.18));
    expect(corrected.interaction).toEqual(Array.from({ length: 4 }, () => 0.04));
    expect(() => holmAdjustPolicyFamilies({ singleton: [0.01], interaction: [0.01] })).toThrow(
      /18 singleton.*4 interaction/i,
    );
  });
});
