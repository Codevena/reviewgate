import { describe, expect, it } from "bun:test";
import { POLICY_PASS_IDS, POLICY_STAGES } from "../../src/core/policy/catalog.ts";
import {
  EXPLANATORY_STAGE_IDS,
  POLICY_PASS_CONTRACTS,
  runExplanatoryStageContract,
} from "../fixtures/policy-pass-contracts.ts";

describe("policy pass contract matrix", () => {
  it("contains one literal contract in catalog order for every policy pass", () => {
    expect(POLICY_PASS_CONTRACTS.map(({ passId }) => passId)).toEqual([...POLICY_PASS_IDS]);
  });

  it("accepts both explanatory stages and preserves material effect order", () => {
    const result = runExplanatoryStageContract();
    expect(EXPLANATORY_STAGE_IDS).toEqual(POLICY_STAGES.map(({ id }) => id));
    expect(result.stages.map(({ stage_id }) => stage_id)).toEqual([...EXPLANATORY_STAGE_IDS]);
    expect(result.effects.map(({ pass_id }) => pass_id)).toEqual([
      "evidence.redaction-placeholder",
      "judgment.critic",
    ]);
    expect(result.effects.map(({ order }) => order)).toEqual([60, 70]);
  });
});

for (const contract of POLICY_PASS_CONTRACTS) {
  describe(contract.passId, () => {
    it("matches the literal numeric, severity, blocking, and inactive contract", () => {
      const actual = contract.run();
      const { expected } = contract;

      expect(actual.noOpportunity.tuple).toEqual(expected.noOpportunity);
      expect(actual.noMatch.tuple).toEqual(expected.noMatch);
      expect(actual.active.tuple).toEqual(expected.active);
      expect(actual.ablated.tuple).toEqual(expected.ablated);
      expect(actual.active.blocking).toBe(expected.activeBlocking);
      expect(actual.ablated.blocking).toBe(expected.ablatedBlocking);
      expect(actual.active.severities).toEqual(expected.activeSeverities);
      expect(actual.ablated.severities).toEqual(expected.ablatedSeverities);

      if (expected.protected === undefined) {
        expect(actual.protected).toBeUndefined();
      } else {
        expect(actual.protected?.tuple).toEqual(expected.protected);
        expect(actual.protected?.blocking).toBe(expected.protectedBlocking);
        expect(actual.protected?.severities).toEqual(expected.protectedSeverities);
      }

      expect(actual.inactive).toEqual({
        pass_id: contract.passId,
        status: "not-run",
        reason_code: expected.inactiveReason,
      });
      expect(Object.keys(actual.inactive).sort()).toEqual(["pass_id", "reason_code", "status"]);

      if (expected.variant === undefined) {
        expect(actual.variant).toBeUndefined();
      } else {
        expect(actual.variant?.tuple).toEqual(expected.variant.tuple);
        expect(actual.variant?.blocking).toBe(expected.variant.blocking);
        expect(actual.variant?.severities).toEqual(expected.variant.severities);
      }
    });

    it("records the production transition and suppresses it under ablation", () => {
      const actual = contract.run();
      const activeEffects = actual.active.effects.filter(
        ({ pass_id }) => pass_id === contract.passId,
      );
      const ablatedEffects = actual.ablated.effects.filter(
        ({ pass_id }) => pass_id === contract.passId,
      );
      expect(activeEffects).toHaveLength(1);
      expect(actual.active.evaluations.map(({ result }) => result)).toEqual(["applied"]);
      expect(ablatedEffects).toEqual([]);
      expect(actual.ablated.evaluations.map(({ result }) => result)).toEqual(["would-apply"]);
      expect(actual.noOpportunity.evaluations.map(({ result }) => result)).toEqual([
        "no-opportunity",
      ]);
      expect(actual.noMatch.evaluations.map(({ result }) => result)).toEqual(["no-match"]);

      if (actual.protected !== undefined) {
        expect(
          actual.protected.effects.filter(({ pass_id }) => pass_id === contract.passId),
        ).toHaveLength(1);
        expect(actual.protected.evaluations.map(({ result }) => result)).toEqual(["protected"]);
      }
    });
  });
}
