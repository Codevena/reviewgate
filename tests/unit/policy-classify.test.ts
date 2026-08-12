import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { POLICY_PASSES, type PolicyPassId } from "../../src/core/policy/catalog.ts";
import {
  PolicyPassClassificationSchema,
  type PolicyPassEvidence,
} from "../../src/schemas/policy-measurement.ts";
import {
  type PolicyInteractionEvidenceInput,
  type PolicyPassClassificationFacts,
  classifyPolicyPasses,
} from "../../src/stats/policy/classify.ts";

function defaultPass() {
  const value = POLICY_PASSES.find((entry) => entry.id === "judgment.hypothetical");
  if (value === undefined) throw new Error("fixture pass missing from catalog");
  return value;
}

type FixtureOptions = {
  opportunityCases?: number;
  signatures?: number;
  rawEffects?: number[];
  uniqueContribution?: "prevented-blocking-fp" | "preserved-blocking-tp" | "required-backstop";
  authoritative?: boolean;
  passId?: PolicyPassId;
  rawEvidenceRefs?: string[];
};

function onePass(options: FixtureOptions = {}): PolicyPassEvidence[] {
  const fixturePass = POLICY_PASSES.find(
    (entry) => entry.id === (options.passId ?? defaultPass().id),
  );
  if (fixturePass === undefined) throw new Error("fixture pass missing from catalog");
  const ref = options.rawEvidenceRefs?.[0] ?? "artifacts/policy/evidence.json";
  return [
    {
      pass_id: fixturePass.id,
      lane:
        fixturePass.id.startsWith("history.") || fixturePass.id === "judgment.reputation"
          ? "stateful-rig"
          : "stateless-bench",
      catalog_snapshot: {
        order: fixturePass.order,
        class: fixturePass.class,
        overlaps_with: [...fixturePass.overlaps_with],
        opportunity_sha256: createHash("sha256").update(fixturePass.opportunity).digest("hex"),
      },
      eligibility: { stateless: true, stateful: false, dogfood: true },
      authority: { stateless: options.authoritative ?? true, stateful: false, dogfood: true },
      opportunities: {
        cases: options.opportunityCases ?? 8,
        signatures: options.signatures ?? 15,
        turns: 0,
        runs: 3,
      },
      exclusions: [],
      truth_effects: {
        baseline: { blocking_fp: 2, blocking_fn: 2, blocking_tp: 4 },
        ablated: { blocking_fp: 2, blocking_fn: 2, blocking_tp: 4 },
        error_reduction: 0,
      },
      trace_totals: { applied: 0, would_apply: 0, protected: 0, no_opportunity: 0 },
      statistics: {
        raw_effects: options.rawEffects ?? [0, 0, 0],
        interval: { lo: 0, hi: 0 },
        p_value: 1,
        adjusted_p_value: 1,
      },
      unique_contributions: options.uniqueContribution
        ? [{ kind: options.uniqueContribution, evidence: { ref, sha256: "a".repeat(64) } }]
        : [],
      raw_evidence_refs: options.rawEvidenceRefs ?? [ref],
    },
  ];
}

function onlyPass(evidence: readonly PolicyPassEvidence[]): PolicyPassEvidence {
  const value = evidence[0];
  if (value === undefined) throw new Error("fixture must contain one pass");
  return value;
}

function facts(
  input: Partial<PolicyPassClassificationFacts> = {},
): PolicyPassClassificationFacts[] {
  return [
    {
      pass_id: defaultPass().id,
      ground_truth_harms: [],
      dogfood_dispositions: [],
      beneficial_effects: [],
      ...input,
    },
  ];
}

function classify(
  evidence = onePass(),
  passFacts: readonly PolicyPassClassificationFacts[] = facts(),
) {
  return classifyPolicyPasses(evidence, { passFacts, interactions: [] });
}

describe("policy pass classification", () => {
  test("keeps stateless opportunity and signature boundaries inconclusive", () => {
    expect(classify(onePass({ opportunityCases: 7, signatures: 15 }))[0]?.classification).toBe(
      "inconclusive",
    );
    expect(classify(onePass({ opportunityCases: 8, signatures: 14 }))[0]?.classification).toBe(
      "inconclusive",
    );
  });

  test("requires three stable stateless repeats", () => {
    expect(classify(onePass({ rawEffects: [1, -1, 0] }))[0]?.reasons).toContain(
      "direction-conflict",
    );
    expect(classify(onePass({ rawEffects: [1, 0, 0] }))[0]?.reasons).toContain(
      "direction-conflict",
    );
  });

  test("retains a direct unique contribution before considering two distinct harms", () => {
    const evidence = onePass({ uniqueContribution: "prevented-blocking-fp" });
    onlyPass(evidence).truth_effects.baseline.blocking_fn = 4;
    expect(
      classify(
        evidence,
        facts({
          ground_truth_harms: [
            { identity: "case-a", evidence_ref: "artifacts/policy/evidence.json" },
            { identity: "case-b", evidence_ref: "artifacts/policy/evidence.json" },
          ],
        }),
      )[0],
    ).toMatchObject({
      classification: "retain",
      harm_observed: true,
      vetoes: ["unique-prevented-fp"],
    });
  });

  test("labels two distinct ground-truth harms harmful", () => {
    const evidence = onePass();
    onlyPass(evidence).truth_effects.baseline.blocking_fn = 4;
    expect(
      classify(
        evidence,
        facts({
          ground_truth_harms: [
            { identity: "case-a", evidence_ref: "artifacts/policy/evidence.json" },
            { identity: "case-b", evidence_ref: "artifacts/policy/evidence.json" },
          ],
        }),
      )[0],
    ).toMatchObject({ classification: "harmful-candidate", harm_observed: true });
  });

  test("labels one ground-truth harm plus sufficient dogfood suppressed TP harmful", () => {
    const evidence = onePass();
    onlyPass(evidence).truth_effects.baseline.blocking_fn = 3;
    const dogfood = [
      ["a", "run-1", 1, "tp", "suppressed"],
      ["b", "run-2", 1, "fp", "none"],
      ["c", "run-3", 1, "fp", "none"],
      ["d", "run-1", 2, "fp", "none"],
      ["e", "run-2", 2, "fp", "none"],
    ].map(([identity, run_id, iter, disposition, effect]) => ({
      identity: identity as string,
      run_id: run_id as string,
      iter: iter as number,
      disposition: disposition as "tp" | "fp",
      effect: effect as "suppressed" | "none",
      evidence_ref: "artifacts/policy/evidence.json",
    }));
    expect(
      classify(
        evidence,
        facts({
          ground_truth_harms: [
            { identity: "case-a", evidence_ref: "artifacts/policy/evidence.json" },
          ],
          dogfood_dispositions: dogfood,
        }),
      )[0]?.classification,
    ).toBe("harmful-candidate");
  });

  test("does not manufacture dogfood TP harm from missing or historical unsigned decisions", () => {
    const evidence = onePass();
    onlyPass(evidence).exclusions = [
      { lane: "dogfood", code: "missing-decision", count: 1 },
      { lane: "dogfood", code: "historical-unsigned-decision", count: 1 },
    ];
    const passFacts = facts({
      dogfood_dispositions: [
        {
          identity: "a",
          run_id: "run-1",
          iter: 1,
          disposition: "fp",
          effect: "none",
          evidence_ref: "artifacts/policy/evidence.json",
        },
        {
          identity: "b",
          run_id: "run-2",
          iter: 1,
          disposition: "tp",
          effect: "preserved",
          evidence_ref: "artifacts/policy/evidence.json",
        },
        {
          identity: "c",
          run_id: "run-3",
          iter: 1,
          disposition: "fp",
          effect: "none",
          evidence_ref: "artifacts/policy/evidence.json",
        },
        {
          identity: "d",
          run_id: "run-1",
          iter: 2,
          disposition: "tp",
          effect: "preserved",
          evidence_ref: "artifacts/policy/evidence.json",
        },
      ],
    });
    const result = classify(evidence, passFacts)[0];
    expect(result?.classification).toBe("inconclusive");
    expect(result?.harm_observed).toBe(false);
  });

  test("returns delete-candidate for sufficient zero effect without benefits", () => {
    const result = classify()[0];
    expect(result).toMatchObject({
      classification: "delete-candidate",
      reasons: ["sufficient-covered-zero-unique-benefit"],
    });
    expect(() => PolicyPassClassificationSchema.parse(result)).not.toThrow();
  });

  test("requires three stateful sequences with two opportunity turns each", () => {
    const base = onePass({ passId: "history.fp-signature" });
    onlyPass(base).opportunities = { cases: 3, signatures: 0, turns: 6, runs: 3 };
    const statefulFacts = facts({ pass_id: "history.fp-signature" });
    expect(classify(base, statefulFacts)[0]?.classification).toBe("delete-candidate");

    onlyPass(base).opportunities.cases = 2;
    expect(classify(base, statefulFacts)[0]?.classification).toBe("inconclusive");
    onlyPass(base).opportunities.cases = 3;
    onlyPass(base).opportunities.turns = 5;
    expect(classify(base, statefulFacts)[0]?.classification).toBe("inconclusive");
  });

  test("requires five dogfood dispositions from three runs before one harm corroborates", () => {
    const evidence = onePass();
    onlyPass(evidence).truth_effects.baseline.blocking_fn = 3;
    const disposition = (identity: string, run_id: string, iter: number) => ({
      identity,
      run_id,
      iter,
      disposition: "tp" as const,
      effect: "suppressed" as const,
      evidence_ref: "artifacts/policy/evidence.json",
    });
    const fourAcrossThree = [
      disposition("a", "run-1", 1),
      disposition("b", "run-2", 1),
      disposition("c", "run-3", 1),
      disposition("d", "run-1", 2),
    ];
    expect(
      classify(
        evidence,
        facts({
          ground_truth_harms: [
            { identity: "case-a", evidence_ref: "artifacts/policy/evidence.json" },
          ],
          dogfood_dispositions: fourAcrossThree,
        }),
      )[0]?.classification,
    ).toBe("inconclusive");

    const fiveAcrossTwo = [
      disposition("a", "run-1", 1),
      disposition("b", "run-2", 1),
      disposition("c", "run-1", 1),
      disposition("d", "run-2", 1),
      disposition("e", "run-1", 1),
    ];
    expect(
      classify(
        evidence,
        facts({
          ground_truth_harms: [
            { identity: "case-a", evidence_ref: "artifacts/policy/evidence.json" },
          ],
          dogfood_dispositions: fiveAcrossTwo,
        }),
      )[0]?.classification,
    ).toBe("inconclusive");
  });

  test("allows only a retained overlapping pass to cover an observed benefit", () => {
    const retained = onlyPass(
      onePass({
        passId: "evidence.fact-location",
        uniqueContribution: "prevented-blocking-fp",
        rawEvidenceRefs: ["artifacts/policy/fact.json"],
      }),
    );
    const target = onlyPass(
      onePass({
        passId: "evidence.self-refutation",
        rawEvidenceRefs: ["artifacts/policy/self.json"],
      }),
    );
    target.truth_effects.ablated.blocking_fp = 3;
    const targetFacts = {
      pass_id: target.pass_id,
      ground_truth_harms: [],
      dogfood_dispositions: [],
      beneficial_effects: [
        {
          identity: "benefit-a",
          evidence_ref: "artifacts/policy/self.json",
          reproduced_by_pass_ids: [retained.pass_id],
        },
      ],
    } satisfies PolicyPassClassificationFacts;
    expect(
      classifyPolicyPasses([target, retained], { passFacts: [targetFacts] }).map(
        (row) => row.classification,
      ),
    ).toEqual(["retain", "delete-candidate"]);

    expect(classifyPolicyPasses([target], { passFacts: [targetFacts] })[0]?.classification).toBe(
      "inconclusive",
    );
  });

  test("keeps harmful group removal inconclusive without allocating a retain", () => {
    const evidence = onePass({
      rawEvidenceRefs: ["artifacts/policy/evidence.json", "interactions/0.json"],
    });
    const interaction = {
      pass_ids: [defaultPass().id],
      artifact: { ref: "interactions/0.json", sha256: "b".repeat(64) },
      evidence: {
        authoritative: true,
        eligibility: { stateless: true, stateful: false, dogfood: false },
        authority: { stateless: true, stateful: false, dogfood: false },
        opportunities: { cases: 8, signatures: 15, turns: 0, runs: 0 },
        exclusions: [],
        truth_effects: {
          baseline: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 1 },
          ablated: { blocking_fp: 1, blocking_fn: 0, blocking_tp: 1 },
          error_reduction: 1,
        },
        statistics: {
          raw_effects: [-1, -1, -1],
          interval: { lo: -1, hi: -1 },
          p_value: 1,
          adjusted_p_value: 1,
        },
        raw_evidence_refs: ["interactions/0.json"],
      },
    } as PolicyInteractionEvidenceInput;
    const result = classifyPolicyPasses(evidence, { interactions: [interaction] })[0];
    expect(result).toMatchObject({ classification: "inconclusive", vetoes: [] });
    expect(result?.reasons).toContain("interaction-removal-harm");
  });

  test("does not veto deletion when group ablation improves the primary error", () => {
    const evidence = onePass({
      rawEvidenceRefs: ["artifacts/policy/evidence.json", "interactions/0.json"],
    });
    const interaction = {
      pass_ids: [defaultPass().id],
      artifact: { ref: "interactions/0.json", sha256: "b".repeat(64) },
      evidence: {
        authoritative: true,
        eligibility: { stateless: true, stateful: false, dogfood: false },
        authority: { stateless: true, stateful: false, dogfood: false },
        opportunities: { cases: 8, signatures: 15, turns: 0, runs: 0 },
        exclusions: [],
        truth_effects: {
          baseline: { blocking_fp: 1, blocking_fn: 0, blocking_tp: 1 },
          ablated: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 1 },
          error_reduction: -1,
        },
        statistics: {
          raw_effects: [-1, -1, -1],
          interval: { lo: -1, hi: -1 },
          p_value: 1,
          adjusted_p_value: 1,
        },
        raw_evidence_refs: ["interactions/0.json"],
      },
    } as PolicyInteractionEvidenceInput;
    expect(classifyPolicyPasses(evidence, { interactions: [interaction] })[0]?.classification).toBe(
      "delete-candidate",
    );
  });

  test("blocks deletion when negative primary error reduction lacks bound harm facts", () => {
    const evidence = onePass();
    onlyPass(evidence).truth_effects.error_reduction = -1;
    expect(classify(evidence)[0]).toMatchObject({
      classification: "inconclusive",
      reasons: ["incomplete-authority"],
    });
  });

  test("requires facts for aggregate harm and rejects an unknown raw reference", () => {
    const evidence = onePass();
    onlyPass(evidence).truth_effects.baseline.blocking_fn = 3;
    expect(classify(evidence)[0]?.reasons).toContain("incomplete-authority");
    expect(
      classify(
        onePass(),
        facts({
          beneficial_effects: [
            { identity: "benefit", evidence_ref: "outside-ref", reproduced_by_pass_ids: [] },
          ],
        }),
      )[0]?.reasons,
    ).toContain("incomplete-authority");
  });

  test("does not retain an unbound unique contribution or unordered identity facts", () => {
    const invalidContribution = onePass({ uniqueContribution: "prevented-blocking-fp" });
    const uniqueContribution = onlyPass(invalidContribution).unique_contributions[0];
    if (uniqueContribution === undefined) throw new Error("fixture unique contribution missing");
    uniqueContribution.evidence.ref = "outside-ref";
    expect(classify(invalidContribution)[0]).toMatchObject({
      classification: "inconclusive",
      vetoes: [],
      reasons: ["incomplete-authority"],
    });

    const unordered = facts({
      ground_truth_harms: [
        { identity: "case-b", evidence_ref: "artifacts/policy/evidence.json" },
        { identity: "case-a", evidence_ref: "artifacts/policy/evidence.json" },
      ],
    });
    const evidence = onePass();
    onlyPass(evidence).truth_effects.baseline.blocking_fn = 4;
    expect(classify(evidence, unordered)[0]?.reasons).toContain("incomplete-authority");
  });
});
