import { describe, expect, it } from "bun:test";
import {
  POLICY_CATALOG_VERSION,
  POLICY_PASSES,
  POLICY_PASS_IDS,
  POLICY_PROTECTION_CODES,
  POLICY_STAGES,
  type PolicyPassCatalogEntry,
} from "../../src/core/policy/catalog.ts";

const COMMON_REASONS: ReadonlySet<string> = new Set([
  "ineligible-starting-state",
  "predicate-miss",
  "configured-off",
  "stage-precondition-miss",
]);

describe("policy catalog", () => {
  it("keeps the closed pass inventory in production execution order", () => {
    expect(POLICY_PASSES.map((pass) => [pass.order, pass.id])).toEqual([
      [10, "evidence.fact-location"],
      [20, "evidence.self-refutation"],
      [30, "judgment.hypothetical"],
      [40, "evidence.grounding-token"],
      [50, "judgment.grounding-llm"],
      [60, "evidence.redaction-placeholder"],
      [70, "judgment.critic"],
      [80, "scope.diff"],
      [90, "scope.delta"],
      [100, "scope.session"],
      [110, "history.fp-signature"],
      [120, "history.cycle-rejected"],
      [130, "history.fp-cluster"],
      [140, "judgment.confidence"],
      [150, "judgment.reputation"],
      [160, "history.region-rejected"],
      [170, "judgment.test-security"],
      [180, "judgment.docs-cap"],
    ]);
  });

  it("keeps both explanatory stages in execution order", () => {
    expect(POLICY_STAGES.map((stage) => [stage.order, stage.id])).toEqual([
      [65, "aggregation.cluster"],
      [190, "verdict.compute"],
    ]);
  });

  it("keeps the closed applied-reason and protection contract", () => {
    expect(
      POLICY_PASSES.map((pass) => ({
        id: pass.id,
        reasons: pass.reason_codes.filter((reason) => !COMMON_REASONS.has(reason)),
        protections: pass.protection_codes,
      })),
    ).toEqual([
      {
        id: "evidence.fact-location",
        reasons: ["location-out-of-range", "evidence-line-reanchored"],
        protections: [],
      },
      {
        id: "evidence.self-refutation",
        reasons: ["terminal-self-refutation"],
        protections: ["security-correctness-floor", "deterministic-ground-truth"],
      },
      {
        id: "judgment.hypothetical",
        reasons: ["hypothetical-critical"],
        protections: ["security-correctness-floor", "deterministic-ground-truth"],
      },
      {
        id: "evidence.grounding-token",
        reasons: ["cited-token-absent"],
        protections: ["security-correctness-floor"],
      },
      {
        id: "judgment.grounding-llm",
        reasons: ["judge-ungrounded"],
        protections: ["security-correctness-floor"],
      },
      {
        id: "evidence.redaction-placeholder",
        reasons: ["placeholder-code-hallucination"],
        protections: ["security-correctness-floor", "secret-evidence-backstop"],
      },
      {
        id: "judgment.critic",
        reasons: ["critic-likely-fp"],
        protections: [
          "claimed-fixed-pin",
          "self-refutation-visibility",
          "security-correctness-floor",
          "corroborated-majority",
          "corroborated-unanimous",
          "high-precision-reviewer",
        ],
      },
      {
        id: "scope.diff",
        reasons: ["outside-changed-file", "outside-changed-lines", "preexisting-harness-config"],
        protections: ["out-of-diff-blocking-hatch"],
      },
      {
        id: "scope.delta",
        reasons: ["outside-delta-scope"],
        protections: [
          "claimed-fixed-pin",
          "security-correctness-floor",
          "critical-floor",
          "out-of-diff-blocking-hatch",
        ],
      },
      {
        id: "scope.session",
        reasons: ["foreign-to-session"],
        protections: ["out-of-diff-blocking-hatch"],
      },
      { id: "history.fp-signature", reasons: ["active-fp-signature"], protections: [] },
      {
        id: "history.cycle-rejected",
        reasons: ["cycle-signature-rejected"],
        protections: ["critical-floor", "security-correctness-floor"],
      },
      { id: "history.fp-cluster", reasons: ["active-fp-cluster"], protections: [] },
      {
        id: "judgment.confidence",
        reasons: ["below-confidence-floor"],
        protections: [
          "claimed-fixed-pin",
          "security-correctness-floor",
          "corroborated-majority",
          "corroborated-unanimous",
          "high-precision-reviewer",
        ],
      },
      {
        id: "judgment.reputation",
        reasons: ["unreliable-reviewer"],
        protections: [
          "claimed-fixed-pin",
          "security-floor",
          "correctness-demote-disabled",
          "corroborated-majority",
          "corroborated-unanimous",
          "critical-floor",
        ],
      },
      {
        id: "history.region-rejected",
        reasons: ["rejected-region-overlap"],
        protections: [
          "claimed-fixed-pin",
          "insufficient-distinct-rejections",
          "category-change",
          "severity-increase",
          "critical-floor",
          "security-correctness-floor",
        ],
      },
      {
        id: "judgment.test-security",
        reasons: ["test-only-security"],
        protections: ["mixed-category-cluster"],
      },
      {
        id: "judgment.docs-cap",
        reasons: ["docs-critical-cap"],
        protections: ["security-correctness-floor"],
      },
    ]);
  });

  it("keeps protection guards outside opportunity eligibility", () => {
    const opportunities = Object.fromEntries(
      POLICY_PASSES.map((pass) => [pass.id, pass.opportunity]),
    );
    expect(opportunities["evidence.self-refutation"]).toBe("blocking finding");
    expect(opportunities["judgment.hypothetical"]).toBe("CRITICAL finding");
    expect(opportunities["judgment.confidence"]).toBe(
      "blocking finding while the confidence floor is positive",
    );
    expect(opportunities["judgment.reputation"]).toBe(
      "blocking finding while unreliable reviewers exist",
    );
  });

  it("is a versioned JSON-data catalog with no executable entries", () => {
    expect(POLICY_CATALOG_VERSION).toBe("reviewgate.policy-catalog.v1");
    expect(POLICY_PASS_IDS).toHaveLength(18);
    expect(JSON.parse(JSON.stringify(POLICY_PASSES))).toEqual(POLICY_PASSES);
    expect(JSON.parse(JSON.stringify(POLICY_STAGES))).toEqual(POLICY_STAGES);
  });

  it("declares no protection code outside the closed per-pass contract", () => {
    const used = [...new Set(POLICY_PASSES.flatMap((pass) => [...pass.protection_codes]))].sort();
    expect([...POLICY_PROTECTION_CODES].sort()).toEqual(used);
  });

  it("keeps every static transition inside its pass action/reason contract", () => {
    for (const pass of POLICY_PASSES) {
      const transitionActions = [...new Set(pass.material_transitions.map((row) => row.action))]
        .sort()
        .join(",");
      const materialActions = pass.actions
        .filter((action) => action !== "protected")
        .sort()
        .join(",");
      expect(transitionActions).toBe(materialActions);
      expect(
        pass.material_transitions.every(
          (row) =>
            pass.reason_codes.some((reason) => reason === row.reason_code) &&
            !COMMON_REASONS.has(row.reason_code),
        ),
      ).toBe(true);
      expect(new Set(pass.material_transitions.map((row) => JSON.stringify(row))).size).toBe(
        pass.material_transitions.length,
      );
      expect(pass.actions.some((action) => action === "protected")).toBe(
        pass.protection_codes.length > 0,
      );
      expect(pass.protection_rules.length > 0).toBe(pass.protection_codes.length > 0);
      expect(
        pass.protection_codes.every((code) =>
          pass.protection_rules.some((rule) => rule.protected_by === code),
        ),
      ).toBe(true);
      expect(
        pass.protection_rules.every(
          (rule) =>
            pass.protection_codes.some((code) => code === rule.protected_by) &&
            pass.reason_codes.some((reason) => reason === rule.reason_code) &&
            !COMMON_REASONS.has(rule.reason_code),
        ),
      ).toBe(true);
      expect(new Set(pass.protection_rules.map((rule) => JSON.stringify(rule))).size).toBe(
        pass.protection_rules.length,
      );
    }
  });

  it("keeps protection guards bound to their production severities", () => {
    const passes: readonly PolicyPassCatalogEntry[] = POLICY_PASSES;
    const critic = passes.find((pass) => pass.id === "judgment.critic");
    const cycle = passes.find((pass) => pass.id === "history.cycle-rejected");
    expect(
      critic?.protection_rules.some(
        (rule) => rule.protected_by === "high-precision-reviewer" && rule.before === "INFO",
      ),
    ).toBe(false);
    expect(
      critic?.protection_rules.some(
        (rule) => rule.protected_by === "self-refutation-visibility" && rule.before === "INFO",
      ),
    ).toBe(true);
    expect(
      cycle?.protection_rules.some(
        (rule) => rule.protected_by === "critical-floor" && rule.before === "WARN",
      ),
    ).toBe(false);
  });
});
