import { describe, expect, test } from "bun:test";
import {
  PolicyBenchBundleSchema,
  PolicyDogfoodAttestationSchema,
  PolicyDogfoodInputManifestSchema,
  PolicyMeasurementSchema,
  PolicyRigEvidenceSchema,
  PolicyRigScenarioManifestSchema,
} from "../../src/schemas/policy-measurement.ts";
import { POLICY_PASS_IDS } from "../../src/core/policy/catalog.ts";
import { POLICY_MEASUREMENT_INTERACTIONS } from "../../src/core/policy/measurement-contract.ts";

const SHA = "b".repeat(64);

const STATEFUL = [
  "history.fp-signature",
  "history.cycle-rejected",
  "history.fp-cluster",
  "judgment.reputation",
  "history.region-rejected",
];

function binding(ref: string): Record<string, string> {
  return { ref, sha256: SHA };
}

function scenarios(): Record<string, unknown> {
  return {
    schema: "reviewgate.policy-rig-scenarios.v1",
    scenarios: STATEFUL.flatMap((passId) =>
      Array.from({ length: 3 }, (_, index) => ({
        id: `${passId}-${index + 1}`,
        pass_id: passId,
        manifest: binding(`rig/${passId}-${index + 1}.json`),
        initial_state: binding(`state/${passId}-${index + 1}.json`),
        expected_opportunity_turns: 2,
      })),
    ),
  };
}

function passEvidence(
  passId: string,
  lane: "stateless-bench" | "stateful-rig",
): Record<string, unknown> {
  return {
    pass_id: passId,
    lane,
    eligibility: { stateless: true, stateful: true, dogfood: true },
    authority: { stateless: true, stateful: true, dogfood: true },
    opportunities: { cases: 8, signatures: 15, turns: 2, runs: 3 },
    exclusions: [],
    truth_effects: {
      baseline: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 1 },
      ablated: { blocking_fp: 1, blocking_fn: 0, blocking_tp: 1 },
      error_reduction: 1,
    },
    trace_totals: { applied: 1, would_apply: 1, protected: 0, no_opportunity: 0 },
    statistics: { raw_effects: [1], interval: { lo: 1, hi: 1 }, p_value: 1, adjusted_p_value: 1 },
    unique_contributions: [],
    raw_evidence_refs: ["evidence/a.json"],
  };
}

function measurement(): Record<string, unknown> {
  return {
    schema: "reviewgate.policy-measurement.v1",
    preregistration: binding("bench/preregistrations/a.json"),
    catalog_version: "reviewgate.policy-catalog.v1",
    passes: POLICY_PASS_IDS.map((passId) => ({
      pass_id: passId,
      classification: "inconclusive",
      reasons: ["insufficient-opportunities"],
      vetoes: [],
      harm_observed: false,
      evidence_refs: ["evidence/a.json"],
      evidence: passEvidence(
        passId,
        STATEFUL.includes(passId) ? "stateful-rig" : "stateless-bench",
      ),
    })),
    interactions: POLICY_MEASUREMENT_INTERACTIONS.map((passIds, index) => ({
      pass_ids: [...passIds],
      artifact: binding(`interactions/${index}.json`),
      evidence: {
        authoritative: true,
        eligibility: { stateless: true, stateful: true, dogfood: true },
        opportunities: { cases: 8, signatures: 15, turns: 2, runs: 3 },
        exclusions: [],
        truth_effects: {
          baseline: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 1 },
          ablated: { blocking_fp: 1, blocking_fn: 0, blocking_tp: 1 },
          error_reduction: 1,
        },
        statistics: {
          raw_effects: [1],
          interval: { lo: 1, hi: 1 },
          p_value: 1,
          adjusted_p_value: 1,
        },
        raw_evidence_refs: [`interactions/${index}.json`],
      },
    })),
    artifacts: {
      authoritative: true,
      sources: [binding("sources/preregistration.json")],
      exclusions: [],
      evidence: [binding("sources/preregistration.json")],
    },
  };
}

describe("policy measurement result contracts", () => {
  test("rejects a non-code-unit-sorted or partial dogfood input inventory", () => {
    const manifest = {
      schema: "reviewgate.policy-dogfood-input-manifest.v1",
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-12T09:00:00.000Z",
      entries: [
        { kind: "audit", ref: "audit/a.jsonl", sha256: SHA, bytes: 1, run_id: "run-a", iter: 1 },
        { kind: "trace", ref: "trace/a.json", sha256: SHA, bytes: 1, run_id: "run-a", iter: 1 },
      ],
    };
    expect(() => PolicyDogfoodInputManifestSchema.parse(manifest)).not.toThrow();
    expect(() =>
      PolicyDogfoodInputManifestSchema.parse({
        ...manifest,
        entries: [...manifest.entries].reverse(),
      }),
    ).toThrow();
    expect(() =>
      PolicyDogfoodInputManifestSchema.parse({ ...manifest, entries: [manifest.entries[0]] }),
    ).toThrow();
  });

  test("requires a content-bound human TP/FP attestation", () => {
    const attestation = {
      schema: "reviewgate.policy-dogfood-attestation.v1",
      actor: "Markus",
      attested_at: "2026-08-12T09:00:00.000Z",
      challenge_sha256: SHA,
      input_manifest_sha256: SHA,
      rows: [{ run_id: "run-a", iter: 1, finding_signature: SHA, disposition: "tp" }],
    };
    expect(() => PolicyDogfoodAttestationSchema.parse(attestation)).not.toThrow();
    expect(() =>
      PolicyDogfoodAttestationSchema.parse({
        ...attestation,
        rows: [{ ...attestation.rows[0], disposition: "declined" }],
      }),
    ).toThrow();
  });

  test("never accepts an authoritative partial measurement result", () => {
    expect(() =>
      PolicyMeasurementSchema.parse({
        schema: "reviewgate.policy-measurement.v1",
        preregistration: { ref: "bench/preregistrations/a.json", sha256: SHA },
        catalog_version: "reviewgate.policy-catalog.v1",
        passes: [],
        interactions: [],
        artifacts: { authoritative: true, sources: [] },
      }),
    ).toThrow();
  });

  test("requires complete evidence for every closed pass and interaction", () => {
    const valid = measurement();
    expect(() => PolicyMeasurementSchema.parse(valid)).not.toThrow();
    const missing = measurement();
    delete ((missing.passes as Record<string, unknown>[])[0]!.evidence as Record<string, unknown>)
      .truth_effects;
    expect(() => PolicyMeasurementSchema.parse(missing)).toThrow();
  });

  test("requires the closed five-pass, three-sequence, two-opportunity Rig manifest and evidence", () => {
    expect(() => PolicyRigScenarioManifestSchema.parse(scenarios())).not.toThrow();
    const incomplete = scenarios();
    (incomplete.scenarios as unknown[]).pop();
    expect(() => PolicyRigScenarioManifestSchema.parse(incomplete)).toThrow();
    const evidence = {
      schema: "reviewgate.policy-rig-evidence.v1",
      scenario_manifest: binding("rig/scenarios.json"),
      manifest: scenarios(),
      authoritative: true,
      sequences: (scenarios().scenarios as Record<string, unknown>[]).map((scenario) => ({
        scenario_id: scenario.id,
        pass_id: scenario.pass_id,
        opportunity_turns: 2,
        manifest: scenario.manifest,
        initial_state: scenario.initial_state,
        artifact: binding(`evidence/${scenario.id}.json`),
      })),
    };
    expect(() => PolicyRigEvidenceSchema.parse(evidence)).not.toThrow();
    evidence.sequences.pop();
    expect(() => PolicyRigEvidenceSchema.parse(evidence)).toThrow();
  });

  test("requires each Bench profile to bind repeats one, two, and three exactly once", () => {
    const profiles = [
      {
        id: "baseline",
        ablated_pass_ids: [],
        repeats: [1, 2, 3],
        artifact: binding("bench/base.json"),
      },
      ...POLICY_PASS_IDS.map((passId) => ({
        id: `single:${passId}`,
        ablated_pass_ids: [passId],
        repeats: [1, 2, 3],
        artifact: binding(`bench/${passId}.json`),
      })),
      ...POLICY_MEASUREMENT_INTERACTIONS.map((group, index) => ({
        id: `interaction:${index}`,
        ablated_pass_ids: [...group],
        repeats: [1, 2, 3],
        artifact: binding(`bench/interaction-${index}.json`),
      })),
    ];
    const bundle = {
      schema: "reviewgate.policy-bench-bundle.v1",
      preregistration: binding("pre.json"),
      profiles,
    };
    expect(() => PolicyBenchBundleSchema.parse(bundle)).not.toThrow();
    profiles[0]!.repeats = [1, 1, 1];
    expect(() => PolicyBenchBundleSchema.parse(bundle)).toThrow();
  });
});
