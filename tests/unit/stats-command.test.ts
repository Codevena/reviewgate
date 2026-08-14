// tests/unit/stats-command.test.ts
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeCanonicalJsonArtifact } from "../../src/artifacts/canonical-json.ts";
import { canonicalJson } from "../../src/audit/canonical.ts";
import {
  __policyStatsTest,
  runPolicyDogfoodAttestation,
  runPolicyStats,
  runStats,
} from "../../src/cli/commands/stats.ts";
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

function seedRepoWithRun(): string {
  const root = mkdtempSync(join(tmpdir(), "rg-stats-cmd-e2e-"));
  const now = new Date().toISOString();
  const d = new Date(now);
  const y = String(d.getUTCFullYear());
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const dir = join(root, ".reviewgate", "audit", y, m, day);
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    schema: "reviewgate.audit.v1",
    event: "run.complete",
    ts: now,
    run_id: "s1",
    iter: 1,
    trigger: "stop-hook",
    run_summary: {
      verdict: "PASS",
      source: "panel",
      counts: { critical: 0, warn: 0, info: 0 },
      cost_usd: 0.01,
      duration_ms: 50,
      demoted: 0,
      signatures: [],
      providers: [],
    },
  });
  writeFileSync(join(dir, "120000.jsonl"), `${line}\n`, { flag: "a" });
  return root;
}

function seedRepo(): string {
  return mkdtempSync(join(tmpdir(), "rg-stats-cmd-"));
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function policyPreregistration(
  out: string,
  statefulManifest: { ref: string; sha256: string },
  dogfood: {
    input_manifest_ref: string;
    input_manifest_sha256: string;
    attestation_ref: string;
    attestation_sha256: string;
  },
) {
  const sha = "a".repeat(64);
  return PolicyMeasurementPreregistrationSchema.parse({
    schema: "reviewgate.policy-measurement.preregistration.v1",
    registered_at: "2026-08-12T09:00:00.000Z",
    release: "0.1.0-alpha.13",
    attempt: out.split("/").at(-1),
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
      manifest_sha256: sha,
      content_sha256: Object.fromEntries([
        ...Array.from({ length: 16 }, (_, index) => [
          `cases/clean-${String(index + 1).padStart(2, "0")}.json`,
          sha,
        ]),
        ...Array.from({ length: 14 }, (_, index) => [
          `cases/seeded-${String(index + 1).padStart(2, "0")}.json`,
          sha,
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
    outputs: {
      attempt_dir: out,
      bench_bundle: `${out}/bench.json`,
      rig_bundle: `${out}/rig.json`,
      dogfood_snapshot: `${out}/dogfood.json`,
      result_json: `${out}/result.json`,
      report_md: `${out}/report.md`,
    },
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

function laneRefs(sources: readonly FixtureSource[]) {
  const binding = (kind: "bench" | "rig" | "dogfood-input"): string => {
    const source = sources.find((row) => row.kind === kind);
    if (source === undefined) throw new Error(`fixture source missing for ${kind}`);
    return source.ref;
  };
  return {
    "stateless-bench": binding("bench"),
    "stateful-rig": binding("rig"),
    dogfood: binding("dogfood-input"),
  };
}

function fixtureDogfoodSources(root: string) {
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
  const manifestBytes = canonicalJson(manifest);
  const input_manifest_ref = "bench/inputs/dogfood.json";
  const input_manifest_sha256 = digest(manifestBytes);
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
  const attestationBytes = canonicalJson(attestation);
  const attestation_ref = "bench/attestations/dogfood.json";
  const attestation_sha256 = digest(attestationBytes);
  for (const [ref, bytes] of [
    [input_manifest_ref, manifestBytes],
    [attestation_ref, attestationBytes],
  ] as const) {
    mkdirSync(dirname(join(root, ref)), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, ref), bytes, { mode: 0o600 });
  }
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
    sources: [
      { kind: "dogfood-input" as const, ref: input_manifest_ref, sha256: input_manifest_sha256 },
      {
        kind: "dogfood-attestation" as const,
        ref: attestation_ref,
        sha256: attestation_sha256,
      },
    ],
  };
}

function fixtureStatistics() {
  return policyBenchStatistics([], 1).statistics;
}

function emptyEvidence(pass: (typeof POLICY_PASSES)[number], refs: ReturnType<typeof laneRefs>) {
  const opportunities = { cases: 0, signatures: 0, turns: 0, runs: 0 };
  const dogfoodExclusions = [{ lane: "dogfood" as const, code: "incomplete-trace", count: 1 }];
  const truthEffects = {
    baseline: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
    ablated: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
    error_reduction: 0,
  };
  const traceTotals = { applied: 0, would_apply: 0, protected: 0, no_opportunity: 0 };
  const statistics = fixtureStatistics();
  const summary = (lane: "stateless-bench" | "stateful-rig" | "dogfood", primary: boolean) => ({
    lane,
    primary,
    descriptive: !primary,
    eligible: true,
    authoritative: true,
    opportunities,
    exclusions: lane === "dogfood" ? dogfoodExclusions : [],
    truth_effects: truthEffects,
    trace_totals: traceTotals,
    statistics,
    limitations: ["fixture-synthetic"],
    raw_evidence_refs: [refs[lane]],
  });
  return {
    pass_id: pass.id,
    lane: POLICY_MEASUREMENT_LANES[pass.id],
    catalog_snapshot: {
      order: pass.order,
      class: pass.class,
      overlaps_with: [...pass.overlaps_with],
      opportunity_sha256: digest(pass.opportunity),
    },
    eligibility: { stateless: false, stateful: false, dogfood: false },
    authority: { stateless: false, stateful: false, dogfood: false },
    opportunities,
    exclusions: dogfoodExclusions,
    truth_effects: truthEffects,
    trace_totals: traceTotals,
    statistics,
    unique_contributions: [],
    raw_evidence_refs: Object.values(refs).sort(),
    lane_summaries:
      POLICY_MEASUREMENT_LANES[pass.id] === "stateful-rig"
        ? [
            summary("stateless-bench", false),
            summary("stateful-rig", true),
            summary("dogfood", false),
          ]
        : [summary("stateless-bench", true), summary("dogfood", false)],
  };
}

function publishableMeasurement(sources: readonly FixtureSource[], rigBundle: unknown) {
  const preregistrationSource = sources.find((source) => source.ref.includes("preregistrations/"));
  if (preregistrationSource === undefined)
    throw new Error("publication fixture needs one preregistration binding");
  const binding = {
    ref: preregistrationSource.ref,
    sha256: preregistrationSource.sha256,
  };
  const refs = laneRefs(sources);
  const bindingsByRef = new Map(sources.map(({ ref, sha256 }) => [ref, { ref, sha256 }]));
  const rigInventories = rigFixtureIdentityInventories(rigBundle);
  const rig = PolicyRigEvidenceSchema.parse(rigBundle);
  const passes = POLICY_PASSES.map((pass) => ({
    pass_id: pass.id,
    classification: "inconclusive" as const,
    reasons: ["insufficient-opportunities" as const],
    vetoes: [],
    harm_observed: false,
    evidence_refs: [] as string[],
    evidence: emptyEvidence(pass, refs),
  }));
  const interactions = POLICY_MEASUREMENT_INTERACTIONS.map((passIds) => {
    const stateful = passIds.every((passId) =>
      POLICY_MEASUREMENT_STATEFUL_PASS_IDS.includes(passId as never),
    );
    const primaryLane = stateful ? ("stateful-rig" as const) : ("stateless-bench" as const);
    const opportunities = { cases: 0, signatures: 0, turns: 0, runs: 0 };
    const group = stateful
      ? rigInventories.interactions.get([...passIds].sort().join("\u0000"))
      : undefined;
    if (stateful && group === undefined)
      throw new Error(`missing Rig history inventory for ${passIds.join(",")}`);
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
    const artifact = stateful ? bindingsByRef.get(refs[primaryLane]) : binding;
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
      pass_ids: [...passIds],
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
          if (source === undefined) throw new Error(`stats fixture source missing: ${ref}`);
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
    if (pass === undefined) throw new Error("missing stats classification fixture pass");
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
    preregistration: binding,
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

function policyRuntime(root: string, out: string) {
  const ref = "bench/preregistrations/policy.json";
  const benchRef = `${out}/bench.json`;
  const benchBytes = canonicalJson({ schema: "fixture.bench.v1" });
  const rigRef = "rig/scenarios.json";
  const rigBytes = canonicalJson({ schema: "fixture.rig-source.v1" });
  const dogfood = fixtureDogfoodSources(root);
  const preregistration = policyPreregistration(
    out,
    {
      ref: rigRef,
      sha256: digest(rigBytes),
    },
    dogfood.preregistration,
  );
  const bytes = canonicalJson(preregistration);
  const path = join(root, ref);
  mkdirSync(join(root, "bench", "preregistrations"), { recursive: true });
  writeFileSync(path, bytes, { mode: 0o644 });
  const source = { kind: "preregistration" as const, ref, sha256: digest(bytes) };
  mkdirSync(join(root, out), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, benchRef), benchBytes, { mode: 0o600 });
  const benchSource = { kind: "bench" as const, ref: benchRef, sha256: digest(benchBytes) };
  for (const [inputRef, inputBytes] of [[rigRef, rigBytes]] as const) {
    mkdirSync(dirname(join(root, inputRef)), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, inputRef), inputBytes, { mode: 0o600 });
  }
  const rigSource = { kind: "rig" as const, ref: rigRef, sha256: digest(rigBytes) };
  const sources = [source, benchSource, rigSource, ...dogfood.sources].sort((left, right) =>
    left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0,
  );
  const rigBundle = validPolicyRigEvidence({
    scenarioManifest: { ref: rigRef, sha256: digest(rigBytes) },
    withErrorEvents: false,
  });
  return {
    source,
    benchRef,
    path,
    preregistration,
    runtime: {
      async assemble() {
        return {
          result: publishableMeasurement(sources, rigBundle),
          sources,
          publication: {
            rig_bundle: rigBundle,
            dogfood_snapshot: dogfood.snapshot,
          },
        } as never;
      },
      rereadPreregistration() {
        return {
          outputs: {
            attempt_dir: out,
            bench_bundle: benchRef,
            rig_bundle: `${out}/rig.json`,
            dogfood_snapshot: `${out}/dogfood.json`,
            result_json: `${out}/result.json`,
            report_md: `${out}/report.md`,
          },
        } as never;
      },
    },
  };
}

function capturedLifecycleRuntime(root: string, out: string) {
  const preregRef = "bench/preregistrations/policy.json";
  const benchRef = `${out}/bench.json`;
  const rigRef = "rig/scenarios.json";
  const auditRef = ".reviewgate/audit/closed.jsonl";
  const bench = canonicalJson({ schema: "fixture.bench.v1" });
  const rig = canonicalJson({ schema: "fixture.rig-source.v1" });
  const dogfood = fixtureDogfoodSources(root);
  const preregistration = canonicalJson(
    policyPreregistration(out, { ref: rigRef, sha256: digest(rig) }, dogfood.preregistration),
  );
  const audit = `${JSON.stringify({ schema: "reviewgate.audit.v1", event: "run.complete" })}\n`;
  for (const [ref, bytes, mode] of [
    [preregRef, preregistration, 0o644],
    [benchRef, bench, 0o600],
    [rigRef, rig, 0o600],
    [auditRef, audit, 0o600],
  ] as const) {
    mkdirSync(dirname(join(root, ref)), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, ref), bytes, { mode });
  }
  const sources = [
    { kind: "preregistration" as const, ref: preregRef, sha256: digest(preregistration) },
    { kind: "bench" as const, ref: benchRef, sha256: digest(bench) },
    { kind: "rig" as const, ref: rigRef, sha256: digest(rig) },
    { kind: "dogfood-audit" as const, ref: auditRef, sha256: digest(audit) },
    ...dogfood.sources,
  ].sort((left, right) => (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0));
  const rigBundle = validPolicyRigEvidence({
    scenarioManifest: { ref: rigRef, sha256: digest(rig) },
    withErrorEvents: false,
  });
  return {
    sources,
    runtime: {
      async assemble() {
        return {
          result: publishableMeasurement(sources, rigBundle),
          sources,
          publication: {
            rig_bundle: rigBundle,
            dogfood_snapshot: dogfood.snapshot,
          },
        } as never;
      },
      rereadPreregistration() {
        return {
          outputs: {
            attempt_dir: out,
            bench_bundle: benchRef,
            rig_bundle: `${out}/rig.json`,
            dogfood_snapshot: `${out}/dogfood.json`,
            result_json: `${out}/result.json`,
            report_md: `${out}/report.md`,
          },
        } as never;
      },
    },
  };
}

function dogfoodFixture(root: string) {
  const stored = writeCanonicalJsonArtifact({
    root,
    directory: "policy-dogfood-input",
    schema: PolicyDogfoodInputManifestSchema,
    value: {
      schema: "reviewgate.policy-dogfood-input-manifest.v1",
      since: "2026-01-01T00:00:00.000Z",
      until: "2026-01-02T00:00:00.000Z",
      entries: [],
    },
    maxBytes: 1_048_576,
  });
  if (!stored.ok) throw new Error(`fixture manifest write failed: ${stored.reason}`);
  const adjudication = "draft.json";
  writeFileSync(
    join(root, adjudication),
    JSON.stringify([
      { run_id: "run-1", iter: 1, finding_signature: "finding-1", disposition: "tp" },
    ]),
  );
  return { inputManifest: stored.ref, adjudication };
}

it("exports policy publication and attestation seams for filesystem-boundary tests", () => {
  expect(typeof __policyStatsTest.run).toBe("function");
  expect(typeof runPolicyDogfoodAttestation).toBe("function");
});

function writeRun(root: string, ts: string, runId: string): void {
  const d = new Date(ts);
  const y = String(d.getUTCFullYear());
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const dir = join(root, ".reviewgate", "audit", y, m, day);
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    schema: "reviewgate.audit.v1",
    event: "run.complete",
    ts,
    run_id: runId,
    iter: 1,
    trigger: "stop-hook",
    run_summary: {
      verdict: "PASS",
      source: "panel",
      counts: { critical: 0, warn: 0, info: 0 },
      cost_usd: 0.01,
      duration_ms: 50,
      demoted: 0,
      signatures: [],
      providers: [],
    },
  });
  writeFileSync(join(dir, "120000.jsonl"), `${line}\n`, { flag: "a" });
}

describe("runStats --since input handling", () => {
  it("rejects a non-ISO --since value instead of silently filtering everything out", async () => {
    const root = seedRepo();
    // A real run today so an honest window would include it.
    writeRun(root, new Date().toISOString(), "r1");

    // "yesterday" is non-ISO; lexically it sorts after every ISO ts (starts
    // with 'y' > '2'), so the old code silently excluded the real run and
    // returned "no review history yet". A correct stats command must surface
    // the bad input as an error rather than lie about an empty window.
    await expect(runStats({ repoRoot: root, since: "yesterday" })).rejects.toThrow(/since/i);
  });

  it("normalizes a parseable-but-non-ISO --since so the lexical window stays correct", async () => {
    const root = seedRepo();
    const now = new Date();
    writeRun(root, now.toISOString(), "r1");

    // A US-style date string parses via Date() yet, if forwarded raw, would
    // lexically mis-compare against ISO timestamps. After normalization the
    // run from "now" (which is >= start of an earlier day) must be counted.
    const earlier = new Date(now.getTime() - 2 * 86_400_000);
    const usStyle = `${String(earlier.getUTCMonth() + 1).padStart(2, "0")}/${String(earlier.getUTCDate()).padStart(2, "0")}/${earlier.getUTCFullYear()}`;

    const out = await runStats({ repoRoot: root, since: usStyle });
    expect(out).not.toMatch(/no review history yet/i);
  });

  it("still works for a plain ISO --since value", async () => {
    const root = seedRepo();
    const now = new Date();
    writeRun(root, now.toISOString(), "r1");
    const sinceIso = new Date(now.getTime() - 86_400_000).toISOString();
    const out = await runStats({ repoRoot: root, since: sinceIso });
    expect(out).not.toMatch(/no review history yet/i);
  });
});

it("runPolicyStats maps a failed authority assembly to exit 4 without publishing", async () => {
  const root = seedRepo();
  const out = "bench/results/policy-measurement/attempt";
  const result = await runPolicyStats({
    repoRoot: root,
    preregistration: "missing-preregistration.json",
    bench: "missing-bench.json",
    rig: "missing-rig.json",
    out,
  });
  expect(result.exitCode).toBe(4);
  expect(result.stderr).toContain("policy measurement:");
  expect(existsSync(join(root, out))).toBe(false);
});

it("publishes one complete immutable policy bundle only after successful assembly", async () => {
  const root = seedRepo();
  const out = "bench/results/policy-measurement/attempt";
  const { runtime, source, benchRef, path, preregistration } = policyRuntime(root, out);
  const sourceBefore = lstatSync(path);
  const result = await __policyStatsTest.run(
    { repoRoot: root, preregistration: source.ref, bench: benchRef, rig: "rig.json", out },
    runtime,
  );
  const published = join(root, out);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(readdirSync(join(published, "artifacts", "policy-measurement-sources"))).toHaveLength(5);
  expect(lstatSync(join(published, "result.json")).mode & 0o7777).toBe(0o600);
  expect(lstatSync(join(published, "report.md")).mode & 0o7777).toBe(0o600);
  expect(lstatSync(join(published, "complete.json")).mode & 0o7777).toBe(0o600);
  expect(__policyStatsTest.verifyPublishedPolicyBundle(published)).toBe(true);
  const copy = join(
    published,
    "artifacts",
    "policy-measurement-sources",
    `${source.sha256}-${digest(source.ref).slice(0, 16)}.bin`,
  );
  expect(lstatSync(copy).mode & 0o7777).toBe(0o600);
  expect(digest(readFileSync(copy))).toBe(source.sha256);
  expect(
    PolicyMeasurementSchema.parse(JSON.parse(readFileSync(join(published, "result.json"), "utf8")))
      .artifacts.inventory,
  ).toHaveLength(5);
  expect(lstatSync(path).ino).toBe(sourceBefore.ino);
  expect(readFileSync(path, "utf8")).toBe(canonicalJson(preregistration));
  expect(
    readdirSync(dirname(published)).filter((name) => name.startsWith(".attempt.staging-")),
  ).toEqual([]);
});

it("completes a preregistered Bench capture root and binds every named output plus byte-exact JSONL sources", async () => {
  const root = seedRepo();
  const out = "bench/results/policy-measurement/attempt";
  const published = join(root, out);
  mkdirSync(published, { recursive: true, mode: 0o700 });
  const { runtime, sources } = capturedLifecycleRuntime(root, out);

  const preregistration = sources.find((source) => source.kind === "preregistration");
  const bench = sources.find((source) => source.kind === "bench");
  const audit = sources.find((source) => source.ref.endsWith(".jsonl"));
  if (preregistration === undefined || bench === undefined || audit === undefined)
    throw new Error("incomplete lifecycle fixture");
  const result = await __policyStatsTest.run(
    {
      repoRoot: root,
      preregistration: preregistration.ref,
      bench: bench.ref,
      rig: "rig.json",
      out,
    },
    runtime,
  );

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(
    readFileSync(
      join(
        published,
        "artifacts",
        "policy-measurement-sources",
        `${audit.sha256}-${digest(audit.ref).slice(0, 16)}.bin`,
      ),
      "utf8",
    ),
  ).toBe(`${JSON.stringify({ schema: "reviewgate.audit.v1", event: "run.complete" })}\n`);
  expect(
    lstatSync(
      join(
        published,
        "artifacts",
        "policy-measurement-sources",
        `${audit.sha256}-${digest(audit.ref).slice(0, 16)}.bin`,
      ),
    ).mode & 0o7777,
  ).toBe(0o600);
  expect(existsSync(join(published, "rig.json"))).toBe(true);
  expect(existsSync(join(published, "dogfood.json"))).toBe(true);
  const marker = JSON.parse(readFileSync(join(published, "complete.json"), "utf8")) as {
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
  expect(marker.outputs.bench_bundle?.ref).toBe("bench.json");
  expect(marker.sources).toEqual(
    sources.map((source) => expect.objectContaining({ ref: source.ref, sha256: source.sha256 })),
  );
  expect(__policyStatsTest.verifyPublishedPolicyBundle(published)).toBe(true);
});

it("refuses an existing policy output without replacing its inode or bytes", async () => {
  const root = seedRepo();
  const out = "bench/results/policy-measurement/attempt";
  const published = join(root, out);
  const { runtime, source, benchRef } = policyRuntime(root, out);
  const sentinel = join(published, "complete.json");
  writeFileSync(sentinel, "do not replace", { mode: 0o600 });
  const before = lstatSync(published);
  const result = await __policyStatsTest.run(
    { repoRoot: root, preregistration: source.ref, bench: benchRef, rig: "rig.json", out },
    runtime,
  );
  expect(result.exitCode).toBe(2);
  expect(lstatSync(published).ino).toBe(before.ino);
  expect(readFileSync(sentinel, "utf8")).toBe("do not replace");
});

it("removes only its validated staging directory when publication fails before rename", async () => {
  const root = seedRepo();
  const out = "bench/results/policy-measurement/attempt";
  const { runtime, source, benchRef, path } = policyRuntime(root, out);
  const sourceBefore = lstatSync(path);
  await expect(
    __policyStatsTest.run(
      { repoRoot: root, preregistration: source.ref, bench: benchRef, rig: "rig.json", out },
      {
        ...runtime,
        beforeRename: () => {
          throw new Error("injected before rename");
        },
      },
    ),
  ).rejects.toThrow("injected before rename");
  expect(existsSync(join(root, out))).toBe(true);
  expect(lstatSync(path).ino).toBe(sourceBefore.ino);
  expect(
    readdirSync(join(root, "bench", "results", "policy-measurement")).filter((name) =>
      name.startsWith(".attempt.staging-"),
    ),
  ).toEqual([]);
});

it("never removes a stage path replaced after creation", async () => {
  const root = seedRepo();
  const out = "bench/results/policy-measurement/attempt";
  const { runtime, source, benchRef } = policyRuntime(root, out);
  let replacement = "";
  await expect(
    __policyStatsTest.run(
      { repoRoot: root, preregistration: source.ref, bench: benchRef, rig: "rig.json", out },
      {
        ...runtime,
        beforeRename: (stage) => {
          renameSync(stage, `${stage}.original`);
          mkdirSync(stage);
          replacement = join(stage, "sentinel");
          writeFileSync(replacement, "replacement survives");
          throw new Error("replace stage");
        },
      },
    ),
  ).rejects.toThrow("replace stage");
  expect(readFileSync(replacement, "utf8")).toBe("replacement survives");
});

it("refuses a concurrent stats publication lock without changing the Bench capture", async () => {
  const root = seedRepo();
  const out = "bench/results/policy-measurement/attempt";
  const published = join(root, out);
  const { runtime, source, benchRef } = policyRuntime(root, out);
  mkdirSync(join(published, ".policy-stats-publish"), { mode: 0o700 });
  const result = await __policyStatsTest.run(
    { repoRoot: root, preregistration: source.ref, bench: benchRef, rig: "rig.json", out },
    runtime,
  );
  const creator = lstatSync(published);
  expect(result.exitCode).toBe(2);
  expect(lstatSync(published).ino).toBe(creator.ino);
  expect(readFileSync(join(published, "bench.json"), "utf8")).toContain("fixture.bench");
  expect(
    readdirSync(dirname(published)).filter((name) => name.startsWith(".attempt.staging-")),
  ).toEqual([]);
});

it("never replaces a named output raced in after the publication lock", async () => {
  const root = seedRepo();
  const out = "bench/results/policy-measurement/attempt-raced-output";
  const published = join(root, out);
  const { runtime, source, benchRef } = policyRuntime(root, out);
  const result = await __policyStatsTest.run(
    { repoRoot: root, preregistration: source.ref, bench: benchRef, rig: "rig.json", out },
    {
      ...runtime,
      beforeRename: () => {
        writeFileSync(join(published, "result.json"), "creator sentinel", { mode: 0o600 });
      },
    },
  );
  expect(result.exitCode).toBe(4);
  expect(readFileSync(join(published, "result.json"), "utf8")).toBe("creator sentinel");
  expect(existsSync(join(published, "complete.json"))).toBe(false);
});

it("treats missing or tampered completion markers as non-authoritative and removes pre-marker failures", async () => {
  const root = seedRepo();
  const out = "bench/results/policy-measurement/attempt";
  const published = join(root, out);
  const { runtime, source, benchRef } = policyRuntime(root, out);
  await expect(
    __policyStatsTest.run(
      { repoRoot: root, preregistration: source.ref, bench: benchRef, rig: "rig.json", out },
      {
        ...runtime,
        beforeComplete: (candidate) => {
          expect(existsSync(join(candidate, "complete.json"))).toBe(false);
          throw new Error("injected pre-marker failure");
        },
      },
    ),
  ).rejects.toThrow("injected pre-marker failure");
  expect(existsSync(published)).toBe(true);
  expect(existsSync(join(published, "complete.json"))).toBe(false);
  expect(existsSync(join(published, "result.json"))).toBe(false);
  expect(existsSync(join(published, "report.md"))).toBe(false);
  expect(readdirSync(published).sort()).toEqual(["bench.json"]);
  expect(__policyStatsTest.verifyPublishedPolicyBundle(published)).toBe(false);
  const successOut = "bench/results/policy-measurement/attempt-success";
  const successPublished = join(root, successOut);
  const second = policyRuntime(root, successOut);
  const success = await __policyStatsTest.run(
    {
      repoRoot: root,
      preregistration: second.source.ref,
      bench: second.benchRef,
      rig: "rig.json",
      out: successOut,
    },
    second.runtime,
  );
  expect(success.exitCode).toBe(0);
  expect(__policyStatsTest.verifyPublishedPolicyBundle(successPublished)).toBe(true);
  const markerPath = join(successPublished, "complete.json");
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  marker.result.sha256 = "0".repeat(64);
  writeFileSync(markerPath, canonicalJson(marker), { mode: 0o600 });
  expect(__policyStatsTest.verifyPublishedPolicyBundle(published)).toBe(false);
  marker.result.sha256 = digest(readFileSync(join(successPublished, "result.json")));
  marker.sources = [];
  writeFileSync(markerPath, canonicalJson(marker), { mode: 0o600 });
  expect(__policyStatsTest.verifyPublishedPolicyBundle(successPublished)).toBe(false);

  const thirdOut = "bench/results/policy-measurement/attempt-output-binding";
  const thirdPublished = join(root, thirdOut);
  const third = policyRuntime(root, thirdOut);
  expect(
    (
      await __policyStatsTest.run(
        {
          repoRoot: root,
          preregistration: third.source.ref,
          bench: third.benchRef,
          rig: "rig.json",
          out: thirdOut,
        },
        third.runtime,
      )
    ).exitCode,
  ).toBe(0);
  const outputMarkerPath = join(thirdPublished, "complete.json");
  const outputMarker = JSON.parse(readFileSync(outputMarkerPath, "utf8"));
  outputMarker.outputs.rig_bundle = {
    ref: "result.json",
    sha256: digest(readFileSync(join(thirdPublished, "result.json"))),
  };
  writeFileSync(outputMarkerPath, canonicalJson(outputMarker), { mode: 0o600 });
  expect(__policyStatsTest.verifyPublishedPolicyBundle(thirdPublished)).toBe(false);
});

it("writes the full dogfood dossier before one confirmed immutable attestation", async () => {
  const root = seedRepo();
  const fixture = dogfoodFixture(root);
  const events: string[] = [];
  const result = await runPolicyDogfoodAttestation(
    {
      repoRoot: root,
      ...fixture,
      actor: "Markus",
      out: "dogfood-output",
      now: new Date("2026-08-14T12:00:00.000Z"),
    },
    {
      isTTY: true,
      writeStdout: (text) => events.push(`out:${text}`),
      writeStderr: (text) => events.push(`err:${text}`),
      async confirm(challenge) {
        events.push(`confirm:${challenge}`);
        return challenge;
      },
    },
  );
  expect(result.exitCode).toBe(0);
  expect(events[0]).toContain("Policy dogfood attestation");
  expect(events[0]).toContain('actor: "Markus"');
  expect(events[1]).toStartWith("confirm:ATTEST ");
  if (result.artifact === undefined) throw new Error("expected attestation artifact");
  const artifact = join(root, "dogfood-output", result.artifact.ref);
  expect(lstatSync(artifact).mode & 0o7777).toBe(0o600);
  expect(readdirSync(dirname(artifact))).toEqual([`${result.artifact.sha256}.json`]);
});

it("rejects non-TTY, EOF, and mismatched dogfood confirmations without artifacts", async () => {
  for (const answer of [null, "not-the-challenge"] as const) {
    const root = seedRepo();
    const fixture = dogfoodFixture(root);
    const result = await runPolicyDogfoodAttestation(
      { repoRoot: root, ...fixture, actor: "Markus", out: "dogfood-output" },
      { isTTY: true, writeStdout: () => {}, writeStderr: () => {}, confirm: async () => answer },
    );
    expect(result.exitCode).toBe(1);
    expect(existsSync(join(root, "dogfood-output"))).toBe(false);
  }
  const root = seedRepo();
  const fixture = dogfoodFixture(root);
  const result = await runPolicyDogfoodAttestation(
    { repoRoot: root, ...fixture, actor: "Markus", out: "dogfood-output" },
    {
      isTTY: false,
      writeStdout: () => {},
      writeStderr: () => {},
      confirm: async (challenge) => challenge,
    },
  );
  expect(result.exitCode).toBe(1);
  expect(existsSync(join(root, "dogfood-output"))).toBe(false);
});

it("re-preflights dogfood manifest and adjudication inputs after confirmation", async () => {
  for (const swapped of ["manifest", "adjudication"] as const) {
    const root = seedRepo();
    const fixture = dogfoodFixture(root);
    const result = await runPolicyDogfoodAttestation(
      { repoRoot: root, ...fixture, actor: "Markus", out: "dogfood-output" },
      {
        isTTY: true,
        writeStdout: () => {},
        writeStderr: () => {},
        async confirm(challenge) {
          if (swapped === "manifest") {
            const manifestPath = join(root, fixture.inputManifest);
            writeFileSync(
              manifestPath,
              canonicalJson({
                schema: "reviewgate.policy-dogfood-input-manifest.v1",
                since: "2026-01-03T00:00:00.000Z",
                until: "2026-01-04T00:00:00.000Z",
                entries: [],
              }),
              { mode: 0o600 },
            );
          } else {
            writeFileSync(
              join(root, fixture.adjudication),
              JSON.stringify([
                { run_id: "run-1", iter: 1, finding_signature: "finding-2", disposition: "fp" },
              ]),
            );
          }
          return challenge;
        },
      },
    );
    expect(result.exitCode).toBe(1);
    expect(existsSync(join(root, "dogfood-output"))).toBe(false);
  }
});

it("surfaces precision from decision.applied events end-to-end", async () => {
  const root = seedRepoWithRun();
  // write a decision.applied event into the same day partition
  const ts = new Date().toISOString();
  const d = new Date(ts);
  const dir = join(
    root,
    ".reviewgate",
    "audit",
    String(d.getUTCFullYear()),
    String(d.getUTCMonth() + 1).padStart(2, "0"),
    String(d.getUTCDate()).padStart(2, "0"),
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "120600.jsonl"),
    `${JSON.stringify({ schema: "reviewgate.audit.v1", event: "decision.applied", ts, run_id: "s1", iter: 1, trigger: "stop-hook", decision_outcome: { finding_id: "F-1", severity: "CRITICAL", bucket: "tp", providers: ["codex"] } })}\n`,
  );
  const out = await runStats({ repoRoot: root });
  expect(out).toContain("Precision");
  // precision section should show 1 real / 0 FP (overall tp=1, precision=100%)
  expect(out).toContain("1 real");
});
