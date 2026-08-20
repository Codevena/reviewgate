import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalJson } from "../../src/audit/canonical.ts";
import { __policyStatsTest } from "../../src/cli/commands/stats.ts";
import { POLICY_PASSES, POLICY_PASS_IDS } from "../../src/core/policy/catalog.ts";
import {
  POLICY_MEASUREMENT_INTERACTIONS,
  POLICY_MEASUREMENT_LANES,
  POLICY_MEASUREMENT_STATEFUL_PASS_IDS,
} from "../../src/core/policy/measurement-contract.ts";
import { PolicyMeasurementPreregistrationSchema } from "../../src/schemas/policy-measurement-preregistration.ts";
import {
  PolicyDogfoodAttestationSchema,
  PolicyDogfoodInputManifestSchema,
  type PolicyMeasurement,
  PolicyMeasurementSchema,
  PolicyRigEvidenceSchema,
} from "../../src/schemas/policy-measurement.ts";
import { classifyPolicyPasses } from "../../src/stats/policy/classify.ts";
import { policyDogfoodAttestationPreflight } from "../../src/stats/policy/dogfood-attestation.ts";
import { POLICY_DOGFOOD_EXCLUSION_CODES } from "../../src/stats/policy/dogfood-snapshot.ts";
import {
  holmAdjustPolicyFamilies,
  policyBenchStatistics,
  policyIndependentSequenceStatistics,
} from "../../src/stats/policy/statistics.ts";
import {
  rigFixtureIdentityInventories,
  validPolicyRigEvidence,
} from "../fixtures/policy-publication.ts";

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const SHA = "a".repeat(64);
const ATTEMPT = "attempt-publication";
const ATTEMPT_ROOT = `bench/results/policy-measurement/${ATTEMPT}`;

function preregistration(
  nested: boolean,
  statefulManifest: { ref: string; sha256: string },
  dogfood: {
    input_manifest_ref: string;
    input_manifest_sha256: string;
    attestation_ref: string;
    attestation_sha256: string;
  },
) {
  const outputs = nested
    ? {
        attempt_dir: ATTEMPT_ROOT,
        bench_bundle: `${ATTEMPT_ROOT}/capture/bench.json`,
        rig_bundle: `${ATTEMPT_ROOT}/derived/rig/rig.json`,
        dogfood_snapshot: `${ATTEMPT_ROOT}/derived/dogfood/dogfood.json`,
        result_json: `${ATTEMPT_ROOT}/reports/result.json`,
        report_md: `${ATTEMPT_ROOT}/reports/report.md`,
      }
    : {
        attempt_dir: ATTEMPT_ROOT,
        bench_bundle: `${ATTEMPT_ROOT}/bench.json`,
        rig_bundle: `${ATTEMPT_ROOT}/rig.json`,
        dogfood_snapshot: `${ATTEMPT_ROOT}/dogfood.json`,
        result_json: `${ATTEMPT_ROOT}/result.json`,
        report_md: `${ATTEMPT_ROOT}/report.md`,
      };
  return PolicyMeasurementPreregistrationSchema.parse({
    schema: "reviewgate.policy-measurement.preregistration.v1",
    registered_at: "2026-08-12T09:00:00.000Z",
    release: "0.1.0-alpha.13",
    attempt: ATTEMPT,
    source: {
      ref: "9730b52f1ccdbb4eba0de3ac6daa0a7f120da65d",
      runner: "dist/reviewgate",
      require_exact_clean_head_containing_this_file: true,
      require_compiled_runner_sha256: true,
    },
    catalog_version: "reviewgate.policy-catalog.v1",
    pass_ids: [...POLICY_PASS_IDS],
    corpus: {
      path: "bench/corpus/policy-measurement",
      unique_cases: 30,
      clean: 16,
      seeded_bug: 14,
      repeats: 3,
      manifest_sha256: SHA,
      content_sha256: Object.fromEntries([
        ...Array.from({ length: 16 }, (_, index) => [
          `cases/clean-${String(index + 1).padStart(2, "0")}.json`,
          SHA,
        ]),
        ...Array.from({ length: 14 }, (_, index) => [
          `cases/seeded-${String(index + 1).padStart(2, "0")}.json`,
          SHA,
        ]),
      ]),
    },
    roster: {
      reviewers: [
        {
          provider: "openrouter",
          model: "openai/gpt-5",
          persona: "reviewer",
          openrouter_provider: { only: ["openai"], order: ["openai"], allowFallbacks: false },
        },
      ],
      critic: { provider: "codex", model: "gpt-5", persona: "critic", openrouter_provider: null },
      substitution_allowed: false,
    },
    execution: { reviewer_max_attempts: 1, critic_max_attempts: 1, max_output_tokens: 4096 },
    profiles: {
      singleton: POLICY_PASS_IDS.map((passId) => [passId]),
      interactions: POLICY_MEASUREMENT_INTERACTIONS.map((group) => [...group]),
    },
    stateful: {
      manifest_ref: statefulManifest.ref,
      manifest_sha256: statefulManifest.sha256,
      min_sequences_per_pass: 3,
      min_opportunity_turns: 2,
    },
    dogfood: {
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-12T09:00:00.000Z",
      ...dogfood,
      min_dispositions: 5,
      min_runs: 3,
    },
    analysis: {
      stateless_min_cases: 8,
      stateless_min_signatures: 15,
      bootstrap_resamples: 10_000,
      seed: 1,
      primary: "ground_truth_error",
      interval: "percentile-bootstrap-95",
      correction: { singleton: "holm-18", interaction: "holm-4" },
      candidate_rules: "safety-first-two-phase-v1",
      vetoes: ["unique-prevented-fp", "unique-preserved-tp", "required-backstop"],
    },
    hard_gates: {
      maximum_provider_calls: 100,
      maximum_failed_fraction: 0,
      reviewer_coverage: 1,
      eligible_critic_coverage: 1,
      immutable_artifacts: true,
      no_variant_provider_calls: true,
    },
    outputs,
    commands: {
      bench: ["reviewgate", "bench", "policy"],
      stats: ["reviewgate", "stats", "policy"],
    },
    rerun_policy: {
      failed_attempts_are_preserved: true,
      overwrite_allowed: false,
      favorable_repeat_selection_allowed: false,
    },
  });
}

type FixtureSource = {
  kind:
    | "preregistration"
    | "bench"
    | "rig"
    | "dogfood-input"
    | "dogfood-attestation"
    | "dogfood-audit";
  ref: string;
  sha256: string;
};

function fixtureDogfoodAuthority() {
  const rows = [
    {
      run_id: "fixture-run",
      iter: 1,
      finding_signature: "fixture-signature",
      disposition: "declined" as const,
    },
  ];
  const manifest = PolicyDogfoodInputManifestSchema.parse({
    schema: "reviewgate.policy-dogfood-input-manifest.v1",
    since: "2026-08-01T00:00:00.000Z",
    until: "2026-08-12T09:00:00.000Z",
    entries: [],
  });
  const input_manifest_ref = "bench/inputs/dogfood.json";
  const inputManifestText = canonicalJson(manifest);
  const input_manifest_sha256 = sha256(inputManifestText);
  const attestation = PolicyDogfoodAttestationSchema.parse({
    schema: "reviewgate.policy-dogfood-attestation.v1",
    actor: "fixture",
    attested_at: "2026-08-12T08:00:00.000Z",
    challenge_sha256: policyDogfoodAttestationPreflight({
      manifest,
      actor: "fixture",
      rows,
    }).candidateSha256,
    input_manifest_sha256,
    rows,
  });
  const attestation_ref = "bench/attestations/dogfood.json";
  const attestationText = canonicalJson(attestation);
  const attestation_sha256 = sha256(attestationText);
  return {
    preregistration: {
      input_manifest_ref,
      input_manifest_sha256,
      attestation_ref,
      attestation_sha256,
    },
    snapshot: {
      schema: "reviewgate.policy-dogfood-snapshot.v1" as const,
      input_manifest: { ref: input_manifest_ref, sha256: input_manifest_sha256 },
      attestation: { ref: attestation_ref, sha256: attestation_sha256 },
      declined: 0,
      labels: [],
      exclusions: Object.fromEntries(
        POLICY_DOGFOOD_EXCLUSION_CODES.map((code) => [code, code === "incomplete-trace" ? 1 : 0]),
      ),
    },
    files: [
      {
        kind: "dogfood-input" as const,
        ref: input_manifest_ref,
        text: inputManifestText,
        mode: 0o600,
      },
      {
        kind: "dogfood-attestation" as const,
        ref: attestation_ref,
        text: attestationText,
        mode: 0o600,
      },
    ],
  };
}

function measurement(sources: readonly FixtureSource[], rigBundle: unknown) {
  const preregistrationSource = sources.find(
    (source) => source.ref === "bench/preregistrations/policy.json",
  );
  if (preregistrationSource === undefined) throw new Error("missing preregistration binding");
  const prereg = { ref: preregistrationSource.ref, sha256: preregistrationSource.sha256 };
  const binding = (kind: "bench" | "rig" | "dogfood-input" | "dogfood-attestation"): string => {
    const source = sources.find((row) => row.kind === kind);
    if (source === undefined) throw new Error(`missing ${kind} fixture source`);
    return source.ref;
  };
  const refs = {
    "stateless-bench": binding("bench"),
    "stateful-rig": binding("rig"),
    dogfood: binding("dogfood-input"),
    "dogfood-attestation": binding("dogfood-attestation"),
  };
  const fixtureStatistics = () => policyBenchStatistics([], 1).statistics;
  const bindingsByRef = new Map(sources.map(({ ref, sha256 }) => [ref, { ref, sha256 }]));
  const rigInventories = rigFixtureIdentityInventories(rigBundle);
  const rig = PolicyRigEvidenceSchema.parse(rigBundle);
  const emptyEvidence = (pass: (typeof POLICY_PASSES)[number]) => ({
    pass_id: pass.id,
    lane: POLICY_MEASUREMENT_LANES[pass.id],
    catalog_snapshot: {
      order: pass.order,
      class: pass.class,
      overlaps_with: [...pass.overlaps_with],
      opportunity_sha256: sha256(pass.opportunity),
    },
    eligibility: { stateless: false, stateful: false, dogfood: false },
    authority: { stateless: false, stateful: false, dogfood: false },
    opportunities: { cases: 0, signatures: 0, turns: 0, runs: 0 },
    exclusions: [{ lane: "dogfood" as const, code: "incomplete-trace", count: 1 }],
    truth_effects: {
      baseline: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
      ablated: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
      error_reduction: 0,
    },
    trace_totals: { applied: 0, would_apply: 0, protected: 0, no_opportunity: 0 },
    statistics: fixtureStatistics(),
    unique_contributions: [],
    raw_evidence_refs: Object.values(refs).sort(),
    lane_summaries:
      POLICY_MEASUREMENT_LANES[pass.id] === "stateful-rig"
        ? [
            ...(["stateless-bench", "stateful-rig", "dogfood"] as const).map((lane) => ({
              lane,
              primary: lane === "stateful-rig",
              descriptive: lane !== "stateful-rig",
              eligible: true,
              authoritative: true,
              opportunities: { cases: 0, signatures: 0, turns: 0, runs: 0 },
              exclusions:
                lane === "dogfood"
                  ? [{ lane: "dogfood" as const, code: "incomplete-trace", count: 1 }]
                  : [],
              truth_effects: {
                baseline: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
                ablated: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
                error_reduction: 0,
              },
              trace_totals: { applied: 0, would_apply: 0, protected: 0, no_opportunity: 0 },
              statistics: fixtureStatistics(),
              limitations:
                lane === "dogfood"
                  ? [
                      "no-opportunities-observed",
                      "precision-denominator-unavailable",
                      "recall-denominator-unavailable",
                      "run-level-effects-are-descriptive",
                      "secondary-lane-does-not-classify",
                    ]
                  : ["fixture-synthetic"],
              raw_evidence_refs:
                lane === "dogfood"
                  ? [refs.dogfood, refs["dogfood-attestation"]].sort()
                  : [refs[lane]],
            })),
          ]
        : [
            ...(["stateless-bench", "dogfood"] as const).map((lane) => ({
              lane,
              primary: lane === "stateless-bench",
              descriptive: lane !== "stateless-bench",
              eligible: true,
              authoritative: true,
              opportunities: { cases: 0, signatures: 0, turns: 0, runs: 0 },
              exclusions:
                lane === "dogfood"
                  ? [{ lane: "dogfood" as const, code: "incomplete-trace", count: 1 }]
                  : [],
              truth_effects: {
                baseline: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
                ablated: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
                error_reduction: 0,
              },
              trace_totals: { applied: 0, would_apply: 0, protected: 0, no_opportunity: 0 },
              statistics: fixtureStatistics(),
              limitations:
                lane === "dogfood"
                  ? [
                      "no-opportunities-observed",
                      "precision-denominator-unavailable",
                      "recall-denominator-unavailable",
                      "run-level-effects-are-descriptive",
                      "secondary-lane-does-not-classify",
                    ]
                  : ["fixture-synthetic"],
              raw_evidence_refs:
                lane === "dogfood"
                  ? [refs.dogfood, refs["dogfood-attestation"]].sort()
                  : [refs[lane]],
            })),
          ],
  });
  const passes = POLICY_PASSES.map((pass) => ({
    pass_id: pass.id,
    classification: "inconclusive" as const,
    reasons: ["insufficient-opportunities" as const],
    vetoes: [],
    harm_observed: false,
    evidence_refs: [] as string[],
    evidence: emptyEvidence(pass),
  }));
  const interactions = POLICY_MEASUREMENT_INTERACTIONS.map((pass_ids) => {
    const stateful = pass_ids.every((passId) =>
      POLICY_MEASUREMENT_STATEFUL_PASS_IDS.includes(passId as never),
    );
    const primaryLane = stateful ? ("stateful-rig" as const) : ("stateless-bench" as const);
    const opportunities = { cases: 0, signatures: 0, turns: 0, runs: 0 };
    const group = stateful
      ? rigInventories.interactions.get([...pass_ids].sort().join("\u0000"))
      : undefined;
    if (stateful && group === undefined)
      throw new Error(`missing Rig history inventory for ${pass_ids.join(",")}`);
    const worsened = group?.outcomes.reduce((total, outcome) => total + outcome.worsened, 0) ?? 0;
    const improved = group?.outcomes.reduce((total, outcome) => total + outcome.improved, 0) ?? 0;
    const truthEffects = {
      baseline: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
      ablated: { blocking_fp: 0, blocking_fn: worsened - improved, blocking_tp: 0 },
      error_reduction: improved - worsened,
    };
    const statistics = fixtureStatistics();
    const summary = (lane: "stateless-bench" | "stateful-rig", primary: boolean) => ({
      lane,
      primary,
      descriptive: !primary,
      eligible: true,
      authoritative: true,
      opportunities,
      exclusions: [],
      truth_effects: truthEffects,
      trace_totals: { applied: 0, would_apply: 0, protected: 0, no_opportunity: 0 },
      statistics,
      limitations: ["fixture-synthetic"],
      raw_evidence_refs: [refs[lane]],
    });
    const artifact = stateful ? bindingsByRef.get(refs[primaryLane]) : prereg;
    if (artifact === undefined) throw new Error("publication fixture missing Rig source binding");
    const identityRefs = [
      artifact.ref,
      refs[primaryLane],
      ...(stateful ? [refs["stateless-bench"], refs["stateful-rig"]] : [refs["stateless-bench"]]),
    ]
      .filter((ref, index, values) => values.indexOf(ref) === index)
      .sort();
    const identityBindings = identityRefs.map((ref) => {
      const source = bindingsByRef.get(ref);
      if (source === undefined) throw new Error(`publication fixture source missing: ${ref}`);
      return source;
    });
    return {
      pass_ids: [...pass_ids],
      artifact,
      primary_lane: primaryLane,
      evidence: {
        authoritative: false,
        eligibility: { stateless: false, stateful: false, dogfood: false },
        authority: { stateless: false, stateful: false, dogfood: false },
        opportunities,
        exclusions: [],
        truth_effects: truthEffects,
        statistics,
        raw_evidence_refs: [refs[primaryLane]],
      },
      lane_summaries: stateful
        ? [summary("stateless-bench", false), summary("stateful-rig", true)]
        : [summary("stateless-bench", true)],
      identity_inventory: {
        raw_evidence: identityBindings,
        events: group?.events ?? [],
        outcomes: group?.outcomes ?? [],
      },
    };
  });
  const aggregateTruth = (
    rows: readonly {
      truth_effects: {
        baseline: { blocking_fp: number; blocking_fn: number; blocking_tp: number };
        ablated: { blocking_fp: number; blocking_fn: number; blocking_tp: number };
      };
    }[],
  ) =>
    rows.reduce(
      (total, row) => ({
        baseline: {
          blocking_fp: total.baseline.blocking_fp + row.truth_effects.baseline.blocking_fp,
          blocking_fn: total.baseline.blocking_fn + row.truth_effects.baseline.blocking_fn,
          blocking_tp: total.baseline.blocking_tp + row.truth_effects.baseline.blocking_tp,
        },
        ablated: {
          blocking_fp: total.ablated.blocking_fp + row.truth_effects.ablated.blocking_fp,
          blocking_fn: total.ablated.blocking_fn + row.truth_effects.ablated.blocking_fn,
          blocking_tp: total.ablated.blocking_tp + row.truth_effects.ablated.blocking_tp,
        },
      }),
      {
        baseline: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
        ablated: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
      },
    );
  for (const [index, pass] of passes.entries()) {
    if (POLICY_MEASUREMENT_LANES[pass.pass_id] !== "stateful-rig") continue;
    const sequences = rig.sequences.filter((sequence) => sequence.pass_id === pass.pass_id);
    const statistics = policyIndependentSequenceStatistics(
      sequences.map((sequence) => sequence.truth_effects.error_reduction),
      1 + index,
      aggregateTruth(sequences),
    );
    pass.evidence.statistics = statistics;
    const summary = pass.evidence.lane_summaries.find((row) => row.lane === "stateful-rig");
    if (summary === undefined) throw new Error(`missing Rig lane for ${pass.pass_id}`);
    summary.statistics = statistics;
  }
  const groups = rig.sequences.flatMap((sequence) =>
    sequence.history_interaction === null ? [] : [sequence.history_interaction],
  );
  for (const [index, interaction] of interactions.entries()) {
    if (interaction.primary_lane !== "stateful-rig") continue;
    const statistics = policyIndependentSequenceStatistics(
      groups.map((group) => group.truth_effects.error_reduction),
      1 + index,
      aggregateTruth(groups),
    );
    interaction.evidence.statistics = statistics;
    const summary = interaction.lane_summaries.find((row) => row.lane === "stateful-rig");
    if (summary === undefined) throw new Error("missing Rig interaction lane");
    summary.statistics = statistics;
  }
  for (const [index, pass] of passes.entries()) {
    const summary = pass.evidence.lane_summaries.find((row) => row.lane === "dogfood");
    if (summary === undefined) throw new Error(`missing Dogfood lane for ${pass.pass_id}`);
    summary.statistics = policyIndependentSequenceStatistics([], 1 + index);
  }
  const adjusted = holmAdjustPolicyFamilies({
    singleton: passes.map((pass) => pass.evidence.statistics.p_value),
    interaction: interactions.map((interaction) => interaction.evidence.statistics.p_value),
  });
  for (const [index, pass] of passes.entries()) {
    pass.evidence.statistics.adjusted_p_value = adjusted.singleton[index] ?? 1;
    const primary = pass.evidence.lane_summaries.find((summary) => summary.primary);
    if (primary === undefined) throw new Error(`missing primary lane for ${pass.pass_id}`);
    primary.statistics.adjusted_p_value = adjusted.singleton[index] ?? 1;
  }
  for (const [index, interaction] of interactions.entries()) {
    interaction.evidence.statistics.adjusted_p_value = adjusted.interaction[index] ?? 1;
    const primary = interaction.lane_summaries.find((summary) => summary.primary);
    if (primary === undefined) throw new Error("missing primary interaction lane");
    primary.statistics.adjusted_p_value = adjusted.interaction[index] ?? 1;
  }
  for (const pass of passes) {
    const passRefs = new Set(
      pass.evidence.lane_summaries.flatMap((summary) => summary.raw_evidence_refs),
    );
    for (const interaction of interactions) {
      if (!interaction.pass_ids.includes(pass.pass_id as never)) continue;
      passRefs.add(interaction.artifact.ref);
      for (const ref of interaction.evidence.raw_evidence_refs) passRefs.add(ref);
      for (const summary of interaction.lane_summaries) {
        for (const ref of summary.raw_evidence_refs) passRefs.add(ref);
      }
    }
    const closedRefs = [...passRefs].sort();
    pass.evidence.raw_evidence_refs = closedRefs;
    pass.evidence_refs = closedRefs;
  }
  const identity_evidence = passes.map((pass) => ({
    pass_id: pass.pass_id,
    singleton_inventory: {
      raw_evidence: pass.evidence.lane_summaries
        .filter((summary) => summary.lane === pass.evidence.lane)
        .flatMap((summary) => summary.raw_evidence_refs)
        .sort()
        .map((ref) => {
          const source = bindingsByRef.get(ref);
          if (source === undefined) throw new Error(`publication fixture source missing: ${ref}`);
          return source;
        }),
      events: rigInventories.singleton.get(pass.pass_id) ?? [],
      protection_events: [],
    },
    ground_truth_harms: [],
    dogfood_dispositions: [],
    beneficial_effects: [],
  }));
  const classifications = classifyPolicyPasses(
    passes.map((pass) => pass.evidence as never),
    {
      passFacts: identity_evidence as never,
      interactions: interactions as never,
    },
  );
  for (const [index, classification] of classifications.entries()) {
    const pass = passes[index];
    if (pass === undefined) throw new Error("missing publication classification fixture pass");
    Object.assign(pass, {
      classification: classification.classification,
      reasons: classification.reasons,
      vetoes: classification.vetoes,
      harm_observed: classification.harm_observed,
      evidence_refs: classification.evidence_refs,
    });
  }
  return PolicyMeasurementSchema.parse({
    schema: "reviewgate.policy-measurement.v1",
    preregistration: prereg,
    catalog_version: "reviewgate.policy-catalog.v1",
    passes,
    interactions,
    identity_evidence,
    artifacts: {
      authoritative: true,
      sources: sources.map(({ ref, sha256 }) => ({ ref, sha256 })),
      exclusions: [],
      evidence: sources.map(({ ref, sha256 }) => ({ ref, sha256 })),
      inventory: sources.map(({ ref, sha256 }) => ({ ref, sha256 })),
    },
  });
}

function fixture(nested = false, rigWithHistoryEvent = false) {
  const root = mkdtempSync(join(tmpdir(), "rg-policy-publication-"));
  const rigRef = "rig/scenarios.json";
  const rigText = canonicalJson({ schema: "fixture.rig-source.v1" });
  const dogfood = fixtureDogfoodAuthority();
  const prereg = preregistration(
    nested,
    { ref: rigRef, sha256: sha256(rigText) },
    dogfood.preregistration,
  );
  const files = new Map<
    string,
    {
      kind: "preregistration" | "bench" | "rig" | "dogfood-input" | "dogfood-attestation";
      text: string;
      mode: number;
    }
  >([
    [
      "bench/preregistrations/policy.json",
      { kind: "preregistration", text: canonicalJson(prereg), mode: 0o644 },
    ],
    [
      prereg.outputs.bench_bundle,
      { kind: "bench", text: canonicalJson({ schema: "fixture.bench.v1" }), mode: 0o600 },
    ],
    [rigRef, { kind: "rig", text: rigText, mode: 0o600 }],
    ...dogfood.files.map((file) => [file.ref, file] as const),
  ]);
  const auditRef = ".reviewgate/audit/closed.jsonl";
  const audit = `${JSON.stringify({ schema: "reviewgate.audit.v1", event: "run.complete" })}\n`;
  mkdirSync(join(root, ATTEMPT_ROOT), { recursive: true, mode: 0o700 });
  chmodSync(join(root, ATTEMPT_ROOT), 0o700);
  for (const [ref, file] of files) {
    mkdirSync(dirname(join(root, ref)), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, ref), file.text, { mode: file.mode });
    chmodSync(join(root, ref), file.mode);
  }
  mkdirSync(dirname(join(root, auditRef)), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, auditRef), audit, { mode: 0o600 });
  chmodSync(join(root, auditRef), 0o600);
  const sources = [
    ...[...files.entries()].map(([ref, file]) => ({
      kind: file.kind,
      ref,
      sha256: sha256(file.text),
    })),
    { kind: "dogfood-audit" as const, ref: auditRef, sha256: sha256(audit) },
  ].sort((left, right) => left.ref.localeCompare(right.ref));
  const rigSource = sources.find((source) => source.kind === "rig");
  if (rigSource === undefined) throw new Error("fixture Rig source missing");
  const rigBundle = validPolicyRigEvidence({
    scenarioManifest: { ref: rigSource.ref, sha256: rigSource.sha256 },
    withErrorEvents: rigWithHistoryEvent,
  });
  const mutableRigBundle = structuredClone(rigBundle) as {
    sequences: Array<{
      history_interaction: null | {
        turns: Array<{
          baseline: { errors: unknown[] };
          counterfactual: { errors: unknown[] };
        }>;
      };
    }>;
  };
  if (!rigWithHistoryEvent) {
    for (const sequence of mutableRigBundle.sequences) {
      for (const turn of sequence.history_interaction?.turns ?? []) {
        turn.counterfactual.errors = structuredClone(turn.baseline.errors);
      }
    }
  }
  const runtime = {
    async assemble() {
      return {
        result: measurement(sources, mutableRigBundle),
        sources,
        publication: {
          rig_bundle: mutableRigBundle,
          dogfood_snapshot: dogfood.snapshot,
        },
      } as never;
    },
  };
  return { root, prereg, audit, auditRef, dogfood, runtime, sources };
}

describe("policy measurement capture publication", () => {
  test("completes a real preregistered capture root with byte-exact JSONL and every bound output", async () => {
    const value = fixture();
    const result = await __policyStatsTest.run(
      {
        repoRoot: value.root,
        preregistration: "bench/preregistrations/policy.json",
        bench: value.prereg.outputs.bench_bundle,
        rig: "rig/evidence.json",
        out: value.prereg.outputs.attempt_dir,
      },
      value.runtime,
    );
    const out = join(value.root, ATTEMPT_ROOT);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(__policyStatsTest.verifyPublishedPolicyBundle(out)).toBe(true);
    const marker = JSON.parse(readFileSync(join(out, "complete.json"), "utf8")) as {
      outputs: Record<string, { ref: string; sha256: string }>;
      sources: Array<{ ref: string; sha256: string; copy_ref: string }>;
    };
    expect(Object.keys(marker.outputs).sort()).toEqual([
      "bench_bundle",
      "dogfood_snapshot",
      "report_md",
      "result_json",
      "rig_bundle",
    ]);
    expect(marker.sources).toEqual(
      value.sources.map((source) =>
        expect.objectContaining({ ref: source.ref, sha256: source.sha256 }),
      ),
    );
    const auditSource = marker.sources.find((source) => source.ref === value.auditRef);
    if (auditSource === undefined) throw new Error("missing audit source copy");
    expect(readFileSync(join(out, auditSource.copy_ref), "utf8")).toBe(value.audit);
    for (const ref of [
      "result.json",
      "report.md",
      "rig.json",
      "dogfood.json",
      "complete.json",
      auditSource.copy_ref,
    ])
      expect(lstatSync(join(out, ref)).mode & 0o7777).toBe(0o600);
  });

  test("the external verifier rejects event evidence it cannot recompute from copied sources", async () => {
    const value = fixture();
    const runtime = {
      ...value.runtime,
      async assemble() {
        const assembled = (await value.runtime.assemble()) as {
          result: PolicyMeasurement;
          sources: unknown;
          publication: unknown;
        };
        const result = structuredClone(assembled.result);
        const interaction = result.interactions[0];
        if (interaction === undefined) throw new Error("missing stateless interaction fixture");
        const source = interaction.artifact;
        interaction.identity_inventory.events = [
          {
            lane: "stateless-bench",
            unit: "bench:fixture:repeat-1",
            identity: "bench:fixture:blocking-fp:fixture-a",
            direction: "worsened",
            count: 1,
            source,
          },
          {
            lane: "stateless-bench",
            unit: "bench:fixture:repeat-2",
            identity: "bench:fixture:blocking-fp:fixture-a",
            direction: "improved",
            count: 1,
            source,
          },
        ];
        interaction.identity_inventory.outcomes = [
          { identity: "bench:fixture:blocking-fp:fixture-a", worsened: 1, improved: 1 },
        ];
        const classifications = classifyPolicyPasses(
          result.passes.map((pass) => pass.evidence),
          { passFacts: result.identity_evidence, interactions: result.interactions },
        );
        for (const [index, classification] of classifications.entries()) {
          const pass = result.passes[index];
          if (pass === undefined) throw new Error("missing event fixture pass");
          Object.assign(pass, {
            classification: classification.classification,
            reasons: classification.reasons,
            vetoes: classification.vetoes,
            harm_observed: classification.harm_observed,
            evidence_refs: classification.evidence_refs,
          });
        }
        return { ...assembled, result: PolicyMeasurementSchema.parse(result) } as never;
      },
    };
    const publication = await __policyStatsTest.run(
      {
        repoRoot: value.root,
        preregistration: "bench/preregistrations/policy.json",
        bench: value.prereg.outputs.bench_bundle,
        rig: "rig/evidence.json",
        out: value.prereg.outputs.attempt_dir,
      },
      runtime,
    );
    expect(publication.exitCode).toBe(4);
    expect(existsSync(join(value.root, ATTEMPT_ROOT, "complete.json"))).toBe(false);
  });

  test("rejects an empty Rig lane event claim when Bench is legacy", async () => {
    const value = fixture();
    const rigSource = value.sources.find((source) => source.kind === "rig");
    if (rigSource === undefined) throw new Error("fixture Rig source missing");
    const runtime = {
      ...value.runtime,
      async assemble() {
        const assembled = (await value.runtime.assemble()) as {
          result: PolicyMeasurement;
          sources: unknown;
          publication: unknown;
        };
        return {
          ...assembled,
          publication: {
            rig_bundle: validPolicyRigEvidence({
              scenarioManifest: { ref: rigSource.ref, sha256: rigSource.sha256 },
              withErrorEvents: true,
            }),
            dogfood_snapshot: value.dogfood.snapshot,
          },
        } as never;
      },
    };
    const publication = await __policyStatsTest.run(
      {
        repoRoot: value.root,
        preregistration: "bench/preregistrations/policy.json",
        bench: value.prereg.outputs.bench_bundle,
        rig: "rig/evidence.json",
        out: value.prereg.outputs.attempt_dir,
      },
      runtime,
    );
    expect(publication.exitCode).toBe(4);
  });

  test("publishes all five valid nested registered descendants", async () => {
    const value = fixture(true);
    const result = await __policyStatsTest.run(
      {
        repoRoot: value.root,
        preregistration: "bench/preregistrations/policy.json",
        bench: value.prereg.outputs.bench_bundle,
        rig: "rig/evidence.json",
        out: value.prereg.outputs.attempt_dir,
      },
      value.runtime,
    );
    const out = join(value.root, ATTEMPT_ROOT);

    expect(result.exitCode).toBe(0);
    expect(__policyStatsTest.verifyPublishedPolicyBundle(out)).toBe(true);
    for (const ref of [
      value.prereg.outputs.bench_bundle,
      value.prereg.outputs.rig_bundle,
      value.prereg.outputs.dogfood_snapshot,
      value.prereg.outputs.result_json,
      value.prereg.outputs.report_md,
    ]) {
      const relativeRef = ref.slice(`${ATTEMPT_ROOT}/`.length);
      expect(lstatSync(join(out, relativeRef)).mode & 0o7777).toBe(0o600);
    }
  });

  test("rejects a Bench output/inventory divergence and a redirected source copy", async () => {
    const value = fixture();
    const result = await __policyStatsTest.run(
      {
        repoRoot: value.root,
        preregistration: "bench/preregistrations/policy.json",
        bench: value.prereg.outputs.bench_bundle,
        rig: "rig/evidence.json",
        out: value.prereg.outputs.attempt_dir,
      },
      value.runtime,
    );
    const out = join(value.root, ATTEMPT_ROOT);
    expect(result.exitCode).toBe(0);
    const markerPath = join(out, "complete.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      outputs: Record<string, { ref: string; sha256: string }>;
      sources: Array<{ ref: string; sha256: string; copy_ref?: string }>;
    };
    const benchOutput = marker.outputs.bench_bundle;
    if (benchOutput === undefined) throw new Error("published Bench output missing");
    const replacement = canonicalJson({ schema: "fixture.replaced-bench.v1" });
    writeFileSync(join(out, benchOutput.ref), replacement, { mode: 0o600 });
    benchOutput.sha256 = sha256(replacement);
    writeFileSync(markerPath, canonicalJson(marker), { mode: 0o600 });
    expect(__policyStatsTest.verifyPublishedPolicyBundle(out)).toBe(false);

    writeFileSync(join(out, benchOutput.ref), canonicalJson({ schema: "fixture.bench.v1" }), {
      mode: 0o600,
    });
    const bench = value.sources.find((source) => source.ref === value.prereg.outputs.bench_bundle);
    if (bench === undefined) throw new Error("fixture Bench source missing");
    benchOutput.sha256 = bench.sha256;
    const source = marker.sources.find((row) => row.ref === bench.ref);
    if (source === undefined) throw new Error("published Bench source missing");
    source.copy_ref = benchOutput.ref;
    writeFileSync(markerPath, canonicalJson(marker), { mode: 0o600 });
    expect(__policyStatsTest.verifyPublishedPolicyBundle(out)).toBe(false);
  });

  test("fails closed for source tampering and a completed capture root without replacing it", async () => {
    const tampered = fixture();
    const tamperedResult = await __policyStatsTest.run(
      {
        repoRoot: tampered.root,
        preregistration: "bench/preregistrations/policy.json",
        bench: tampered.prereg.outputs.bench_bundle,
        rig: "rig/evidence.json",
        out: tampered.prereg.outputs.attempt_dir,
      },
      {
        ...tampered.runtime,
        async assemble() {
          const assembled = await tampered.runtime.assemble();
          writeFileSync(join(tampered.root, tampered.auditRef), "tampered\n", { mode: 0o600 });
          return assembled;
        },
      },
    );
    expect(tamperedResult.exitCode).toBe(4);
    expect(existsSync(join(tampered.root, ATTEMPT_ROOT, "complete.json"))).toBe(false);

    const occupied = fixture();
    const complete = join(occupied.root, ATTEMPT_ROOT, "complete.json");
    writeFileSync(complete, "sentinel", { mode: 0o600 });
    const before = lstatSync(join(occupied.root, ATTEMPT_ROOT));
    const occupiedResult = await __policyStatsTest.run(
      {
        repoRoot: occupied.root,
        preregistration: "bench/preregistrations/policy.json",
        bench: occupied.prereg.outputs.bench_bundle,
        rig: "rig/evidence.json",
        out: occupied.prereg.outputs.attempt_dir,
      },
      occupied.runtime,
    );
    expect(occupiedResult.exitCode).toBe(2);
    expect(lstatSync(join(occupied.root, ATTEMPT_ROOT)).ino).toBe(before.ino);
    expect(readFileSync(complete, "utf8")).toBe("sentinel");
  });
});
