import { POLICY_PASSES, POLICY_PASS_IDS, type PolicyPassId } from "./catalog.ts";

/** Every ablatable pass is measured once in catalog order. */
export const POLICY_MEASUREMENT_SINGLETONS = POLICY_PASS_IDS;

/** Predeclared group ablations; their order is part of the registered experiment. */
export const POLICY_MEASUREMENT_INTERACTIONS = [
  ["judgment.critic", "judgment.confidence", "judgment.reputation"],
  ["scope.diff", "scope.delta", "scope.session"],
  [
    "history.cycle-rejected",
    "history.region-rejected",
    "history.fp-signature",
    "history.fp-cluster",
  ],
  [
    "evidence.fact-location",
    "evidence.grounding-token",
    "judgment.grounding-llm",
    "evidence.redaction-placeholder",
    "evidence.self-refutation",
  ],
] as const satisfies readonly (readonly PolicyPassId[])[];

export const POLICY_MEASUREMENT_THRESHOLDS = {
  statelessCases: 8,
  statelessSignatures: 15,
  repeats: 3,
  statefulSequences: 3,
  opportunityTurnsPerSequence: 2,
  dogfoodDispositions: 5,
  dogfoodRuns: 3,
  bootstrapResamples: 10_000,
} as const;

export type PolicyMeasurementLane = "stateless-bench" | "stateful-rig";
export type PolicyClassification =
  | "retain"
  | "delete-candidate"
  | "harmful-candidate"
  | "inconclusive";

const STATEFUL_ORDERS = new Set([110, 120, 130, 150, 160]);

/** Primary lanes are derived from the catalog order, not maintained as a second pass registry. */
export const POLICY_MEASUREMENT_LANES = Object.fromEntries(
  POLICY_PASSES.map((pass) => [
    pass.id,
    STATEFUL_ORDERS.has(pass.order) ? "stateful-rig" : "stateless-bench",
  ]),
) as Record<PolicyPassId, PolicyMeasurementLane>;
