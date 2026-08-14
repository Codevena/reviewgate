import { createHash } from "node:crypto";
import { canonicalJson } from "../../src/audit/canonical.ts";

const STATEFUL = [
  "history.fp-signature",
  "history.cycle-rejected",
  "history.fp-cluster",
  "judgment.reputation",
  "history.region-rejected",
] as const;
const HISTORY_INTERACTION = [
  "history.fp-signature",
  "history.cycle-rejected",
  "history.fp-cluster",
  "history.region-rejected",
] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function binding(ref: string): { ref: string; sha256: string } {
  return { ref, sha256: sha256(ref) };
}

function truth(blockingFp: number, blockingFn: number, blockingTp: number) {
  return { blocking_fp: blockingFp, blocking_fn: blockingFn, blocking_tp: blockingTp };
}

function turn(turnIndex: number) {
  return {
    turn_index: turnIndex,
    opportunity: { summary: 1, evaluations: 1, stages: 0, observed: true },
    baseline: {
      truth: truth(0, 1, 0),
      errors: [],
      state: {
        digest: "c".repeat(64),
        implicit_outcomes: turnIndex,
        history_reads: 4,
        history_writes: 1,
      },
    },
    counterfactual: {
      truth: truth(0, 0, 1),
      errors: [{ kind: "blocking-fn", identity: `seed-${turnIndex}` }],
      state: {
        digest: "d".repeat(64),
        implicit_outcomes: 0,
        history_reads: 4,
        history_writes: 0,
      },
    },
  };
}

/** A schema-valid derived output; it is intentionally not source authority. */
export function validPolicyRigEvidence(): unknown {
  const manifest = {
    schema: "reviewgate.policy-rig-scenarios.v1" as const,
    scenarios: STATEFUL.flatMap((passId) =>
      Array.from({ length: 3 }, (_, index) => ({
        id: `${passId}-${index + 1}`,
        pass_id: passId,
        manifest: binding(`rig/${passId}-${index + 1}.json`),
        result: binding(`rig/${passId}-${index + 1}.result.json`),
        script: binding(`rig/${passId}-${index + 1}.script.json`),
        initial_state: binding(`state/${passId}-${index + 1}.json`),
        expected_opportunity_turns: 2,
      })),
    ),
  };
  const scenarioManifest = binding("rig/scenarios.json");
  const artifacts = [
    { ...scenarioManifest, kind: "rig" as const },
    ...manifest.scenarios.flatMap((scenario) => [
      { ...scenario.manifest, kind: "rig" as const },
      { ...scenario.result, kind: "rig" as const },
      { ...scenario.script, kind: "rig" as const },
      { ...scenario.initial_state, kind: "state" as const },
    ]),
  ].sort((left, right) => left.ref.localeCompare(right.ref));
  return {
    schema: "reviewgate.policy-rig-evidence.v1",
    scenario_manifest: scenarioManifest,
    manifest,
    authoritative: true,
    source_commit: "a".repeat(40),
    artifacts,
    artifact_inventory_sha256: sha256(canonicalJson(artifacts)),
    sequences: manifest.scenarios.map((scenario) => ({
      scenario_id: scenario.id,
      pass_id: scenario.pass_id,
      authoritative: true,
      opportunity_turns: 2,
      truth_effects: {
        baseline: truth(0, 2, 0),
        ablated: truth(0, 0, 2),
        error_reduction: -2,
      },
      turns: [turn(1), turn(2)],
      history_interaction: HISTORY_INTERACTION.includes(scenario.pass_id as never)
        ? {
            pass_ids: [...HISTORY_INTERACTION],
            opportunity_turns: 2,
            truth_effects: {
              baseline: truth(0, 2, 0),
              ablated: truth(0, 0, 2),
              error_reduction: -2,
            },
            turns: [turn(1), turn(2)],
          }
        : null,
      manifest: scenario.manifest,
      result: scenario.result,
      script: scenario.script,
      initial_state: scenario.initial_state,
    })),
  };
}

export function validPolicyDogfoodSnapshot(): unknown {
  return {
    schema: "reviewgate.policy-dogfood-snapshot.v1",
    input_manifest: binding("dogfood/input.json"),
    attestation: binding("dogfood/attestation.json"),
    labels: [],
    exclusions: {},
  };
}
