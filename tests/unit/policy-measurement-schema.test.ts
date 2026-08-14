import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { canonicalJson } from "../../src/audit/canonical.ts";
import { POLICY_PASSES, POLICY_PASS_IDS } from "../../src/core/policy/catalog.ts";
import { POLICY_MEASUREMENT_INTERACTIONS } from "../../src/core/policy/measurement-contract.ts";
import { PolicyBenchProfileArtifactSchema } from "../../src/schemas/bench-result.ts";
import {
  PolicyBenchBundleSchema,
  PolicyDogfoodAttestationSchema,
  PolicyDogfoodInputManifestSchema,
  PolicyDogfoodSnapshotSchema,
  PolicyMeasurementSchema,
  PolicyRigEvidenceSchema,
  PolicyRigScenarioManifestSchema,
} from "../../src/schemas/policy-measurement.ts";
import { renderPolicyMeasurement } from "../../src/stats/policy/render.ts";

const SHA = "b".repeat(64);

const STATEFUL = [
  "history.fp-signature",
  "history.cycle-rejected",
  "history.fp-cluster",
  "judgment.reputation",
  "history.region-rejected",
];

const HISTORY_INTERACTION = [
  "history.fp-signature",
  "history.cycle-rejected",
  "history.fp-cluster",
  "history.region-rejected",
];

function binding(ref: string): { ref: string; sha256: string } {
  return { ref, sha256: createHash("sha256").update(ref).digest("hex") };
}

function contentBinding(directory: string, seed: string): { ref: string; sha256: string } {
  const sha256 = createHash("sha256").update(seed).digest("hex");
  return { ref: `artifacts/${directory}/${sha256}.json`, sha256 };
}

function dogfoodSnapshotLabel(overrides: Record<string, unknown> = {}) {
  return {
    schema: "reviewgate.policy-dogfood-snapshot.v1",
    input_manifest: binding("dogfood/input.json"),
    attestation: binding("dogfood/attestation.json"),
    labels: [
      {
        pass_id: "judgment.confidence",
        run_id: "run-1",
        iter: 1,
        finding_signature: "sig-1",
        disposition: "tp",
        source_signatures: ["sig-1"],
        evaluation_result: "protected",
        before: "WARN",
        after: "WARN",
        protected_by: "claimed-fixed-pin",
        effect: "preserved",
        ...overrides,
      },
    ],
    exclusions: {},
  };
}

test("dogfood labels bind the exact verified evaluation to a strict derived effect", () => {
  expect(PolicyDogfoodSnapshotSchema.safeParse(dogfoodSnapshotLabel()).success).toBe(true);
  expect(
    PolicyDogfoodSnapshotSchema.safeParse(
      dogfoodSnapshotLabel({
        evaluation_result: "applied",
        before: "WARN",
        after: "INFO",
        protected_by: undefined,
        effect: "suppressed",
      }),
    ).success,
  ).toBe(true);
  expect(
    PolicyDogfoodSnapshotSchema.safeParse(
      dogfoodSnapshotLabel({
        evaluation_result: "applied",
        before: "INFO",
        after: null,
        protected_by: undefined,
        effect: "suppressed",
      }),
    ).success,
  ).toBe(true);
  expect(
    PolicyDogfoodSnapshotSchema.safeParse(
      dogfoodSnapshotLabel({
        evaluation_result: "no-match",
        before: "WARN",
        after: "WARN",
        protected_by: undefined,
        effect: "none",
      }),
    ).success,
  ).toBe(true);
  for (const invalid of [
    dogfoodSnapshotLabel({ effect: undefined }),
    dogfoodSnapshotLabel({ effect: "suppressed" }),
    dogfoodSnapshotLabel({ evaluation_result: "applied", after: "WARN", effect: "suppressed" }),
    dogfoodSnapshotLabel({ evaluation_result: "protected", protected_by: undefined }),
    dogfoodSnapshotLabel({ evaluation_result: "protected", protected_by: "invented-protection" }),
    dogfoodSnapshotLabel({ evaluation_result: "no-match", protected_by: "claimed-fixed-pin" }),
  ]) {
    expect(PolicyDogfoodSnapshotSchema.safeParse(invalid).success).toBe(false);
  }
});

function policyProfileArtifact(id: string, ablatedPassIds: readonly string[]) {
  return {
    schema: "reviewgate.policy-bench-profile.v1",
    profile_id: id,
    ablated_pass_ids: [...ablatedPassIds],
    repeats: [1, 2, 3].map((repeat) => ({
      repeat,
      authoritative: true,
      fully_consumed: true,
      response_manifest: contentBinding("responses", `responses:${repeat}`),
      result: contentBinding("policy-repeat-results", `${id}:result:${repeat}`),
      policy_trace_set: contentBinding("policy-trace-sets", `trace-set:${repeat}`),
      ordered_response_sha256: [
        createHash("sha256").update(`review:${repeat}`).digest("hex"),
        createHash("sha256").update(`complete:${repeat}`).digest("hex"),
      ],
      requested_passes: ablatedPassIds.map((passId) => ({
        pass_id: passId,
        ran_cases: 30,
        opportunities: 0,
      })),
      cases: Array.from({ length: 30 }, (_, index) => ({
        case_id: `case-${String(index + 1).padStart(2, "0")}`,
        repeat,
        content_sha256: createHash("sha256").update(`case:${index}`).digest("hex"),
        policy_truth_sha256: createHash("sha256")
          .update(`${id}:truth:${repeat}:${index}`)
          .digest("hex"),
      })),
    })),
  };
}

function policyBenchBundle() {
  const profiles = [
    { id: "baseline", ablated: [] as string[] },
    ...POLICY_PASS_IDS.map((passId) => ({ id: `single:${passId}`, ablated: [passId] })),
    ...POLICY_MEASUREMENT_INTERACTIONS.map((group, index) => ({
      id: `interaction:${index + 1}`,
      ablated: [...group],
    })),
  ].map(({ id, ablated }) => {
    const data = policyProfileArtifact(id, ablated);
    const sha256 = createHash("sha256").update(canonicalJson(data)).digest("hex");
    return {
      id,
      ablated_pass_ids: ablated,
      artifact: { ref: `artifacts/policy-profiles/${sha256}.json`, sha256 },
      data,
    };
  });
  return {
    schema: "reviewgate.policy-bench-bundle.v1",
    preregistration: binding("pre.json"),
    profiles,
  };
}

function rebindPolicyProfile(profile: {
  artifact: { ref: string; sha256: string };
  data: unknown;
}): void {
  const sha256 = createHash("sha256").update(canonicalJson(profile.data)).digest("hex");
  profile.artifact = { ref: `artifacts/policy-profiles/${sha256}.json`, sha256 };
}

function catalogSnapshot(passId: string): Record<string, unknown> {
  const pass = POLICY_PASSES.find((entry) => entry.id === passId);
  if (pass === undefined) {
    throw new Error(`missing catalog pass ${passId}`);
  }
  return {
    order: pass.order,
    class: pass.class,
    overlaps_with: [...pass.overlaps_with],
    opportunity_sha256: createHash("sha256").update(pass.opportunity).digest("hex"),
  };
}

function scenarios(): Record<string, unknown> {
  return {
    schema: "reviewgate.policy-rig-scenarios.v1",
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
}

function truth(blockingFp: number, blockingFn: number, blockingTp: number) {
  return { blocking_fp: blockingFp, blocking_fn: blockingFn, blocking_tp: blockingTp };
}

function rigTurn(turnIndex: number) {
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

function rigEvidence() {
  const manifest = scenarios();
  const scenarioManifest = binding("rig/scenarios.json");
  const artifacts: Array<{
    ref: string;
    sha256: string;
    kind: "rig" | "state";
  }> = [
    { ...scenarioManifest, kind: "rig" as const },
    ...(
      manifest.scenarios as Array<{
        manifest: { ref: string; sha256: string };
        result: { ref: string; sha256: string };
        script: { ref: string; sha256: string };
        initial_state: { ref: string; sha256: string };
      }>
    ).flatMap((scenario) => [
      { ...scenario.manifest, kind: "rig" as const },
      { ...scenario.result, kind: "rig" as const },
      { ...scenario.script, kind: "rig" as const },
      { ...scenario.initial_state, kind: "state" as const },
    ]),
  ].sort((left, right) => (left.ref < right.ref ? -1 : 1));
  return {
    schema: "reviewgate.policy-rig-evidence.v1",
    scenario_manifest: scenarioManifest,
    manifest,
    authoritative: true,
    source_commit: "a".repeat(40),
    artifacts,
    artifact_inventory_sha256: createHash("sha256").update(canonicalJson(artifacts)).digest("hex"),
    sequences: (manifest.scenarios as Record<string, unknown>[]).map((scenario) => ({
      scenario_id: scenario.id,
      pass_id: scenario.pass_id,
      authoritative: true,
      opportunity_turns: 2,
      truth_effects: {
        baseline: truth(0, 2, 0),
        ablated: truth(0, 0, 2),
        error_reduction: -2,
      },
      turns: [rigTurn(1), rigTurn(2)],
      history_interaction: HISTORY_INTERACTION.includes(String(scenario.pass_id))
        ? {
            pass_ids: HISTORY_INTERACTION,
            opportunity_turns: 2,
            truth_effects: {
              baseline: truth(0, 2, 0),
              ablated: truth(0, 0, 2),
              error_reduction: -2,
            },
            turns: [rigTurn(1), rigTurn(2)],
          }
        : null,
      manifest: scenario.manifest,
      result: scenario.result,
      script: scenario.script,
      initial_state: scenario.initial_state,
    })),
  };
}

function passEvidence(
  passId: string,
  lane: "stateless-bench" | "stateful-rig",
): Record<string, unknown> {
  const opportunities = { cases: 8, signatures: 15, turns: 2, runs: 3 };
  const truthEffects = {
    baseline: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 1 },
    ablated: { blocking_fp: 1, blocking_fn: 0, blocking_tp: 1 },
    error_reduction: 1,
  };
  const traceTotals = { applied: 1, would_apply: 1, protected: 0, no_opportunity: 0 };
  const statistics = {
    raw_effects: [1],
    interval: { lo: 1, hi: 1 },
    p_value: 1,
    adjusted_p_value: 1,
  };
  const summary = (
    summaryLane: "stateless-bench" | "stateful-rig" | "dogfood",
    primary: boolean,
  ) => ({
    lane: summaryLane,
    primary,
    descriptive: !primary,
    eligible: true,
    authoritative: true,
    opportunities: { ...opportunities, runs: summaryLane === "dogfood" ? opportunities.runs : 0 },
    exclusions: [],
    truth_effects: truthEffects,
    trace_totals: traceTotals,
    statistics,
    raw_evidence_refs: [`${summaryLane}/${passId}.json`],
  });
  return {
    pass_id: passId,
    lane,
    catalog_snapshot: catalogSnapshot(passId),
    eligibility: { stateless: true, stateful: true, dogfood: true },
    authority: { stateless: true, stateful: true, dogfood: true },
    opportunities,
    exclusions: [],
    truth_effects: truthEffects,
    trace_totals: traceTotals,
    statistics,
    unique_contributions: [],
    raw_evidence_refs: ["evidence/a.json"],
    lane_summaries:
      lane === "stateful-rig"
        ? [
            summary("stateless-bench", false),
            summary("stateful-rig", true),
            summary("dogfood", false),
          ]
        : [summary("stateless-bench", true), summary("dogfood", false)],
  };
}

function measurement(): Record<string, unknown> {
  const preregistration = binding("bench/preregistrations/a.json");
  const inventory = [
    preregistration,
    binding("evidence/a.json"),
    ...POLICY_PASS_IDS.flatMap((passId) => [
      binding(`stateless-bench/${passId}.json`),
      ...(STATEFUL.includes(passId) ? [binding(`stateful-rig/${passId}.json`)] : []),
      binding(`dogfood/${passId}.json`),
    ]),
    ...POLICY_MEASUREMENT_INTERACTIONS.map((_, index) => binding(`interactions/${index}.json`)),
  ].sort((left, right) => (left.ref < right.ref ? -1 : 1));
  const passes = POLICY_PASS_IDS.map((passId) => ({
    pass_id: passId,
    classification: "inconclusive",
    reasons: ["insufficient-opportunities"],
    vetoes: [],
    harm_observed: false,
    evidence_refs: ["evidence/a.json"],
    evidence: passEvidence(passId, STATEFUL.includes(passId) ? "stateful-rig" : "stateless-bench"),
  }));
  const interactions = POLICY_MEASUREMENT_INTERACTIONS.map((passIds, index) => {
    const rawEvidenceRefs = [`interactions/${index}.json`];
    const stateful = passIds.every((passId) => STATEFUL.includes(passId));
    const primaryLane = stateful ? "stateful-rig" : "stateless-bench";
    const opportunities = { cases: 8, signatures: 15, turns: 2, runs: 3 };
    const truthEffects = {
      baseline: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 1 },
      ablated: { blocking_fp: 1, blocking_fn: 0, blocking_tp: 1 },
      error_reduction: 1,
    };
    const statistics = {
      raw_effects: [1],
      interval: { lo: 1, hi: 1 },
      p_value: 1,
      adjusted_p_value: 1,
    };
    const summary = (lane: "stateless-bench" | "stateful-rig", primary: boolean) => ({
      lane,
      primary,
      descriptive: !primary,
      eligible: true,
      authoritative: true,
      opportunities,
      exclusions: [],
      truth_effects: truthEffects,
      trace_totals: { applied: 1, would_apply: 1, protected: 0, no_opportunity: 0 },
      statistics,
      raw_evidence_refs: rawEvidenceRefs,
    });
    return {
      pass_ids: [...passIds],
      artifact: binding(`interactions/${index}.json`),
      primary_lane: primaryLane,
      evidence: {
        authoritative: true,
        authority: { stateless: true, stateful: true, dogfood: true },
        eligibility: { stateless: true, stateful: true, dogfood: true },
        opportunities,
        exclusions: [],
        truth_effects: truthEffects,
        statistics,
        raw_evidence_refs: rawEvidenceRefs,
      },
      lane_summaries: stateful
        ? [summary("stateless-bench", false), summary("stateful-rig", true)]
        : [summary("stateless-bench", true)],
    };
  });
  for (const pass of passes) {
    const evidence = pass.evidence as Record<string, unknown>;
    const refs = new Set(
      (evidence.lane_summaries as Array<{ raw_evidence_refs: string[] }>).flatMap(
        (summary) => summary.raw_evidence_refs,
      ),
    );
    for (const interaction of interactions) {
      if (!interaction.pass_ids.includes(pass.pass_id as never)) continue;
      refs.add(interaction.artifact.ref);
      for (const ref of interaction.evidence.raw_evidence_refs) refs.add(ref);
      for (const summary of interaction.lane_summaries) {
        for (const ref of summary.raw_evidence_refs) refs.add(ref);
      }
    }
    const closedRefs = [...refs].sort();
    evidence.raw_evidence_refs = closedRefs;
    pass.evidence_refs = closedRefs;
  }
  return {
    schema: "reviewgate.policy-measurement.v1",
    preregistration,
    catalog_version: "reviewgate.policy-catalog.v1",
    passes,
    interactions,
    identity_evidence: POLICY_PASS_IDS.map((passId) => ({
      pass_id: passId,
      ground_truth_harms: [],
      dogfood_dispositions: [],
      beneficial_effects: [],
    })),
    artifacts: {
      authoritative: true,
      sources: structuredClone(inventory),
      exclusions: [],
      evidence: [binding("evidence/a.json")],
      inventory,
    },
  };
}

function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) {
    throw new Error("expected a non-empty fixture collection");
  }
  return value;
}

function firstPass(value: Record<string, unknown>): Record<string, unknown> {
  return first(value.passes as Record<string, unknown>[]);
}

function firstPassEvidence(value: Record<string, unknown>): Record<string, unknown> {
  return firstPass(value).evidence as Record<string, unknown>;
}

function firstInteractionEvidence(value: Record<string, unknown>): Record<string, unknown> {
  return first(value.interactions as Record<string, unknown>[]).evidence as Record<string, unknown>;
}

function passById(value: Record<string, unknown>, passId: string): Record<string, unknown> {
  const pass = (value.passes as Record<string, unknown>[]).find((row) => row.pass_id === passId);
  if (pass === undefined) throw new Error(`missing fixture pass ${passId}`);
  return pass;
}

function laneSummary(
  evidence: Record<string, unknown>,
  lane: "stateless-bench" | "stateful-rig" | "dogfood",
): Record<string, unknown> {
  const summary = (evidence.lane_summaries as Record<string, unknown>[]).find(
    (row) => row.lane === lane,
  );
  if (summary === undefined) throw new Error(`missing fixture lane ${lane}`);
  return summary;
}

function duplicateDogfoodRefIntoSelectedLane(
  passId: string,
  selectedLane: "stateless-bench" | "stateful-rig",
): { accepted: boolean; selectedRendersDogfood: boolean } {
  const value = measurement();
  const pass = passById(value, passId);
  const evidence = pass.evidence as Record<string, unknown>;
  const dogfoodOnly = "dogfood/only.json";
  const artifacts = value.artifacts as {
    inventory: Array<{ ref: string; sha256: string }>;
    sources: Array<{ ref: string; sha256: string }>;
  };
  for (const bindings of [artifacts.inventory, artifacts.sources]) {
    bindings.push(binding(dogfoodOnly));
    bindings.sort((left, right) => left.ref.localeCompare(right.ref));
  }
  for (const lane of ["dogfood", selectedLane] as const) {
    const summary = laneSummary(evidence, lane);
    const refs = new Set(summary.raw_evidence_refs as string[]);
    refs.add(dogfoodOnly);
    summary.raw_evidence_refs = [...refs].sort();
  }
  const topRefs = new Set(evidence.raw_evidence_refs as string[]);
  topRefs.add(dogfoodOnly);
  const closedRefs = [...topRefs].sort();
  evidence.raw_evidence_refs = closedRefs;
  pass.evidence_refs = closedRefs;

  const parsed = PolicyMeasurementSchema.safeParse(value);
  if (!parsed.success) return { accepted: false, selectedRendersDogfood: false };
  const markdown = renderPolicyMeasurement(parsed.data);
  const heading = `### \`${passId}\``;
  const start = markdown.indexOf(heading);
  const end = markdown.indexOf("\n### ", start + heading.length);
  const laneDossier = markdown
    .slice(start, end === -1 ? undefined : end)
    .split("- Lane summaries: ")[1];
  const selectedLine = laneDossier
    ?.split(" | ")
    .find((line) => line.includes(`Lane ${selectedLane}: primary=true;`));
  return {
    accepted: true,
    selectedRendersDogfood: selectedLine?.includes(`\`${dogfoodOnly}\``) ?? false,
  };
}

describe("policy measurement result contracts", () => {
  test("requires a complete inventory-bound identity dossier and preserves cutoff exclusions", () => {
    const value = measurement();
    const firstIdentity = first(value.identity_evidence as Array<Record<string, unknown>>);
    firstIdentity.ground_truth_harms = [{ identity: "case-a", evidence_ref: "evidence/a.json" }];
    const firstEvidence = firstPassEvidence(value);
    firstEvidence.exclusions = [{ lane: "dogfood", code: "post-registered-at", count: 2 }];
    laneSummary(firstEvidence, "dogfood").exclusions = firstEvidence.exclusions;
    expect(() => PolicyMeasurementSchema.parse(value)).not.toThrow();

    const missingPass = structuredClone(value);
    (missingPass.identity_evidence as unknown[]).pop();
    expect(() => PolicyMeasurementSchema.parse(missingPass)).toThrow();

    const unbound = structuredClone(value);
    first(unbound.identity_evidence as Array<Record<string, unknown>>).ground_truth_harms = [
      { identity: "case-a", evidence_ref: "outside-inventory.json" },
    ];
    expect(() => PolicyMeasurementSchema.parse(unbound)).toThrow();
  });

  test("rejects a non-code-unit-sorted or partial dogfood input inventory", () => {
    const manifest = {
      schema: "reviewgate.policy-dogfood-input-manifest.v1",
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-12T09:00:00.000Z",
      entries: [
        {
          kind: "audit",
          ref: "audit/a.jsonl",
          sha256: SHA,
          bytes: 1,
          runs: [
            {
              run_id: "run-a",
              iter: 1,
              trace_ref: "trace/a.json",
              trace_sha256: SHA,
            },
            {
              run_id: "run-b",
              iter: 1,
              trace_ref: "trace/b.json",
              trace_sha256: SHA,
            },
          ],
        },
        {
          kind: "trace",
          ref: "source/trace-a.json",
          audit_ref: "audit/a.jsonl",
          trace_ref: "trace/a.json",
          sha256: SHA,
          bytes: 1,
          run_id: "run-a",
          iter: 1,
        },
        {
          kind: "trace",
          ref: "source/trace-b.json",
          audit_ref: "audit/a.jsonl",
          trace_ref: "trace/b.json",
          sha256: SHA,
          bytes: 1,
          run_id: "run-b",
          iter: 1,
        },
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

  test("rejects a trace entry whose audit binding belongs to another run identity", () => {
    const manifest = {
      schema: "reviewgate.policy-dogfood-input-manifest.v1",
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-12T09:00:00.000Z",
      entries: [
        {
          kind: "audit",
          ref: "audit/a.jsonl",
          sha256: SHA,
          bytes: 1,
          runs: [
            { run_id: "run-a", iter: 1, trace_ref: "trace/a.json", trace_sha256: SHA },
            { run_id: "run-b", iter: 1, trace_ref: "trace/b.json", trace_sha256: SHA },
          ],
        },
        {
          kind: "trace",
          ref: "source/trace-a.json",
          audit_ref: "audit/a.jsonl",
          trace_ref: "trace/a.json",
          sha256: SHA,
          bytes: 1,
          run_id: "run-b",
          iter: 1,
        },
        {
          kind: "trace",
          ref: "source/trace-b.json",
          audit_ref: "audit/a.jsonl",
          trace_ref: "trace/b.json",
          sha256: SHA,
          bytes: 1,
          run_id: "run-a",
          iter: 1,
        },
      ],
    };
    expect(() => PolicyDogfoodInputManifestSchema.parse(manifest)).toThrow(/same run_id and iter/i);
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
    firstPassEvidence(missing).truth_effects = undefined;
    expect(() => PolicyMeasurementSchema.parse(missing)).toThrow();
  });

  test("requires every pass to carry its exact catalog authority snapshot", () => {
    const missing = measurement();
    firstPassEvidence(missing).catalog_snapshot = undefined;
    expect(() => PolicyMeasurementSchema.parse(missing)).toThrow();

    const wrong = measurement();
    (firstPassEvidence(wrong).catalog_snapshot as Record<string, unknown>).order = 999;
    expect(() => PolicyMeasurementSchema.parse(wrong)).toThrow();

    for (const [field, value] of [
      ["class", "scope"],
      ["overlaps_with", []],
      ["opportunity_sha256", SHA],
    ] as [string, unknown][]) {
      const drifted = measurement();
      (firstPassEvidence(drifted).catalog_snapshot as Record<string, unknown>)[field] = value;
      expect(() => PolicyMeasurementSchema.parse(drifted)).toThrow();
    }
  });

  test("rejects a catalog-stateful pass promoted to stateless with a self-consistent summary inventory", () => {
    const value = measurement();
    const evidence = passById(value, "history.fp-signature").evidence as Record<string, unknown>;
    evidence.lane = "stateless-bench";
    const summaries = evidence.lane_summaries as Record<string, unknown>[];
    summaries.splice(
      summaries.findIndex((summary) => summary.lane === "stateful-rig"),
      1,
    );
    laneSummary(evidence, "stateless-bench").primary = true;
    laneSummary(evidence, "stateless-bench").descriptive = false;
    expect(PolicyMeasurementSchema.safeParse(value).success).toBe(false);
  });

  test("rejects promotion of the registered history interaction from Rig to Bench", () => {
    const value = measurement();
    const interaction = (value.interactions as Record<string, unknown>[])[2];
    if (interaction === undefined) throw new Error("missing fixture history interaction");
    interaction.primary_lane = "stateless-bench";
    const summaries = interaction.lane_summaries as Record<string, unknown>[];
    const bench = first(summaries);
    const rig = summaries.find((summary) => summary.lane === "stateful-rig");
    if (rig === undefined) throw new Error("missing fixture history Rig summary");
    bench.primary = true;
    bench.descriptive = false;
    rig.primary = false;
    rig.descriptive = true;
    expect(PolicyMeasurementSchema.safeParse(value).success).toBe(false);
  });

  test("rejects a primary pass summary whose statistics drift from selected classification evidence", () => {
    const value = measurement();
    const evidence = firstPassEvidence(value);
    const summary = laneSummary(evidence, "stateless-bench");
    summary.statistics = {
      ...(summary.statistics as Record<string, unknown>),
      raw_effects: [-1],
    };
    expect(PolicyMeasurementSchema.safeParse(value).success).toBe(false);
  });

  test("rejects a primary interaction summary whose statistics drift from selected authority", () => {
    const value = measurement();
    const interaction = first(value.interactions as Record<string, unknown>[]);
    const summary = first(interaction.lane_summaries as Record<string, unknown>[]);
    summary.statistics = {
      ...(summary.statistics as Record<string, unknown>),
      raw_effects: [-1],
    };
    expect(PolicyMeasurementSchema.safeParse(value).success).toBe(false);
  });

  test("rejects dogfood supplementary runs and exclusions in a selected Bench summary", () => {
    const dogfoodExclusion = { lane: "dogfood", code: "missing-decision", count: 1 };

    const selectedBench = measurement();
    const benchEvidence = firstPassEvidence(selectedBench);
    benchEvidence.exclusions = [dogfoodExclusion];
    const benchSummary = laneSummary(benchEvidence, "stateless-bench");
    (benchSummary.opportunities as Record<string, unknown>).runs = 3;
    benchSummary.exclusions = [dogfoodExclusion];
    laneSummary(benchEvidence, "dogfood").exclusions = [dogfoodExclusion];
    expect(PolicyMeasurementSchema.safeParse(selectedBench).success).toBe(false);
  });

  test("rejects dogfood supplementary runs and exclusions in a selected Rig summary", () => {
    const dogfoodExclusion = { lane: "dogfood", code: "missing-decision", count: 1 };
    const selectedRig = measurement();
    const rigEvidence = passById(selectedRig, "history.fp-signature").evidence as Record<
      string,
      unknown
    >;
    rigEvidence.exclusions = [dogfoodExclusion];
    const rigSummary = laneSummary(rigEvidence, "stateful-rig");
    (rigSummary.opportunities as Record<string, unknown>).runs = 3;
    rigSummary.exclusions = [dogfoodExclusion];
    laneSummary(rigEvidence, "dogfood").exclusions = [dogfoodExclusion];
    expect(PolicyMeasurementSchema.safeParse(selectedRig).success).toBe(false);
  });

  test("requires the Dogfood summary to own exact supplementary runs and exclusions", () => {
    const dogfoodExclusion = { lane: "dogfood", code: "missing-decision", count: 1 };
    const dogfoodDrift = measurement();
    const dogfoodEvidence = firstPassEvidence(dogfoodDrift);
    dogfoodEvidence.exclusions = [dogfoodExclusion];
    const dogfoodSummary = laneSummary(dogfoodEvidence, "dogfood");
    (dogfoodSummary.opportunities as Record<string, unknown>).runs = 0;
    dogfoodSummary.exclusions = [];
    expect(PolicyMeasurementSchema.safeParse(dogfoodDrift).success).toBe(false);
  });

  test("requires top-level pass references to close the exact lane and interaction union", () => {
    const value = measurement();
    firstPassEvidence(value).raw_evidence_refs = ["evidence/a.json"];
    firstPass(value).evidence_refs = ["evidence/a.json"];
    expect(PolicyMeasurementSchema.safeParse(value).success).toBe(false);
  });

  test("rejects a Dogfood raw reference additionally assigned to the selected Bench lane", () => {
    expect(
      duplicateDogfoodRefIntoSelectedLane("evidence.fact-location", "stateless-bench"),
    ).toEqual({ accepted: false, selectedRendersDogfood: false });
  });

  test("rejects a Dogfood raw reference additionally assigned to the selected Rig lane", () => {
    expect(duplicateDogfoodRefIntoSelectedLane("history.fp-signature", "stateful-rig")).toEqual({
      accepted: false,
      selectedRendersDogfood: false,
    });
  });

  test("rejects a raw reference shared between the descriptive Bench and selected Rig lanes", () => {
    const value = measurement();
    const pass = passById(value, "history.fp-signature");
    const evidence = pass.evidence as Record<string, unknown>;
    const rigOnly = "rig/only.json";
    const artifacts = value.artifacts as {
      inventory: Array<{ ref: string; sha256: string }>;
      sources: Array<{ ref: string; sha256: string }>;
    };
    for (const bindings of [artifacts.inventory, artifacts.sources]) {
      bindings.push(binding(rigOnly));
      bindings.sort((left, right) => left.ref.localeCompare(right.ref));
    }
    for (const lane of ["stateless-bench", "stateful-rig"] as const) {
      const summary = laneSummary(evidence, lane);
      const refs = new Set(summary.raw_evidence_refs as string[]);
      refs.add(rigOnly);
      summary.raw_evidence_refs = [...refs].sort();
    }
    const topRefs = new Set(evidence.raw_evidence_refs as string[]);
    topRefs.add(rigOnly);
    const closedRefs = [...topRefs].sort();
    evidence.raw_evidence_refs = closedRefs;
    pass.evidence_refs = closedRefs;
    expect(PolicyMeasurementSchema.safeParse(value).success).toBe(false);
  });

  test("rejects unknown or missing raw evidence inventory bindings", () => {
    const unknown = measurement();
    firstPassEvidence(unknown).raw_evidence_refs = ["evidence/unknown.json"];
    firstPass(unknown).evidence_refs = ["evidence/unknown.json"];
    expect(() => PolicyMeasurementSchema.parse(unknown)).toThrow();

    const missing = measurement();
    (missing.artifacts as Record<string, unknown>).inventory = [binding("interactions/0.json")];
    expect(() => PolicyMeasurementSchema.parse(missing)).toThrow();

    const sourceHashDrift = measurement();
    const sourceArtifacts = (sourceHashDrift.artifacts as { sources: Array<{ sha256: string }> })
      .sources;
    first(sourceArtifacts).sha256 = "f".repeat(64);
    expect(() => PolicyMeasurementSchema.parse(sourceHashDrift)).toThrow();

    const interactionHashDrift = measurement();
    first(
      interactionHashDrift.interactions as Array<{ artifact: { sha256: string } }>,
    ).artifact.sha256 = "f".repeat(64);
    expect(() => PolicyMeasurementSchema.parse(interactionHashDrift)).toThrow();
  });

  test("requires authority for every eligible interaction lane", () => {
    const missing = measurement();
    firstInteractionEvidence(missing).authority = undefined;
    expect(() => PolicyMeasurementSchema.parse(missing)).toThrow();

    const nonAuthoritative = measurement();
    firstInteractionEvidence(nonAuthoritative).authority = {
      stateless: false,
      stateful: true,
      dogfood: true,
    };
    expect(() => PolicyMeasurementSchema.parse(nonAuthoritative)).toThrow();
  });

  test("requires the closed five-pass, three-sequence, two-opportunity Rig manifest and evidence", () => {
    expect(() => PolicyRigScenarioManifestSchema.parse(scenarios())).not.toThrow();
    const incomplete = scenarios();
    (incomplete.scenarios as unknown[]).pop();
    expect(() => PolicyRigScenarioManifestSchema.parse(incomplete)).toThrow();
    const missingResult = scenarios();
    first(missingResult.scenarios as Record<string, unknown>[]).result = undefined;
    expect(() => PolicyRigScenarioManifestSchema.parse(missingResult)).toThrow();
    const duplicateArtifacts = scenarios();
    const declared = duplicateArtifacts.scenarios as Record<string, unknown>[];
    declared[1] = { ...declared[1], manifest: declared[0]?.manifest };
    expect(() => PolicyRigScenarioManifestSchema.parse(duplicateArtifacts)).toThrow();
    const duplicateContent = scenarios();
    const contentDeclared = duplicateContent.scenarios as Record<string, unknown>[];
    contentDeclared[1] = {
      ...contentDeclared[1],
      manifest: {
        ...(contentDeclared[1]?.manifest as Record<string, unknown>),
        sha256: (contentDeclared[0]?.manifest as Record<string, unknown>).sha256,
      },
    };
    expect(() => PolicyRigScenarioManifestSchema.parse(duplicateContent)).toThrow();
    const evidence = rigEvidence();
    expect(() => PolicyRigEvidenceSchema.parse(evidence)).not.toThrow();
    const swapped = structuredClone(evidence);
    const firstSequence = first(swapped.sequences);
    firstSequence.script = binding("rig/swapped-script.json");
    expect(() => PolicyRigEvidenceSchema.parse(swapped)).toThrow();
    const missingInteractionMember = rigEvidence();
    const firstHistory = first(
      missingInteractionMember.sequences.filter((sequence) => sequence.history_interaction),
    );
    firstHistory.history_interaction?.pass_ids.pop();
    expect(() => PolicyRigEvidenceSchema.parse(missingInteractionMember)).toThrow();
    const inconsistentTruth = rigEvidence();
    first(inconsistentTruth.sequences).truth_effects.baseline.blocking_fn = 1;
    expect(() => PolicyRigEvidenceSchema.parse(inconsistentTruth)).toThrow();
    const ranWithoutOpportunity = rigEvidence();
    first(first(ranWithoutOpportunity.sequences).turns).opportunity = {
      summary: 0,
      evaluations: 0,
      stages: 0,
      observed: true,
    };
    expect(() => PolicyRigEvidenceSchema.parse(ranWithoutOpportunity)).toThrow();
    const missingVerifiedArtifact = rigEvidence();
    missingVerifiedArtifact.artifacts.pop();
    expect(() => PolicyRigEvidenceSchema.parse(missingVerifiedArtifact)).toThrow();
    const changedInventoryDigest = rigEvidence();
    changedInventoryDigest.artifact_inventory_sha256 = "f".repeat(64);
    expect(() => PolicyRigEvidenceSchema.parse(changedInventoryDigest)).toThrow();
    const invalidSourceCommit = rigEvidence();
    invalidSourceCommit.source_commit = "not-a-commit";
    expect(() => PolicyRigEvidenceSchema.parse(invalidSourceCommit)).toThrow();
    evidence.sequences.pop();
    expect(() => PolicyRigEvidenceSchema.parse(evidence)).toThrow();
  });

  test("rejects a Rig manifest scenario below two opportunity turns", () => {
    const manifest = scenarios();
    first(manifest.scenarios as Record<string, unknown>[]).expected_opportunity_turns = 1;
    expect(() => PolicyRigScenarioManifestSchema.parse(manifest)).toThrow();
  });

  test("rejects Rig evidence below two opportunity turns", () => {
    const evidence = rigEvidence();
    first(evidence.sequences).opportunity_turns = 1;
    expect(() => PolicyRigEvidenceSchema.parse(evidence)).toThrow();
  });

  test("binds exact isolated repeat identities and every immutable Bench profile artifact", () => {
    const bundle = policyBenchBundle();
    expect(() => PolicyBenchBundleSchema.parse(bundle)).not.toThrow();
    expect(() => PolicyBenchProfileArtifactSchema.parse(first(bundle.profiles).data)).not.toThrow();

    const missingRepeat = structuredClone(bundle);
    const missingRepeatProfile = first(missingRepeat.profiles);
    missingRepeatProfile.data.repeats.pop();
    rebindPolicyProfile(missingRepeatProfile);
    expect(() => PolicyBenchBundleSchema.parse(missingRepeat)).toThrow();

    const swappedRepeatIdentity = structuredClone(bundle);
    const swappedRepeats = first(swappedRepeatIdentity.profiles).data.repeats;
    const firstRepeat = first(swappedRepeats);
    const secondRepeat = swappedRepeats[1];
    if (secondRepeat === undefined) throw new Error("missing second repeat fixture");
    firstRepeat.response_manifest = secondRepeat.response_manifest;
    rebindPolicyProfile(first(swappedRepeatIdentity.profiles));
    expect(() => PolicyBenchBundleSchema.parse(swappedRepeatIdentity)).toThrow();

    const reusedRepeatResult = structuredClone(bundle);
    const reusedResultRepeats = first(reusedRepeatResult.profiles).data.repeats;
    const reusedResultSecond = reusedResultRepeats[1];
    if (reusedResultSecond === undefined) throw new Error("missing reused-result repeat fixture");
    reusedResultSecond.result = first(reusedResultRepeats).result;
    rebindPolicyProfile(first(reusedRepeatResult.profiles));
    expect(() => PolicyBenchBundleSchema.parse(reusedRepeatResult)).toThrow();

    const identicalLogicalResponses = structuredClone(bundle);
    for (const profile of identicalLogicalResponses.profiles) {
      const identicalFirst = first(profile.data.repeats);
      const identicalThird = profile.data.repeats[2];
      if (identicalThird === undefined) throw new Error("missing third repeat fixture");
      identicalThird.ordered_response_sha256 = identicalFirst.ordered_response_sha256;
      rebindPolicyProfile(profile);
    }
    expect(() => PolicyBenchBundleSchema.parse(identicalLogicalResponses)).not.toThrow();

    const responseSetOnlyMatch = structuredClone(bundle);
    const reorderedProfile = responseSetOnlyMatch.profiles[1];
    if (reorderedProfile === undefined) throw new Error("missing reordered profile fixture");
    first(reorderedProfile.data.repeats).ordered_response_sha256.reverse();
    rebindPolicyProfile(reorderedProfile);
    expect(() => PolicyBenchBundleSchema.parse(responseSetOnlyMatch)).toThrow();

    const mismatchedArtifactHash = structuredClone(bundle);
    first(mismatchedArtifactHash.profiles).artifact.sha256 = "f".repeat(64);
    expect(() => PolicyBenchBundleSchema.parse(mismatchedArtifactHash)).toThrow();

    const wrongCaseRepeat = structuredClone(bundle);
    const wrongCaseProfile = first(wrongCaseRepeat.profiles);
    const wrongRepeatCase = first(first(wrongCaseProfile.data.repeats).cases);
    wrongRepeatCase.repeat = 2;
    rebindPolicyProfile(wrongCaseProfile);
    expect(() => PolicyBenchBundleSchema.parse(wrongCaseRepeat)).toThrow();

    const notRunRequestedPass = structuredClone(bundle);
    const singletonProfile = notRunRequestedPass.profiles[1];
    if (singletonProfile === undefined) throw new Error("missing singleton profile fixture");
    const requestedPass = first(first(singletonProfile.data.repeats).requested_passes);
    requestedPass.ran_cases = 0;
    rebindPolicyProfile(singletonProfile);
    expect(() => PolicyBenchBundleSchema.parse(notRunRequestedPass)).toThrow();

    const nonAuthoritativeCase = structuredClone(bundle);
    const nonAuthoritativeProfile = first(nonAuthoritativeCase.profiles);
    first(nonAuthoritativeProfile.data.repeats).authoritative = false as true;
    rebindPolicyProfile(nonAuthoritativeProfile);
    expect(() => PolicyBenchBundleSchema.parse(nonAuthoritativeCase)).toThrow();

    const tamperedTruth = structuredClone(bundle);
    const tamperedProfile = first(tamperedTruth.profiles);
    for (const repeat of tamperedProfile.data.repeats) {
      first(repeat.cases).policy_truth_sha256 = "e".repeat(64);
    }
    rebindPolicyProfile(tamperedProfile);
    expect(() => PolicyBenchBundleSchema.parse(tamperedTruth)).not.toThrow();

    const reusedProfileArtifact = structuredClone(bundle);
    const firstProfile = first(reusedProfileArtifact.profiles);
    const secondProfile = reusedProfileArtifact.profiles[1];
    if (secondProfile === undefined) throw new Error("missing second profile fixture");
    secondProfile.artifact = firstProfile.artifact;
    expect(() => PolicyBenchBundleSchema.parse(reusedProfileArtifact)).toThrow();
  }, 30_000);
});
