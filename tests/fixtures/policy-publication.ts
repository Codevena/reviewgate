import { createHash } from "node:crypto";
import { canonicalJson } from "../../src/audit/canonical.ts";
import {
  identityOutcomesFromEvents,
  sortIdentityEvents,
  sortSingletonIdentityEvents,
  type PolicyIdentityEvent,
  type PolicySingletonIdentityEvent,
} from "../../src/core/policy/identity-events.ts";
import { PolicyRigEvidenceSchema } from "../../src/schemas/policy-measurement.ts";

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

function turn(turnIndex: number, withErrorEvents: boolean) {
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
      errors: withErrorEvents ? [{ kind: "blocking-fn", identity: `seed-${turnIndex}` }] : [],
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
export function validPolicyRigEvidence(input: {
  scenarioManifest?: { ref: string; sha256: string };
  withErrorEvents?: boolean;
} = {}): unknown {
  const withErrorEvents = input.withErrorEvents ?? true;
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
  const scenarioManifest = input.scenarioManifest ?? binding("rig/scenarios.json");
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
      turns: [turn(1, withErrorEvents), turn(2, withErrorEvents)],
      history_interaction: HISTORY_INTERACTION.includes(scenario.pass_id as never)
        ? {
            pass_ids: [...HISTORY_INTERACTION],
            opportunity_turns: 2,
            truth_effects: {
              baseline: truth(0, 2, 0),
              ablated: truth(0, 0, 2),
              error_reduction: -2,
            },
            turns: [turn(1, withErrorEvents), turn(2, withErrorEvents)],
          }
        : null,
      manifest: scenario.manifest,
      result: scenario.result,
      script: scenario.script,
      initial_state: scenario.initial_state,
    })),
  };
}

/** Derive exactly the Rig-unit evidence that the published-bundle verifier recomputes. */
export function rigFixtureIdentityInventories(input: unknown): {
  singleton: ReadonlyMap<string, readonly PolicySingletonIdentityEvent[]>;
  interactions: ReadonlyMap<
    string,
    { readonly events: readonly PolicyIdentityEvent[]; readonly outcomes: ReturnType<typeof identityOutcomesFromEvents> }
  >;
} {
  const rig = PolicyRigEvidenceSchema.parse(input);
  const singleton = new Map<string, PolicySingletonIdentityEvent[]>();
  const interactions = new Map<string, PolicyIdentityEvent[]>();
  const groupKey = (passIds: readonly string[]) => [...passIds].sort().join("\u0000");
  const differences = (turn: (typeof rig.sequences)[number]["turns"][number]) => {
    const baseline = new Set(turn.baseline.errors.map((row) => `${row.kind}:${row.identity}`));
    const counterfactual = new Set(
      turn.counterfactual.errors.map((row) => `${row.kind}:${row.identity}`),
    );
    return { baseline, counterfactual };
  };
  for (const sequence of rig.sequences) {
    const sequenceIdentity = sequence.scenario_id.startsWith(`${sequence.pass_id}-`)
      ? sequence.scenario_id.slice(sequence.pass_id.length + 1)
      : sequence.scenario_id;
    const singletonEvents = singleton.get(sequence.pass_id) ?? [];
    singleton.set(sequence.pass_id, singletonEvents);
    const append = (
      events: Array<PolicySingletonIdentityEvent | PolicyIdentityEvent>,
      turn: (typeof sequence.turns)[number],
      memberPassId?: string,
    ) => {
      const { baseline, counterfactual } = differences(turn);
      const unit = `rig:${sequenceIdentity}:turn-${turn.turn_index}`;
      for (const identity of counterfactual) {
        if (baseline.has(identity)) continue;
        const common = {
          lane: "stateful-rig" as const,
          unit,
          identity: `rig:${sequenceIdentity}:turn-${turn.turn_index}:${identity}`,
          direction: "worsened" as const,
          count: 1,
          source: rig.scenario_manifest,
        };
        events.push(
          memberPassId === undefined
            ? { ...common, pass_id: sequence.pass_id }
            : { ...common, member_pass_id: sequence.pass_id },
        );
      }
      for (const identity of baseline) {
        if (counterfactual.has(identity)) continue;
        const common = {
          lane: "stateful-rig" as const,
          unit,
          identity: `rig:${sequenceIdentity}:turn-${turn.turn_index}:${identity}`,
          direction: "improved" as const,
          count: 1,
          source: rig.scenario_manifest,
        };
        events.push(
          memberPassId === undefined
            ? { ...common, pass_id: sequence.pass_id }
            : { ...common, member_pass_id: sequence.pass_id },
        );
      }
    };
    for (const turn of sequence.turns) append(singletonEvents, turn);
    const group = sequence.history_interaction;
    if (group === null) continue;
    const groupEvents = interactions.get(groupKey(group.pass_ids)) ?? [];
    interactions.set(groupKey(group.pass_ids), groupEvents);
    for (const turn of group.turns) append(groupEvents, turn, sequence.pass_id);
  }
  return {
    singleton: new Map(
      [...singleton.entries()].map(([passId, events]) => [passId, sortSingletonIdentityEvents(events)]),
    ),
    interactions: new Map(
      [...interactions.entries()].map(([key, events]) => {
        const sorted = sortIdentityEvents(events);
        return [key, { events: sorted, outcomes: identityOutcomesFromEvents(sorted) }];
      }),
    ),
  };
}

export function validPolicyDogfoodSnapshot(): unknown {
  return {
    schema: "reviewgate.policy-dogfood-snapshot.v1",
    input_manifest: binding("dogfood/input.json"),
    attestation: binding("dogfood/attestation.json"),
    declined: 0,
    labels: [],
    exclusions: {},
  };
}
