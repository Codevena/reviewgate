import { beforeAll, describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalJson } from "../../src/audit/canonical.ts";
import { buildBenchConfig, policyBenchRequestIdentity } from "../../src/bench/runner.ts";
import {
  POLICY_CATALOG_VERSION,
  POLICY_PASS_IDS,
  type PolicyPassId,
} from "../../src/core/policy/catalog.ts";
import {
  POLICY_MEASUREMENT_INTERACTIONS,
  POLICY_MEASUREMENT_STATEFUL_PASS_IDS,
} from "../../src/core/policy/measurement-contract.ts";
import { BenchCaseSchema } from "../../src/schemas/bench-case.ts";
import {
  BenchPolicyProfileTraceSetSchema,
  BenchPolicyRepeatResultSchema,
  BenchResponseManifestSchema,
  BenchResultSchema,
  type CaseResult,
  PolicyBenchProfileArtifactSchema,
} from "../../src/schemas/bench-result.ts";
import { PolicyMeasurementPreregistrationSchema } from "../../src/schemas/policy-measurement-preregistration.ts";
import {
  type PolicyBenchBundle,
  PolicyBenchBundleSchema,
  type PolicyDogfoodAttestation,
  PolicyDogfoodAttestationSchema,
  type PolicyDogfoodInputManifest,
  PolicyDogfoodInputManifestSchema,
  type PolicyDogfoodSnapshot,
  type PolicyMeasurementInvalidityCode,
  PolicyMeasurementSchema,
  type PolicyRigEvidence,
  type PolicyRigScenarioManifest,
} from "../../src/schemas/policy-measurement.ts";
import { type PolicyTrace, PolicyTraceSchema } from "../../src/schemas/policy-trace.ts";
import { policyDogfoodAttestationPreflight } from "../../src/stats/policy/dogfood-attestation.ts";
import { renderPolicyMeasurement } from "../../src/stats/policy/render.ts";

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const fixtureConfigurationHashes = {
  provenance: sha256("fixture-provenance-configuration"),
  effective: sha256("fixture-effective-configuration"),
};
const binding = (directory: string, identity: string) => {
  const digest = sha256(identity);
  return { ref: `artifacts/${directory}/${digest}.json`, sha256: digest };
};

const controls: {
  artifacts: Map<string, unknown>;
  repeatResults: Map<string, unknown>;
  bundleFailure: string | null;
  traceFailure: boolean;
  rigFailure: Error | null;
  rig: PolicyRigEvidence | null;
  dogfood: PolicyDogfoodSnapshot | null;
  dogfoodFailure: Error | null;
} = {
  artifacts: new Map(),
  repeatResults: new Map(),
  bundleFailure: null,
  traceFailure: false,
  rigFailure: null,
  rig: null,
  dogfood: null,
  dogfoodFailure: null,
};

mock.module("../../src/artifacts/canonical-json.ts", () => ({
  verifyCanonicalJsonArtifact(input: { ref: string }) {
    const value = controls.repeatResults.get(input.ref) ?? controls.artifacts.get(input.ref);
    return value === undefined
      ? { ok: false as const, reason: "missing" }
      : { ok: true as const, value, bytes: Buffer.from(canonicalJson(value), "utf8") };
  },
}));
mock.module("../../src/cli/commands/bench.ts", () => ({
  policyBenchConfigurationHashes() {
    return fixtureConfigurationHashes;
  },
  policyBenchEffectiveConfiguration() {
    return buildBenchConfig({
      providers: ["codex"],
      providerModels: { codex: "fixture" },
      maxOutputTokens: 4096,
    });
  },
  verifyPolicyBenchBundleArtifacts(_root: string, bundle: PolicyBenchBundle) {
    if (controls.traceFailure) return { ok: false as const, reason: "trace mismatch" };
    if (controls.bundleFailure !== null) {
      return { ok: false as const, reason: controls.bundleFailure };
    }
    return {
      ok: true as const,
      profiles: bundle.profiles.map((profile) => ({
        id: profile.id,
        ablated_pass_ids: profile.ablated_pass_ids,
        profile: { binding: profile.artifact, value: profile.data },
        repeats: profile.data.repeats.map((authority) => {
          const repeatResult = controls.repeatResults.get(authority.result.ref) as {
            source_result: { ref: string; sha256: string };
            cases: CaseResult[];
          };
          return {
            authority,
            response_manifest: {
              binding: authority.response_manifest,
              value: controls.artifacts.get(authority.response_manifest.ref),
            },
            repeat_result: { binding: authority.result, value: repeatResult },
            source_result: {
              binding: repeatResult.source_result,
              value: controls.artifacts.get(repeatResult.source_result.ref),
            },
            trace_set: {
              binding: authority.policy_trace_set,
              value: controls.artifacts.get(authority.policy_trace_set.ref),
            },
            traces: repeatResult.cases.map((row) => ({
              binding: {
                ref: row.policy_trace?.trace_ref ?? "missing",
                sha256: row.policy_trace?.trace_sha256 ?? "missing",
              },
              value: row.policy_trace?.trace,
            })),
          };
        }),
      })),
    };
  },
  verifyBenchArtifactReference(input: { ref: string }) {
    if (controls.traceFailure) return { ok: false as const, reason: "trace mismatch" };
    const value = controls.artifacts.get(input.ref);
    return value === undefined
      ? { ok: false as const, reason: "missing trace" }
      : { ok: true as const, value, bytes: Buffer.from(canonicalJson(value), "utf8") };
  },
}));
mock.module("../../src/stats/policy/rig.ts", () => ({
  async collectPolicyRigEvidence() {
    if (controls.rigFailure !== null) throw controls.rigFailure;
    if (controls.rig === null) throw new Error("missing Rig fixture");
    return controls.rig;
  },
}));
mock.module("../../src/stats/policy/dogfood.ts", () => ({
  harvestPolicyDogfood() {
    if (controls.dogfoodFailure !== null) throw controls.dogfoodFailure;
    if (controls.dogfood === null) throw new Error("missing dogfood fixture");
    return controls.dogfood;
  },
}));

const { PolicyMeasurementAuthorityError, assemblePolicyMeasurement } = await import(
  "../../src/stats/policy/assemble.ts"
);

interface Fixture {
  root: string;
  preregRef: string;
  benchRef: string;
  rigRef: string;
  prereg: ReturnType<typeof PolicyMeasurementPreregistrationSchema.parse>;
  preregBytes: string;
  bench: PolicyBenchBundle;
  benchBytes: string;
}

function writeCanonical(root: string, ref: string, value: unknown, mode = 0o600): string {
  const text = canonicalJson(value);
  const path = join(root, ref);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return text;
}

function git(root: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8" }).trim();
}

function truth(fp: number, expectedLabelCount = 0) {
  return {
    expected_label_count: expectedLabelCount,
    findings: Array.from({ length: fp }, (_, index) => ({
      signature: `fp-${index}`,
      severity: "WARN" as const,
      outcome: "FP" as const,
      label_index: null,
      near_miss: false,
    })),
    fn_label_indexes: Array.from({ length: expectedLabelCount }, (_, index) => index),
  };
}

function trace(caseId: string) {
  const noOpportunityPasses = new Set<PolicyPassId>([
    POLICY_PASS_IDS[2],
    ...POLICY_MEASUREMENT_INTERACTIONS[1],
  ]);
  const evaluations = POLICY_PASS_IDS.map((passId, index) => ({
    pass_id: passId,
    order: (index + 1) * 10,
    result: noOpportunityPasses.has(passId) ? ("no-opportunity" as const) : ("protected" as const),
    before: "WARN" as const,
    after: "WARN" as const,
    reason_code: noOpportunityPasses.has(passId)
      ? ("ineligible-starting-state" as const)
      : ("required-backstop" as const),
    source_signatures: [`sig-${caseId}`],
    final_signature: `sig-${caseId}`,
  }));
  return { evaluations };
}

function casesFor(
  profileIndex: number,
  repeat: 1 | 2 | 3,
  corpusContent: Readonly<Record<string, string>>,
  root: string,
  corpusPath: string,
  configuration: ReturnType<typeof buildBenchConfig>,
): CaseResult[] {
  return Array.from({ length: 30 }, (_, index) => {
    const caseId = `${index < 16 ? "clean" : "seeded"}-${String((index % 16) + 1).padStart(2, "0")}`;
    const baselineFp = index < 2 ? 1 : 0;
    const fp =
      profileIndex === 1 && index >= 2 && index < 12
        ? 1
        : profileIndex === 2 && index < 2
          ? 0
          : profileIndex === 4 && index >= 2 && index < 11
            ? 1
            : baselineFp;
    const policyTrace = trace(caseId);
    const traceSha = sha256(canonicalJson(policyTrace));
    const traceRef = `artifacts/policy-traces/2026/08/12/policy/${sha256(`${profileIndex}:${repeat}:${caseId}`).slice(0, 12)}-i1-${traceSha.slice(0, 12)}.json`;
    controls.artifacts.set(traceRef, policyTrace);
    const requestIdentity = policyBenchRequestIdentity({
      benchCase: BenchCaseSchema.parse(
        JSON.parse(readFileSync(join(root, corpusPath, caseId, "case.json"), "utf8")),
      ),
      diffPatch: readFileSync(join(root, corpusPath, caseId, "diff.patch"), "utf8"),
      config: configuration,
    });
    return {
      id: caseId,
      kind: index < 16 ? "clean" : "seeded-bug",
      status: "scored",
      error: null,
      content_hash: corpusContent[`cases/${caseId}.json`] ?? "",
      repeat,
      counts: { tp: 0, fp, fn: 0, neutral: 0 },
      panel_ok: 1,
      panel_configured: 1,
      file_context: "full",
      latency_ms: 1,
      policy_truth: truth(fp, index < 16 ? 0 : 1),
      policy_trace: {
        authoritative: true,
        status: "complete",
        catalog_version: POLICY_CATALOG_VERSION,
        requested_ablations: [],
        trace: policyTrace as never,
        trace_ref: traceRef,
        trace_sha256: traceSha,
        request_identity_sha256: requestIdentity,
        effective_config_sha256: fixtureConfigurationHashes.effective,
        final_identity_sha256: sha256(`final:${repeat}:${caseId}:${fp}`),
        reason: null,
      },
    } satisfies CaseResult;
  }).sort((left, right) => (left.id < right.id ? -1 : 1));
}

function rigEvidence(manifest: PolicyRigScenarioManifest, manifestRef: string): PolicyRigEvidence {
  const scenarioManifest = { ref: manifestRef, sha256: sha256(canonicalJson(manifest)) };
  const artifacts = [
    { ...scenarioManifest, kind: "rig" as const },
    { ...binding("rig-cassettes", "closed-cassette"), kind: "cassette" as const },
    ...manifest.scenarios.flatMap((scenario) => [
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
    artifact_inventory_sha256: sha256(canonicalJson(artifacts)),
    sequences: manifest.scenarios.map((scenario) => {
      const sequenceNumber = Number(scenario.id.at(-1));
      const makeTurn = (turnIndex: number) => ({
        turn_index: turnIndex,
        opportunity: { summary: 1, evaluations: 0, stages: 0, observed: true },
        baseline: {
          truth: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 1 },
          errors: [],
          state: {
            digest: sha256(`base:${scenario.id}:${turnIndex}`),
            implicit_outcomes: 0,
            history_reads: 1,
            history_writes: 0,
          },
        },
        counterfactual: {
          truth: { blocking_fp: sequenceNumber, blocking_fn: 0, blocking_tp: 1 },
          errors: Array.from({ length: sequenceNumber }, (_, index) => ({
            kind: "blocking-fp" as const,
            identity: `fp-${index + 1}`,
          })),
          state: {
            digest: sha256(`counter:${scenario.id}:${turnIndex}`),
            implicit_outcomes: 0,
            history_reads: 1,
            history_writes: 0,
          },
        },
      });
      const turns = [makeTurn(1), makeTurn(2)];
      const history = POLICY_MEASUREMENT_INTERACTIONS[2].includes(scenario.pass_id as never)
        ? {
            pass_ids: [...POLICY_MEASUREMENT_INTERACTIONS[2]],
            opportunity_turns: 2,
            truth_effects: {
              baseline: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 2 },
              ablated: { blocking_fp: sequenceNumber * 2, blocking_fn: 0, blocking_tp: 2 },
              error_reduction: sequenceNumber * 2,
            },
            turns,
          }
        : null;
      return {
        scenario_id: scenario.id,
        pass_id: scenario.pass_id,
        authoritative: true,
        opportunity_turns: 2,
        truth_effects: {
          baseline: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 2 },
          ablated: { blocking_fp: sequenceNumber * 2, blocking_fn: 0, blocking_tp: 2 },
          error_reduction: sequenceNumber * 2,
        },
        turns,
        history_interaction: history,
        manifest: scenario.manifest,
        result: scenario.result,
        script: scenario.script,
        initial_state: scenario.initial_state,
      };
    }),
  };
}

function createFixture(): Fixture {
  controls.artifacts.clear();
  controls.repeatResults.clear();
  controls.bundleFailure = null;
  controls.traceFailure = false;
  controls.rigFailure = null;
  controls.dogfoodFailure = null;
  const root = mkdtempSync(join(tmpdir(), "rg-policy-assemble-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.test"]);
  git(root, ["config", "user.name", "Policy fixture"]);
  writeFileSync(
    join(root, ".gitignore"),
    ["artifacts/", "policy-dogfood-input/", "policy-dogfood-attestation/", ""].join("\n"),
  );
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/x.ts"), "export const x = 1;\n");

  const corpusContent: Record<string, string> = {};
  for (const [kind, count] of [
    ["clean", 16],
    ["seeded", 14],
  ] as const) {
    for (let index = 1; index <= count; index += 1) {
      const id = `${kind}-${String(index).padStart(2, "0")}`;
      const caseJson = canonicalJson({
        schema: "reviewgate.bench.case.v1",
        id,
        kind: kind === "clean" ? "clean" : "seeded-bug",
        language: "ts",
        expected:
          kind === "clean"
            ? []
            : [{ tag: "fixture", file: `src/${id}.ts`, line: 1, min_severity: "WARN" }],
        allowed: [],
        strict_region: true,
        source: "hand-written",
      });
      const diff = `diff --git a/src/${id}.ts b/src/${id}.ts\n+fixture\n`;
      writeCanonical(
        root,
        `bench/corpus/policy-measurement/${id}/case.json`,
        JSON.parse(caseJson),
        0o644,
      );
      const diffPath = join(root, `bench/corpus/policy-measurement/${id}/diff.patch`);
      writeFileSync(diffPath, diff);
      corpusContent[`cases/${id}.json`] = sha256(`${sha256(caseJson)}${sha256(diff)}`);
    }
  }

  const rigRef = "evidence/policy-rig-scenarios.json";
  const rigManifest: PolicyRigScenarioManifest = {
    schema: "reviewgate.policy-rig-scenarios.v1",
    scenarios: POLICY_MEASUREMENT_STATEFUL_PASS_IDS.flatMap((passId) =>
      [1, 2, 3].map((sequence) => ({
        id: `${passId}-${sequence}`,
        pass_id: passId,
        manifest: binding("rig-manifests", `${passId}:${sequence}:manifest`),
        result: binding("rig-results", `${passId}:${sequence}:result`),
        script: binding("rig-scripts", `${passId}:${sequence}:script`),
        initial_state: binding("rig-state", `${passId}:${sequence}:state`),
        expected_opportunity_turns: 2,
      })),
    ),
  };
  writeCanonical(root, rigRef, rigManifest);
  const rigSha = sha256(canonicalJson(rigManifest));
  controls.rig = rigEvidence(rigManifest, rigRef);

  const preregRef = "bench/preregistrations/policy.json";
  const benchRef = "bench/results/policy-measurement/attempt/bench.json";
  const dogfoodInput = binding("policy-dogfood-input", "dogfood-input");
  const dogfoodAttestation = binding("policy-dogfood-attestation", "dogfood-attestation");
  const prereg = PolicyMeasurementPreregistrationSchema.parse({
    schema: "reviewgate.policy-measurement.preregistration.v1",
    registered_at: "2026-08-12T09:00:00.000Z",
    release: "fixture",
    attempt: "attempt",
    source: {
      ref: "registered-source",
      runner: "dist/reviewgate",
      require_exact_clean_head_containing_this_file: true,
      require_compiled_runner_sha256: true,
    },
    catalog_version: POLICY_CATALOG_VERSION,
    pass_ids: [...POLICY_PASS_IDS],
    corpus: {
      path: "bench/corpus/policy-measurement",
      unique_cases: 30,
      clean: 16,
      seeded_bug: 14,
      repeats: 3,
      manifest_sha256: sha256(JSON.stringify(corpusContent)),
      content_sha256: corpusContent,
    },
    roster: {
      reviewers: [
        { provider: "codex", model: "fixture", persona: "security", openrouter_provider: null },
      ],
      critic: null,
      substitution_allowed: false,
    },
    execution: { reviewer_max_attempts: 1, critic_max_attempts: 1, max_output_tokens: 4096 },
    profiles: {
      singleton: POLICY_PASS_IDS.map((passId) => [passId]),
      interactions: POLICY_MEASUREMENT_INTERACTIONS.map((group) => [...group]),
    },
    stateful: {
      manifest_ref: rigRef,
      manifest_sha256: rigSha,
      min_sequences_per_pass: 3,
      min_opportunity_turns: 2,
    },
    dogfood: {
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-12T09:00:00.000Z",
      input_manifest_ref: dogfoodInput.ref,
      input_manifest_sha256: dogfoodInput.sha256,
      attestation_ref: dogfoodAttestation.ref,
      attestation_sha256: dogfoodAttestation.sha256,
      min_dispositions: 5,
      min_runs: 3,
    },
    analysis: {
      stateless_min_cases: 8,
      stateless_min_signatures: 15,
      bootstrap_resamples: 10_000,
      seed: 7,
      primary: "ground_truth_error",
      interval: "percentile-bootstrap-95",
      correction: { singleton: "holm-18", interaction: "holm-4" },
      candidate_rules: "safety-first-two-phase-v1",
      vetoes: ["unique-prevented-fp", "unique-preserved-tp", "required-backstop"],
    },
    hard_gates: {
      maximum_provider_calls: 1000,
      maximum_failed_fraction: 0,
      reviewer_coverage: 1,
      eligible_critic_coverage: 1,
      immutable_artifacts: true,
      no_variant_provider_calls: true,
    },
    outputs: {
      attempt_dir: "bench/results/policy-measurement/attempt",
      bench_bundle: benchRef,
      rig_bundle: "bench/results/policy-measurement/attempt/rig.json",
      dogfood_snapshot: "bench/results/policy-measurement/attempt/dogfood.json",
      result_json: "bench/results/policy-measurement/attempt/result.json",
      report_md: "bench/results/policy-measurement/attempt/report.md",
    },
    commands: {
      bench: ["dist/reviewgate", "bench", "policy"],
      stats: ["dist/reviewgate", "stats", "policy"],
    },
    rerun_policy: {
      failed_attempts_are_preserved: true,
      overwrite_allowed: false,
      favorable_repeat_selection_allowed: false,
    },
  });
  const preregBytes = writeCanonical(root, preregRef, prereg, 0o644);
  git(root, ["add", ".gitignore", "src/x.ts", "bench/corpus", preregRef]);
  git(root, ["commit", "-qm", "fixture"]);
  git(root, ["tag", "registered-source"]);
  if (controls.rig !== null) {
    (controls.rig as { source_commit: string }).source_commit = git(root, ["rev-parse", "HEAD"]);
  }

  const responseBindings = [1, 2, 3].map((repeat) => binding("responses", `response:${repeat}`));
  const fixturePolicyConfiguration = buildBenchConfig({
    providers: ["codex"],
    providerModels: { codex: "fixture" },
    maxOutputTokens: prereg.execution.max_output_tokens,
  });
  const traceSetBindings = [1, 2, 3].map((repeat) =>
    binding("policy-trace-sets", `trace-set:${repeat}`),
  );
  const schedule = [
    [] as PolicyPassId[],
    ...POLICY_PASS_IDS.map((passId) => [passId]),
    ...POLICY_MEASUREMENT_INTERACTIONS.map((group) => [...group]),
  ];
  const profiles = schedule.map((ablatedPassIds, profileIndex) => {
    const id =
      profileIndex === 0
        ? "baseline"
        : profileIndex <= POLICY_PASS_IDS.length
          ? `single:${POLICY_PASS_IDS[profileIndex - 1]}`
          : `interaction:${profileIndex - POLICY_PASS_IDS.length}`;
    const repeats = ([1, 2, 3] as const).map((repeat) => {
      const rows = casesFor(
        profileIndex,
        repeat,
        corpusContent,
        root,
        prereg.corpus.path,
        fixturePolicyConfiguration,
      );
      const result = binding("policy-repeat-results", `result:${id}:${repeat}`);
      const responseManifest = responseBindings[repeat - 1];
      const traceSet = traceSetBindings[repeat - 1];
      if (responseManifest === undefined || traceSet === undefined) {
        throw new Error(`missing repeat bindings for ${repeat}`);
      }
      const sourceResult = binding("results", `source:${id}:${repeat}`);
      controls.repeatResults.set(result.ref, {
        schema: "reviewgate.bench.policy-repeat-result.v1",
        profile_id: id,
        repeat,
        source_result: sourceResult,
        cases: rows,
      });
      controls.artifacts.set(sourceResult.ref, {
        provenance: {
          reviewgate_version: prereg.release,
          corpus_commit: git(root, ["rev-parse", "HEAD"]),
          corpus_dirty: false,
          repeat: prereg.corpus.repeats,
          case_count: { seeded: prereg.corpus.seeded_bug, clean: prereg.corpus.clean },
          case_run_count: {
            seeded: prereg.corpus.seeded_bug * prereg.corpus.repeats,
            clean: prereg.corpus.clean * prereg.corpus.repeats,
            total: prereg.corpus.unique_cases * prereg.corpus.repeats,
          },
          providers: prereg.roster.reviewers.map((reviewer) => ({
            id: reviewer.provider,
            cli_version: "fixture",
            model: reviewer.model,
            persona: reviewer.persona,
          })),
          config_hash: fixtureConfigurationHashes.provenance,
          phases: {
            critic: false,
            reputation: false,
            fp_ledger: false,
            confidence_floor: null,
            scope_to_diff: false,
            ablations: ablatedPassIds,
          },
          critic: null,
          integrity: {
            source_commit: git(root, ["rev-parse", "HEAD"]),
            repository_dirty: false,
            runner_sha256: "d".repeat(64),
            runner_kind: "compiled",
            preregistration_sha256: sha256(preregBytes),
            authoritative_requested: true,
            max_provider_calls: prereg.hard_gates.maximum_provider_calls,
            provider_calls_used: 1,
            max_output_tokens: prereg.execution.max_output_tokens,
            reviewer_max_attempts: prereg.execution.reviewer_max_attempts,
          },
        },
      });
      return {
        repeat,
        authoritative: true as const,
        fully_consumed: true as const,
        response_manifest: responseManifest,
        result,
        policy_trace_set: traceSet,
        ordered_response_sha256: [sha256(`ordered:${repeat}`)],
        requested_passes: ablatedPassIds.map((passId) => ({
          pass_id: passId,
          ran_cases: 30,
          opportunities: 30,
        })),
        cases: rows.map((row) => ({
          case_id: row.id,
          repeat,
          content_sha256: row.content_hash,
          policy_truth_sha256: sha256(canonicalJson(row.policy_truth)),
        })),
      };
    });
    const data = {
      schema: "reviewgate.policy-bench-profile.v1" as const,
      profile_id: id,
      ablated_pass_ids: ablatedPassIds,
      repeats,
    };
    const digest = sha256(canonicalJson(data));
    return {
      id,
      ablated_pass_ids: ablatedPassIds,
      artifact: { ref: `artifacts/policy-profiles/${digest}.json`, sha256: digest },
      data,
    };
  });
  const bench: PolicyBenchBundle = {
    schema: "reviewgate.policy-bench-bundle.v1",
    preregistration: { ref: preregRef, sha256: sha256(preregBytes) },
    profiles,
  };
  const benchBytes = writeCanonical(root, benchRef, bench);
  controls.artifacts.set(dogfoodInput.ref, {
    schema: "reviewgate.policy-dogfood-input-manifest.v1",
    since: prereg.dogfood.since,
    until: prereg.dogfood.until,
    entries: [],
  });
  controls.artifacts.set(dogfoodAttestation.ref, {
    schema: "reviewgate.policy-dogfood-attestation.v1",
    actor: "fixture",
    attested_at: prereg.dogfood.until,
    challenge_sha256: sha256("challenge"),
    input_manifest_sha256: dogfoodInput.sha256,
    rows: [],
  });
  controls.dogfood = {
    schema: "reviewgate.policy-dogfood-snapshot.v1",
    input_manifest: dogfoodInput,
    attestation: dogfoodAttestation,
    labels: [
      ...Array.from({ length: 5 }, (_, index) => ({
        pass_id: POLICY_PASS_IDS[3],
        run_id: `dogfood-${(index % 3) + 1}`,
        iter: 1,
        finding_signature: `dogfood-preserved-${index + 1}`,
        disposition: "tp" as const,
        evaluation_result: "protected" as const,
        before: "WARN" as const,
        after: "WARN" as const,
        protected_by: "claimed-fixed-pin" as const,
        effect: "preserved" as const,
        source_signatures: [`dogfood-preserved-${index + 1}`],
      })),
      {
        pass_id: POLICY_PASS_IDS[1],
        run_id: "dogfood-harm",
        iter: 1,
        finding_signature: "dogfood-suppressed",
        disposition: "tp",
        evaluation_result: "applied",
        before: "WARN",
        after: "INFO",
        effect: "suppressed",
        source_signatures: ["dogfood-suppressed"],
      },
    ],
    exclusions: {},
  };
  return { root, preregRef, benchRef, rigRef, prereg, preregBytes, bench, benchBytes };
}

function expectAuthority(
  code: PolicyMeasurementInvalidityCode,
  promise: Promise<unknown>,
): Promise<void> {
  return promise.then(
    () => {
      throw new Error(`expected ${code}`);
    },
    (error: unknown) => {
      expect(error).toBeInstanceOf(PolicyMeasurementAuthorityError);
      expect((error as InstanceType<typeof PolicyMeasurementAuthorityError>).code).toBe(code);
      expect((error as InstanceType<typeof PolicyMeasurementAuthorityError>).exitCode).toBe(4);
    },
  );
}

function rebindMockSourceHead(root: string): void {
  const head = git(root, ["rev-parse", "HEAD"]);
  if (controls.rig !== null) {
    (controls.rig as { source_commit: string }).source_commit = head;
  }
  for (const value of controls.artifacts.values()) {
    const provenance = (value as { provenance?: Record<string, unknown> }).provenance;
    const integrity = provenance?.integrity as Record<string, unknown> | undefined;
    if (provenance !== undefined && integrity !== undefined) {
      provenance.corpus_commit = head;
      integrity.source_commit = head;
    }
  }
}

function writeContentAddressedArtifact(
  root: string,
  directory: string,
  value: unknown,
): { ref: string; sha256: string } {
  const text = canonicalJson(value);
  const digest = sha256(text);
  const ref = `artifacts/${directory}/${digest}.json`;
  writeCanonical(root, ref, value);
  return { ref, sha256: digest };
}

function emptyMetric(den = 0) {
  return den === 0
    ? { num: 0, den: 0, value: null, ci_lo: null, ci_hi: null }
    : { num: 0, den, value: 0, ci_lo: 0, ci_hi: 0 };
}

function fullMetric(den: number) {
  return { num: den, den, value: 1, ci_lo: 1, ci_hi: 1 };
}

function emptyAuthoritativeTrace(
  profileIndex: number,
  repeat: 1 | 2 | 3,
  ablatedPassIds: readonly PolicyPassId[],
  caseId: string,
  rawResponseSha256: readonly string[],
): PolicyTrace {
  const orderedAblations = POLICY_PASS_IDS.filter((passId) => ablatedPassIds.includes(passId));
  return PolicyTraceSchema.parse({
    schema: "reviewgate.policy-trace.v1",
    catalog_version: POLICY_CATALOG_VERSION,
    run_id: `real-profile-${profileIndex}-repeat-${repeat}-${caseId}`,
    iter: 1,
    ablated: orderedAblations,
    raw_response_sha256: [...rawResponseSha256],
    passes: POLICY_PASS_IDS.map((passId) => ({
      pass_id: passId,
      status: "ran",
      considered: 0,
      opportunities: 0,
      would_apply: 0,
      applied: 0,
      protected: 0,
      blocking_removed: 0,
      blocking_preserved: 0,
      dropped: 0,
    })),
    evaluations: [],
    stages: [
      {
        stage_id: "verdict.compute",
        order: 190,
        reason_code: "no-blocking-findings",
        input_signatures: [],
        verdict: "PASS",
      },
    ],
    final: {
      verdict: "PASS",
      counts: { critical: 0, warn: 0, info: 0 },
      finding_signatures: [],
      finding_severities: [],
    },
  });
}

function realFixtureConfiguration(
  prereg: ReturnType<typeof PolicyMeasurementPreregistrationSchema.parse>,
): ReturnType<typeof buildBenchConfig> {
  return buildBenchConfig({
    providers: ["codex"],
    suppressors: {},
    providerModels: { codex: prereg.roster.reviewers[0]?.model ?? "fixture" },
    maxOutputTokens: prereg.execution.max_output_tokens,
  });
}

function realFixtureConfigurationHashes(
  prereg: ReturnType<typeof PolicyMeasurementPreregistrationSchema.parse>,
): { provenance: string; effective: string } {
  const config = realFixtureConfiguration(prereg);
  return {
    provenance: sha256(JSON.stringify(config)),
    effective: sha256(canonicalJson(config)),
  };
}

interface RealBenchFixture {
  fixture: Fixture;
  prereg: ReturnType<typeof PolicyMeasurementPreregistrationSchema.parse>;
  rig: PolicyRigEvidence;
  firstProfilePath: string;
}

interface RealBenchFixtureOptions {
  requestIdentity?: "derived" | "self-declared";
  responseClosure?: "closed" | "shared" | "reordered" | "reused" | "partial" | "missing-digest";
  nestedBenchBundle?: boolean;
}

function realFixtureRawResponse(repeat: 1 | 2 | 3, caseId: string): string {
  return sha256(`real-raw-response:${repeat}:${caseId}`);
}

function realFixtureRawResponses(input: {
  closure: NonNullable<RealBenchFixtureOptions["responseClosure"]>;
  repeat: 1 | 2 | 3;
  caseId: string;
}): string[] {
  if (input.closure === "reused" && input.caseId === "clean-02") {
    return [realFixtureRawResponse(input.repeat, "clean-01")];
  }
  const raw = [realFixtureRawResponse(input.repeat, input.caseId)];
  return input.closure === "shared" || input.closure === "reused" || input.caseId !== "clean-01"
    ? raw
    : [...raw, sha256(`real-raw-response:${input.repeat}:${input.caseId}:second`)];
}

/** Materialize the complete real canonical Bench stack; only the expensive Rig replay is stubbed. */
function materializeRealBenchFixture(options: RealBenchFixtureOptions = {}): RealBenchFixture {
  const requestIdentity = options.requestIdentity ?? "derived";
  const responseClosure = options.responseClosure ?? "closed";
  const fixture = createFixture();
  if (options.nestedBenchBundle) {
    const benchRef = "bench/results/policy-measurement/attempt/capture/bench.json";
    rmSync(join(fixture.root, fixture.benchRef));
    fixture.benchRef = benchRef;
    fixture.prereg = PolicyMeasurementPreregistrationSchema.parse({
      ...fixture.prereg,
      outputs: { ...fixture.prereg.outputs, bench_bundle: benchRef },
    });
  }
  const dogfoodManifest = PolicyDogfoodInputManifestSchema.parse({
    schema: "reviewgate.policy-dogfood-input-manifest.v1",
    since: fixture.prereg.dogfood.since,
    until: fixture.prereg.dogfood.until,
    entries: [],
  });
  const manifestBinding = writeContentAddressedArtifact(
    fixture.root,
    "policy-dogfood-input",
    dogfoodManifest,
  );
  const attestationRows = [
    { run_id: "unavailable-real-stack-run", iter: 1, finding_signature: "sig", disposition: "tp" },
  ] as const;
  const preflight = policyDogfoodAttestationPreflight({
    manifest: dogfoodManifest,
    actor: "fixture",
    rows: attestationRows,
  });
  const dogfoodAttestation = PolicyDogfoodAttestationSchema.parse({
    schema: "reviewgate.policy-dogfood-attestation.v1",
    actor: "fixture",
    attested_at: fixture.prereg.dogfood.until,
    challenge_sha256: preflight.candidateSha256,
    input_manifest_sha256: manifestBinding.sha256,
    rows: attestationRows,
  });
  const attestationBinding = writeContentAddressedArtifact(
    fixture.root,
    "policy-dogfood-attestation",
    dogfoodAttestation,
  );
  const prereg = PolicyMeasurementPreregistrationSchema.parse({
    ...fixture.prereg,
    dogfood: {
      ...fixture.prereg.dogfood,
      input_manifest_ref: manifestBinding.ref,
      input_manifest_sha256: manifestBinding.sha256,
      attestation_ref: attestationBinding.ref,
      attestation_sha256: attestationBinding.sha256,
    },
  });
  const preregBytes = writeCanonical(fixture.root, fixture.preregRef, prereg, 0o644);
  git(fixture.root, ["add", fixture.preregRef]);
  git(fixture.root, ["commit", "-qm", "bind real artifact fixture"]);
  git(fixture.root, ["tag", "-f", "registered-source"]);
  const sourceHead = git(fixture.root, ["rev-parse", "HEAD"]);
  const configurationHashes = realFixtureConfigurationHashes(prereg);
  const configuration = realFixtureConfiguration(prereg);
  const attemptRoot = join(fixture.root, prereg.outputs.attempt_dir);
  const caseIds = Object.keys(prereg.corpus.content_sha256)
    .map((ref) => ref.slice("cases/".length, -".json".length))
    .sort();
  const manifestCaseIds =
    responseClosure === "shared"
      ? caseIds.slice(0, 1)
      : responseClosure === "partial"
        ? [...caseIds, "rogue-extra"]
        : caseIds;
  const responseArtifacts = ([1, 2, 3] as const).map((repeat) => {
    const responseEntries =
      responseClosure === "shared"
        ? [
            {
              provider: "codex",
              kind: "review" as const,
              repeat,
              case_id: caseIds[0],
              request_sha256: sha256(`real-request:${repeat}`),
              response_sha256: sha256(`real-response:${repeat}`),
              raw_response_sha256: sha256(`real-response:${repeat}`),
              outcome: "return" as const,
            },
          ]
        : manifestCaseIds.flatMap((caseId) => {
            const rawResponses = realFixtureRawResponses({
              closure: responseClosure,
              repeat,
              caseId,
            });
            const orderedRawResponses =
              responseClosure === "reordered" && caseId === caseIds[0]
                ? [...rawResponses].reverse()
                : rawResponses;
            return orderedRawResponses.map((raw_response_sha256, responseIndex) => ({
              provider: "codex",
              kind: "review" as const,
              repeat,
              case_id: caseId,
              request_sha256: sha256(`real-request:${repeat}:${caseId}:${responseIndex}`),
              response_sha256: sha256(`real-response:${repeat}:${caseId}:${responseIndex}`),
              ...(responseClosure === "missing-digest" &&
              caseId === caseIds[0] &&
              responseIndex === 0
                ? {}
                : { raw_response_sha256 }),
              outcome: "return" as const,
            }));
          });
    const response = BenchResponseManifestSchema.parse({
      schema: "reviewgate.bench.provider-response-hashes.v2",
      repeat,
      preflights: [],
      entries: responseEntries.map((entry, ordinal) => ({ ...entry, ordinal })),
    });
    return {
      binding: writeContentAddressedArtifact(attemptRoot, "responses", response),
      value: response,
    };
  });
  const records = fixture.bench.profiles.map((scheduled, profileIndex) => {
    const repeatRows = ([1, 2, 3] as const).map((repeat) => {
      const cases = caseIds.map((caseId) => {
        const rawResponseSha256 =
          responseClosure === "shared"
            ? [sha256(`real-response:${repeat}`)]
            : realFixtureRawResponses({ closure: responseClosure, repeat, caseId });
        const traceRawResponseSha256 =
          responseClosure === "missing-digest" && caseId === caseIds[0]
            ? rawResponseSha256.slice(1)
            : rawResponseSha256;
        const trace = emptyAuthoritativeTrace(
          profileIndex,
          repeat,
          scheduled.ablated_pass_ids,
          caseId,
          traceRawResponseSha256,
        );
        const traceText = canonicalJson(trace);
        const traceSha256 = sha256(traceText);
        const traceRef = `artifacts/policy-traces/2026/08/12/policy/${sha256(trace.run_id).slice(0, 12)}-i1-${traceSha256.slice(0, 12)}.json`;
        writeCanonical(attemptRoot, traceRef, trace);
        const finalIdentity = sha256(canonicalJson(trace.final));
        const benchCase = BenchCaseSchema.parse(
          JSON.parse(
            readFileSync(join(fixture.root, prereg.corpus.path, caseId, "case.json"), "utf8"),
          ),
        );
        const derivedRequestIdentity = policyBenchRequestIdentity({
          benchCase,
          diffPatch: readFileSync(
            join(fixture.root, prereg.corpus.path, caseId, "diff.patch"),
            "utf8",
          ),
          config: configuration,
        });
        return {
          id: caseId,
          kind: caseId.startsWith("clean-") ? ("clean" as const) : ("seeded-bug" as const),
          status: "scored" as const,
          content_hash: prereg.corpus.content_sha256[`cases/${caseId}.json`] ?? "",
          counts: { tp: 0, fp: 0, fn: 0, neutral: 0 },
          panel_ok: 1,
          panel_configured: 1,
          file_context: "full" as const,
          repeat,
          latency_ms: 1,
          error: null,
          policy_trace: {
            authoritative: true,
            status: "complete" as const,
            catalog_version: POLICY_CATALOG_VERSION,
            requested_ablations: [...trace.ablated],
            trace,
            trace_ref: traceRef,
            trace_sha256: traceSha256,
            request_identity_sha256:
              requestIdentity === "derived"
                ? derivedRequestIdentity
                : sha256(`real-case-request:${repeat}:${caseId}`),
            effective_config_sha256: configurationHashes.effective,
            final_identity_sha256: finalIdentity,
            reason: null,
          },
          policy_truth: truth(0, caseId.startsWith("seeded-") ? 1 : 0),
        };
      });
      return { repeat, cases };
    });
    const sourceResult = BenchResultSchema.parse({
      schema: "reviewgate.bench.result.v1",
      provenance: {
        reviewgate_version: prereg.release,
        corpus_commit: sourceHead,
        corpus_dirty: false,
        providers: prereg.roster.reviewers.map((reviewer) => ({
          id: reviewer.provider,
          cli_version: "fixture",
          model: reviewer.model,
          persona: reviewer.persona,
        })),
        config_hash: configurationHashes.provenance,
        window: 0,
        repeat: 3,
        include_advisory: false,
        temperature: null,
        stores: "per-case-fresh",
        cache: "cold",
        file_context: "full",
        phases: {
          critic: false,
          reputation: false,
          fp_ledger: false,
          confidence_floor: null,
          scope_to_diff: false,
          ablations: [...scheduled.ablated_pass_ids],
        },
        host_os: "fixture",
        timestamp: prereg.registered_at,
        case_count: { seeded: 14, clean: 16 },
        case_run_count: { seeded: 42, clean: 48, total: 90 },
        critic: null,
        integrity: {
          source_commit: sourceHead,
          repository_dirty: false,
          runner_sha256: "d".repeat(64),
          runner_kind: "compiled",
          preregistration_sha256: sha256(preregBytes),
          authoritative_requested: true,
          max_provider_calls: prereg.hard_gates.maximum_provider_calls,
          provider_calls_used: 90,
          max_output_tokens: prereg.execution.max_output_tokens,
          reviewer_max_attempts: prereg.execution.reviewer_max_attempts,
        },
      },
      cases: repeatRows.flatMap((row) => row.cases),
      providers: [
        {
          provider: "codex",
          coverage: fullMetric(90),
          precision: emptyMetric(),
          recall: emptyMetric(),
          authoritative: true,
        },
      ],
      cost: [
        {
          provider: "codex",
          calls: 90,
          cache_hits: 0,
          tokens_in: null,
          tokens_out: null,
          billed_usd: null,
          oauth_quota_calls: 90,
        },
      ],
      critic: null,
      aggregate: {
        precision: emptyMetric(),
        recall: emptyMetric(),
        clean_fp_rate: emptyMetric(48),
      },
      verdict: { authoritative: true, gate_exit_code: 0, reasons: [] },
    });
    const sourceBinding = writeContentAddressedArtifact(attemptRoot, "results", sourceResult);
    const repeats = repeatRows.map((row) => {
      const repeatResult = BenchPolicyRepeatResultSchema.parse({
        schema: "reviewgate.bench.policy-repeat-result.v1",
        profile_id: scheduled.id,
        repeat: row.repeat,
        source_result: sourceBinding,
        cases: row.cases,
      });
      const resultBinding = writeContentAddressedArtifact(
        attemptRoot,
        "policy-repeat-results",
        repeatResult,
      );
      const traces = row.cases.map((caseRow) => ({
        case_id: caseRow.id,
        repeat: row.repeat,
        trace_ref: caseRow.policy_trace.trace_ref,
        trace_sha256: caseRow.policy_trace.trace_sha256,
        effective_config_sha256: caseRow.policy_trace.effective_config_sha256,
        request_identity_sha256: caseRow.policy_trace.request_identity_sha256,
        final_identity_sha256: caseRow.policy_trace.final_identity_sha256,
        raw_response_sha256: [...caseRow.policy_trace.trace.raw_response_sha256],
      }));
      return { row, resultBinding, traces };
    });
    return { scheduled, repeats };
  });
  const traceSetBindings = ([1, 2, 3] as const).map((repeat) => {
    const response = responseArtifacts[repeat - 1];
    if (response === undefined) throw new Error(`missing response ${repeat}`);
    const traceSet = BenchPolicyProfileTraceSetSchema.parse({
      schema: "reviewgate.bench.policy-profile-trace-set.v1",
      catalog_version: POLICY_CATALOG_VERSION,
      repeat,
      response_manifest: response.binding,
      runs: records.map((record) => {
        const recordRepeat = record.repeats[repeat - 1];
        if (recordRepeat === undefined) throw new Error(`missing record repeat ${repeat}`);
        return {
          profile_id: record.scheduled.id,
          ablated_pass_ids: [...record.scheduled.ablated_pass_ids],
          result: recordRepeat.resultBinding,
          traces: recordRepeat.traces,
        };
      }),
    });
    return writeContentAddressedArtifact(attemptRoot, "policy-trace-sets", traceSet);
  });
  const profiles = records.map((record) => {
    const data = PolicyBenchProfileArtifactSchema.parse({
      schema: "reviewgate.policy-bench-profile.v1",
      profile_id: record.scheduled.id,
      ablated_pass_ids: [...record.scheduled.ablated_pass_ids],
      repeats: record.repeats.map((recordRepeat) => {
        const repeat = recordRepeat.row.repeat;
        const response = responseArtifacts[repeat - 1];
        const traceSet = traceSetBindings[repeat - 1];
        if (response === undefined || traceSet === undefined) {
          throw new Error(`missing profile authority ${repeat}`);
        }
        return {
          repeat,
          authoritative: true,
          fully_consumed: true,
          response_manifest: response.binding,
          result: recordRepeat.resultBinding,
          policy_trace_set: traceSet,
          ordered_response_sha256: response.value.entries.map((entry) => entry.response_sha256),
          requested_passes: record.scheduled.ablated_pass_ids.map((passId) => ({
            pass_id: passId,
            ran_cases: 30,
            opportunities: 0,
          })),
          cases: recordRepeat.row.cases.map((caseRow) => ({
            case_id: caseRow.id,
            repeat,
            content_sha256: caseRow.content_hash,
            policy_truth_sha256: sha256(canonicalJson(caseRow.policy_truth)),
            request_identity_sha256: caseRow.policy_trace.request_identity_sha256,
            response_span: (() => {
              const firstOrdinal = response.value.entries.findIndex(
                (entry) => entry.case_id === caseRow.id,
              );
              let entryCount = 0;
              while (response.value.entries[firstOrdinal + entryCount]?.case_id === caseRow.id) {
                entryCount += 1;
              }
              return {
                first_ordinal:
                  responseClosure === "shared"
                    ? caseIds.indexOf(caseRow.id)
                    : responseClosure === "reused" && caseRow.id === caseIds[1]
                      ? 0
                      : firstOrdinal,
                entry_count: responseClosure === "shared" ? 1 : entryCount,
              };
            })(),
          })),
        };
      }),
    });
    const artifact = writeContentAddressedArtifact(attemptRoot, "policy-profiles", data);
    return {
      id: record.scheduled.id,
      ablated_pass_ids: [...record.scheduled.ablated_pass_ids],
      artifact,
      data,
    };
  });
  const bench = PolicyBenchBundleSchema.parse({
    schema: "reviewgate.policy-bench-bundle.v1",
    preregistration: { ref: fixture.preregRef, sha256: sha256(preregBytes) },
    profiles,
  });
  writeCanonical(fixture.root, fixture.benchRef, bench);
  const rig = rigEvidence(
    JSON.parse(readFileSync(join(fixture.root, fixture.rigRef), "utf8")),
    fixture.rigRef,
  );
  (rig as { source_commit: string }).source_commit = sourceHead;
  const firstProfile = profiles[0];
  if (firstProfile === undefined) throw new Error("missing real baseline profile");
  return {
    fixture,
    prereg,
    rig,
    firstProfilePath: join(attemptRoot, firstProfile.artifact.ref),
  };
}

function runRealAssembler(
  real: RealBenchFixture,
  overrides: Partial<Pick<Fixture, "preregRef" | "benchRef" | "rigRef">> = {},
): { exitCode: number; stdout: string; stderr: string } {
  const scratch = mkdtempSync(join(tmpdir(), "rg-policy-real-runner-"));
  const payloadPath = join(scratch, "payload.json");
  const runnerPath = join(scratch, "runner.ts");
  const rigModule = new URL("../../src/stats/policy/rig.ts", import.meta.url).href;
  const assembleModule = new URL("../../src/stats/policy/assemble.ts", import.meta.url).href;
  writeFileSync(
    payloadPath,
    JSON.stringify({
      rig: real.rig,
      input: {
        repoRoot: real.fixture.root,
        preregistrationPath: overrides.preregRef ?? real.fixture.preregRef,
        benchBundlePath: overrides.benchRef ?? real.fixture.benchRef,
        rigManifestPath: overrides.rigRef ?? real.fixture.rigRef,
      },
    }),
  );
  writeFileSync(
    runnerPath,
    [
      'import { mock } from "bun:test";',
      "const payload = JSON.parse(await Bun.file(process.argv[2]).text());",
      `mock.module(${JSON.stringify(rigModule)}, () => ({ collectPolicyRigEvidence: async () => payload.rig }));`,
      `const { assemblePolicyMeasurement } = await import(${JSON.stringify(assembleModule)});`,
      "try {",
      "  const assembled = await assemblePolicyMeasurement(payload.input);",
      "  console.log(JSON.stringify({ ok: true, passes: assembled.result.passes.length, inventory: assembled.result.artifacts.inventory.length }));",
      "} catch (error) {",
      "  console.error(JSON.stringify({ ok: false, name: error?.name, code: error?.code, message: error?.message }));",
      "  process.exit(4);",
      "}",
    ].join("\n"),
  );
  const run = Bun.spawnSync({ cmd: [process.execPath, runnerPath, payloadPath] });
  return {
    exitCode: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
  };
}

function runRealBundleVerifier(input: {
  root: string;
  bundle: PolicyBenchBundle;
}): { exitCode: number; stdout: string; stderr: string } {
  const scratch = mkdtempSync(join(tmpdir(), "rg-policy-bundle-verifier-"));
  const payloadPath = join(scratch, "payload.json");
  const runnerPath = join(scratch, "runner.ts");
  const benchModule = new URL("../../src/cli/commands/bench.ts", import.meta.url).href;
  writeFileSync(payloadPath, JSON.stringify(input));
  writeFileSync(
    runnerPath,
    [
      "const payload = JSON.parse(await Bun.file(process.argv[2]).text());",
      `const { verifyPolicyBenchBundleArtifacts } = await import(${JSON.stringify(benchModule)});`,
      "console.log(JSON.stringify(verifyPolicyBenchBundleArtifacts(payload.root, payload.bundle)));",
    ].join("\n"),
  );
  const run = Bun.spawnSync({ cmd: [process.execPath, runnerPath, payloadPath] });
  return {
    exitCode: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
  };
}

function realBundleWithTraceSetIdentityDrift(
  real: RealBenchFixture,
  field:
    | "effective_config_sha256"
    | "request_identity_sha256"
    | "final_identity_sha256"
    | "raw_response_sha256",
): PolicyBenchBundle {
  const attemptRoot = dirname(join(real.fixture.root, real.fixture.benchRef));
  const bundle = PolicyBenchBundleSchema.parse(
    JSON.parse(readFileSync(join(real.fixture.root, real.fixture.benchRef), "utf8")),
  );
  const firstRepeat = bundle.profiles[0]?.data.repeats[0];
  if (firstRepeat === undefined) throw new Error("missing real baseline trace-set fixture");
  const traceSet = BenchPolicyProfileTraceSetSchema.parse(
    JSON.parse(readFileSync(join(attemptRoot, firstRepeat.policy_trace_set.ref), "utf8")),
  );
  const driftedTraceSet = BenchPolicyProfileTraceSetSchema.parse({
    ...traceSet,
    runs: traceSet.runs.map((run) => ({
      ...run,
      traces: run.traces.map((trace, index) =>
        index === 0
          ? field === "raw_response_sha256"
            ? { ...trace, raw_response_sha256: ["f".repeat(64)] }
            : { ...trace, [field]: "f".repeat(64) }
          : trace,
      ),
    })),
  });
  const traceSetBinding = writeContentAddressedArtifact(
    attemptRoot,
    "policy-trace-sets",
    driftedTraceSet,
  );
  return PolicyBenchBundleSchema.parse({
    ...bundle,
    profiles: bundle.profiles.map((profile) => {
      const data = PolicyBenchProfileArtifactSchema.parse({
        ...profile.data,
        repeats: profile.data.repeats.map((repeat, index) =>
          index === 0 ? { ...repeat, policy_trace_set: traceSetBinding } : repeat,
        ),
      });
      return {
        ...profile,
        artifact: writeContentAddressedArtifact(attemptRoot, "policy-profiles", data),
        data,
      };
    }),
  });
}

describe("authoritative policy measurement pipeline", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = createFixture();
  }, 30_000);

  const assemble = () =>
    assemblePolicyMeasurement({
      repoRoot: fixture.root,
      preregistrationPath: fixture.preregRef,
      benchBundlePath: fixture.benchRef,
      rigManifestPath: fixture.rigRef,
    });

  test("assembles all 18 passes and four interactions with every candidate outcome", async () => {
    if (controls.dogfood === null) throw new Error("missing dogfood fixture");
    controls.dogfood.exclusions["post-registered-at"] = 2;
    const assembled = await assemble();
    controls.dogfood.exclusions["post-registered-at"] = 0;
    expect(assembled.result.schema).toBe("reviewgate.policy-measurement.v1");
    expect(assembled.result.passes.map((row) => row.pass_id)).toEqual([...POLICY_PASS_IDS]);
    expect(assembled.result.interactions).toHaveLength(4);
    expect(assembled.result.artifacts.authoritative).toBe(true);
    const markdown = renderPolicyMeasurement(assembled.result);
    expect(markdown).toContain("| Pass | Lane | Opportunities | Classification |");
    expect(markdown).toContain("`judgment.confidence`");
    expect(markdown).toContain("INCONCLUSIVE — insufficient-opportunities");
    expect(markdown).toContain("Raw p-value");
    expect(markdown).toContain("Adjusted p-value");
    expect(markdown).toContain("Artifact authority");
    expect(markdown).toContain("Vetoes: unique-prevented-fp");
    expect(markdown).toContain("dogfood:post-registered-at=2");
    expect(markdown).toContain("95% interval");
    expect(markdown).not.toContain("statistically significant");
    const identityFacts = assembled.result.identity_evidence.flatMap((row) => [
      ...row.ground_truth_harms,
      ...row.dogfood_dispositions,
      ...row.beneficial_effects,
    ]);
    const benefits = assembled.result.identity_evidence.flatMap((row) => row.beneficial_effects);
    expect(identityFacts.length).toBeGreaterThan(0);
    expect(benefits.some((benefit) => benefit.reproduced_by_pass_ids.length === 0)).toBe(true);
    expect(benefits.some((benefit) => benefit.reproduced_by_pass_ids.length > 0)).toBe(true);
    for (const identity of assembled.result.identity_evidence) {
      for (const fact of identity.ground_truth_harms) {
        expect(markdown).toContain(`identity=${fact.identity}`);
        expect(markdown).toContain(`evidence=${fact.evidence_ref}`);
      }
      for (const fact of identity.dogfood_dispositions) {
        expect(markdown).toContain(`identity=${fact.identity}`);
        expect(markdown).toContain(`run=${fact.run_id}`);
        expect(markdown).toContain(`effect=${fact.effect}`);
        expect(markdown).toContain(`evidence=${fact.evidence_ref}`);
      }
      for (const fact of identity.beneficial_effects) {
        expect(markdown).toContain(`identity=${fact.identity}`);
        expect(markdown).toContain(`evidence=${fact.evidence_ref}`);
        const expected = `benefit identity=${fact.identity} evidence=${fact.evidence_ref} reproduced_by=${fact.reproduced_by_pass_ids.map((passId) => `\`${passId}\``).join(",") || "none"}`;
        const lines = markdown.split("\n");
        const start = lines.indexOf(`### \`${identity.pass_id}\``);
        const dossierLine = lines
          .slice(start + 1, lines.indexOf("## Artifact inventory"))
          .find((line) =>
            line.includes(`benefit identity=${fact.identity} evidence=${fact.evidence_ref}`),
          );
        expect(dossierLine).toContain(expected);
      }
    }
    expect(new Set(assembled.result.passes.map((row) => row.classification))).toEqual(
      new Set(["retain", "harmful-candidate", "delete-candidate", "inconclusive"]),
    );
    expect(assembled.result.passes[2]?.evidence.opportunities).toMatchObject({
      cases: 0,
      signatures: 0,
    });
    expect(assembled.result.passes[2]?.evidence.truth_effects).toEqual({
      baseline: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
      ablated: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
      error_reduction: 0,
    });
    expect(assembled.result.identity_evidence[2]).toMatchObject({
      ground_truth_harms: [],
      beneficial_effects: [],
    });
    expect(assembled.result.passes[3]).toMatchObject({
      classification: "delete-candidate",
      evidence: {
        opportunities: { runs: 3 },
        exclusions: [{ lane: "dogfood", code: "post-registered-at", count: 2 }],
      },
    });
    expect(assembled.result.passes[0]).toMatchObject({
      classification: "retain",
      vetoes: ["unique-prevented-fp"],
    });
    const factLocationFacts = assembled.result.identity_evidence[0];
    const groundingFacts = assembled.result.identity_evidence[3];
    expect(
      factLocationFacts?.beneficial_effects.filter(
        (benefit) => benefit.reproduced_by_pass_ids.length === 0,
      ),
    ).toHaveLength(1);
    expect(
      groundingFacts?.beneficial_effects.every((benefit) =>
        benefit.reproduced_by_pass_ids.includes("evidence.fact-location"),
      ),
    ).toBe(true);
    expect(assembled.result.passes[3]?.evidence.unique_contributions).toHaveLength(0);
    expect(assembled.result.passes[3]?.evidence.raw_evidence_refs).toEqual(
      expect.arrayContaining([
        controls.dogfood?.input_manifest.ref,
        controls.dogfood?.attestation.ref,
      ]),
    );
    expect(assembled.result.passes[0]?.evidence.statistics).toMatchObject({
      p_value: 0.001953125,
      adjusted_p_value: 0.03515625,
    });
    expect(assembled.result.passes[0]?.evidence.raw_evidence_refs).toContain(
      `${dirname(fixture.benchRef)}/${fixture.bench.profiles[1]?.artifact.ref}`,
    );
    const firstSingletonRepeat = fixture.bench.profiles[1]?.data.repeats[0];
    const firstSingletonResult =
      firstSingletonRepeat === undefined
        ? undefined
        : (controls.repeatResults.get(firstSingletonRepeat.result.ref) as
            | { source_result: { ref: string }; cases: CaseResult[] }
            | undefined);
    expect(assembled.result.passes[0]?.evidence.raw_evidence_refs).toEqual(
      expect.arrayContaining([
        `${dirname(fixture.benchRef)}/${firstSingletonRepeat?.result.ref}`,
        `${dirname(fixture.benchRef)}/${firstSingletonResult?.source_result.ref}`,
        `${dirname(fixture.benchRef)}/${firstSingletonResult?.cases[0]?.policy_trace?.trace_ref}`,
      ]),
    );
    expect(
      assembled.result.passes.find((row) => row.pass_id === "history.fp-signature")?.evidence
        .raw_evidence_refs,
    ).toContain(binding("rig-cassettes", "closed-cassette").ref);
    expect(
      assembled.result.artifacts.inventory.some((row) =>
        row.ref.startsWith("artifacts/policy-profiles/"),
      ),
    ).toBe(false);
    expect(
      assembled.result.passes.find((row) => row.pass_id === "history.fp-signature")?.evidence
        .statistics.raw_effects,
    ).toEqual([2, 4, 6]);
    expect(assembled.result.interactions[2]?.evidence.statistics.raw_effects).toHaveLength(12);
    const historyInteractionRefs = assembled.result.interactions[2]?.evidence.raw_evidence_refs;
    const historyMemberRefs = assembled.result.passes.find(
      (row) => row.pass_id === "history.fp-signature",
    )?.evidence.raw_evidence_refs;
    const expectedHistoryInteractionRefs = (controls.rig?.artifacts ?? [])
      .map((artifact) => artifact.ref)
      .sort();
    expect(historyInteractionRefs).toEqual(expectedHistoryInteractionRefs);
    expect(
      historyMemberRefs?.filter((ref) => expectedHistoryInteractionRefs.includes(ref)),
    ).toEqual(expectedHistoryInteractionRefs);
    expect(assembled.result.interactions[1]?.evidence.opportunities).toMatchObject({
      cases: 0,
      signatures: 0,
    });
    expect(assembled.result.identity_evidence.map((row) => row.pass_id)).toEqual([
      ...POLICY_PASS_IDS,
    ]);
    expect(existsSync(join(fixture.root, fixture.prereg.outputs.result_json))).toBe(false);
    expect(existsSync(join(fixture.root, fixture.prereg.outputs.report_md))).toBe(false);
  }, 30_000);

  test("reports every applicable Bench Rig and Dogfood lane without promoting secondary authority", async () => {
    const assembled = await assemble();
    for (const pass of assembled.result.passes) {
      const stateful = POLICY_MEASUREMENT_STATEFUL_PASS_IDS.includes(pass.pass_id as never);
      expect(pass.evidence.lane_summaries.map((summary) => summary.lane)).toEqual(
        stateful ? ["stateless-bench", "stateful-rig", "dogfood"] : ["stateless-bench", "dogfood"],
      );
      for (const summary of pass.evidence.lane_summaries) {
        expect(summary.primary).toBe(summary.lane === pass.evidence.lane);
        expect(summary.descriptive).toBe(summary.lane !== pass.evidence.lane);
        expect(summary.eligible).toBe(true);
        expect(summary.authoritative).toBe(true);
        expect(Object.keys(summary.opportunities).sort()).toEqual([
          "cases",
          "runs",
          "signatures",
          "turns",
        ]);
        expect(Object.keys(summary.truth_effects).sort()).toEqual([
          "ablated",
          "baseline",
          "error_reduction",
        ]);
        expect(Object.keys(summary.trace_totals).sort()).toEqual([
          "applied",
          "no_opportunity",
          "protected",
          "would_apply",
        ]);
        expect(Object.keys(summary.statistics).sort()).toEqual([
          "adjusted_p_value",
          "interval",
          "p_value",
          "raw_effects",
        ]);
        expect(Array.isArray(summary.exclusions)).toBe(true);
        expect(Array.isArray(summary.raw_evidence_refs)).toBe(true);
      }
    }
    for (const interaction of assembled.result.interactions) {
      const stateful = interaction.pass_ids.every((passId) =>
        POLICY_MEASUREMENT_STATEFUL_PASS_IDS.includes(passId as never),
      );
      expect(interaction.primary_lane).toBe(stateful ? "stateful-rig" : "stateless-bench");
      expect(interaction.lane_summaries.map((summary) => summary.lane)).toEqual(
        stateful ? ["stateless-bench", "stateful-rig"] : ["stateless-bench"],
      );
      for (const summary of interaction.lane_summaries) {
        expect(summary.primary).toBe(summary.lane === interaction.primary_lane);
        expect(summary.descriptive).toBe(summary.lane !== interaction.primary_lane);
        expect(summary.eligible).toBe(true);
        expect(summary.authoritative).toBe(true);
        expect(Object.keys(summary.opportunities).sort()).toEqual([
          "cases",
          "runs",
          "signatures",
          "turns",
        ]);
        expect(Object.keys(summary.truth_effects).sort()).toEqual([
          "ablated",
          "baseline",
          "error_reduction",
        ]);
        expect(Object.keys(summary.trace_totals).sort()).toEqual([
          "applied",
          "no_opportunity",
          "protected",
          "would_apply",
        ]);
        expect(Object.keys(summary.statistics).sort()).toEqual([
          "adjusted_p_value",
          "interval",
          "p_value",
          "raw_effects",
        ]);
        expect(Array.isArray(summary.exclusions)).toBe(true);
        expect(Array.isArray(summary.raw_evidence_refs)).toBe(true);
      }
    }
    const stateful = assembled.result.passes.find((row) => row.pass_id === "history.fp-signature");
    if (stateful === undefined) throw new Error("missing stateful fixture pass");
    expect(stateful.evidence.lane).toBe("stateful-rig");
    const summaries = stateful.evidence.lane_summaries;
    expect(summaries.map((summary) => summary.lane)).toEqual([
      "stateless-bench",
      "stateful-rig",
      "dogfood",
    ]);
    const bench = summaries.find((summary) => summary.lane === "stateless-bench");
    expect(bench).toMatchObject({
      primary: false,
      descriptive: true,
      eligible: true,
      authoritative: true,
    });
    expect(bench?.opportunities.cases).toBeGreaterThan(0);
    expect(bench?.trace_totals.protected).toBeGreaterThan(0);
    expect(summaries.find((summary) => summary.lane === "stateful-rig")).toMatchObject({
      primary: true,
      descriptive: false,
      eligible: true,
      authoritative: true,
    });
    expect(summaries.find((summary) => summary.lane === "dogfood")).toMatchObject({
      primary: false,
      descriptive: true,
      authoritative: true,
    });

    const historyInteraction = assembled.result.interactions[2];
    if (historyInteraction === undefined) throw new Error("missing history interaction");
    expect(historyInteraction).toMatchObject({ primary_lane: "stateful-rig" });
    const interactionSummaries = historyInteraction.lane_summaries;
    expect(interactionSummaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ lane: "stateless-bench", primary: false, descriptive: true }),
        expect.objectContaining({ lane: "stateful-rig", primary: true, descriptive: false }),
      ]),
    );

    const noOpportunityDogfood = assembled.result.passes.find(
      (row) => row.pass_id === "judgment.hypothetical",
    );
    if (noOpportunityDogfood === undefined) throw new Error("missing no-opportunity pass");
    const dogfood = noOpportunityDogfood.evidence.lane_summaries;
    const dogfoodSummary = dogfood.find((summary) => summary.lane === "dogfood");
    expect(dogfoodSummary).toMatchObject({ descriptive: true, opportunities: { runs: 0 } });

    const missingDescriptiveLane = structuredClone(assembled.result);
    missingDescriptiveLane.passes[0]?.evidence.lane_summaries.pop();
    expect(PolicyMeasurementSchema.safeParse(missingDescriptiveLane).success).toBe(false);
    const markdown = renderPolicyMeasurement(assembled.result);
    expect(markdown).toContain(
      "Lane stateless-bench: primary=false; descriptive=true; eligible=true; authoritative=true",
    );
    const dogfoodRefs = [
      fixture.prereg.dogfood.input_manifest_ref,
      fixture.prereg.dogfood.attestation_ref,
    ];
    const laneLeaks: string[] = [];
    const renderedLeaks: string[] = [];
    for (const pass of assembled.result.passes) {
      const passSummaries = pass.evidence.lane_summaries;
      const passDogfood = passSummaries.find((summary) => summary.lane === "dogfood");
      const primary = passSummaries.find((summary) => summary.primary);
      if (passDogfood === undefined || primary === undefined) {
        throw new Error(`missing primary or Dogfood summary for ${pass.pass_id}`);
      }
      for (const ref of dogfoodRefs) {
        if (!passDogfood.raw_evidence_refs.includes(ref)) {
          laneLeaks.push(`Dogfood missing ${pass.pass_id}:${ref}`);
        }
        for (const summary of passSummaries) {
          if (summary.lane !== "dogfood" && summary.raw_evidence_refs.includes(ref)) {
            laneLeaks.push(`${summary.lane} owns ${pass.pass_id}:${ref}`);
          }
        }
      }
      const heading = `### \`${pass.pass_id}\``;
      const start = markdown.indexOf(heading);
      const end = markdown.indexOf("\n### ", start + heading.length);
      const dossier = markdown.slice(start, end === -1 ? undefined : end);
      const laneDossier = dossier.split("- Lane summaries: ")[1];
      const renderedPrimary = laneDossier
        ?.split(" | ")
        .find((line) => line.includes(`Lane ${primary.lane}: primary=true;`));
      if (renderedPrimary === undefined) {
        renderedLeaks.push(`missing rendered primary ${pass.pass_id}`);
        continue;
      }
      for (const ref of dogfoodRefs) {
        if (renderedPrimary.includes(`\`${ref}\``)) {
          renderedLeaks.push(`${primary.lane} renders ${pass.pass_id}:${ref}`);
        }
      }
    }
    expect({ laneLeaks, renderedLeaks }).toEqual({ laneLeaks: [], renderedLeaks: [] });
  }, 30_000);

  test("rejects the complete 16-case authority matrix and never publishes", async () => {
    const assertNoOutput = () => {
      expect(existsSync(join(fixture.root, fixture.prereg.outputs.result_json))).toBe(false);
      expect(existsSync(join(fixture.root, fixture.prereg.outputs.report_md))).toBe(false);
    };
    const sourcePath = join(fixture.root, "src/x.ts");
    writeFileSync(sourcePath, "export const x = 2;\n");
    await expectAuthority("source-not-clean", assemble());
    writeFileSync(sourcePath, "export const x = 1;\n");

    writeFileSync(sourcePath, "export const x = 3;\n");
    git(fixture.root, ["add", "src/x.ts"]);
    await expectAuthority("source-not-clean", assemble());
    git(fixture.root, ["reset", "-q", "HEAD", "--", "src/x.ts"]);
    writeFileSync(sourcePath, "export const x = 1;\n");

    writeFileSync(join(fixture.root, "rogue-untracked.txt"), "not a declared input\n");
    await expectAuthority("source-not-clean", assemble());
    rmSync(join(fixture.root, "rogue-untracked.txt"));

    const ignoredRogue = join(
      dirname(join(fixture.root, fixture.benchRef)),
      "artifacts/rogue.json",
    );
    mkdirSync(dirname(ignoredRogue), { recursive: true });
    writeFileSync(ignoredRogue, "{}\n", { mode: 0o600 });
    await expectAuthority("source-not-clean", assemble());
    rmSync(ignoredRogue);

    const ignoredRigRogue = join(fixture.root, "artifacts/rig-cassettes/rogue.json");
    mkdirSync(dirname(ignoredRigRogue), { recursive: true });
    writeFileSync(ignoredRigRogue, "{}\n", { mode: 0o600 });
    await expectAuthority("source-not-clean", assemble());
    rmSync(ignoredRigRogue);

    git(fixture.root, ["commit", "--allow-empty", "-qm", "wrong head"]);
    await expectAuthority("source-not-clean", assemble());
    git(fixture.root, ["tag", "-f", "registered-source"]);
    rebindMockSourceHead(fixture.root);

    const benchWrongPrereg = structuredClone(fixture.bench);
    benchWrongPrereg.preregistration.sha256 = "f".repeat(64);
    writeCanonical(fixture.root, fixture.benchRef, benchWrongPrereg);
    await expectAuthority("preregistration-mismatch", assemble());
    writeFileSync(join(fixture.root, fixture.benchRef), fixture.benchBytes, { mode: 0o600 });

    const preregPath = join(fixture.root, fixture.preregRef);
    const catalogDrift = { ...fixture.prereg, catalog_version: "reviewgate.policy-catalog.v0" };
    writeFileSync(preregPath, canonicalJson(catalogDrift));
    git(fixture.root, ["add", fixture.preregRef]);
    git(fixture.root, ["commit", "-qm", "catalog drift"]);
    git(fixture.root, ["tag", "-f", "registered-source"]);
    rebindMockSourceHead(fixture.root);
    await expectAuthority("catalog-mismatch", assemble());

    writeFileSync(preregPath, fixture.preregBytes);
    const corpusDrift = {
      ...fixture.prereg,
      corpus: { ...fixture.prereg.corpus, manifest_sha256: "e".repeat(64) },
    };
    writeFileSync(preregPath, canonicalJson(corpusDrift));
    git(fixture.root, ["add", fixture.preregRef]);
    git(fixture.root, ["commit", "-qm", "corpus drift"]);
    git(fixture.root, ["tag", "-f", "registered-source"]);
    rebindMockSourceHead(fixture.root);
    await expectAuthority("corpus-mismatch", assemble());
    writeFileSync(preregPath, fixture.preregBytes);
    git(fixture.root, ["add", fixture.preregRef]);
    git(fixture.root, ["commit", "-qm", "restore prereg"]);
    git(fixture.root, ["tag", "-f", "registered-source"]);
    rebindMockSourceHead(fixture.root);

    const missingProfile = structuredClone(fixture.bench) as unknown as { profiles: unknown[] };
    missingProfile.profiles.pop();
    writeCanonical(fixture.root, fixture.benchRef, missingProfile);
    await expectAuthority("bench-profile-mismatch", assemble());
    const missingRepeat = structuredClone(fixture.bench) as unknown as {
      profiles: Array<{ data: { repeats: unknown[] } }>;
    };
    missingRepeat.profiles[0]?.data.repeats.pop();
    writeCanonical(fixture.root, fixture.benchRef, missingRepeat);
    await expectAuthority("bench-profile-mismatch", assemble());
    writeFileSync(join(fixture.root, fixture.benchRef), fixture.benchBytes, { mode: 0o600 });

    for (const reason of ["response manifest hash mismatch", "response order mismatch"] as const) {
      controls.bundleFailure = reason;
      await expectAuthority("response-pair-mismatch", assemble());
    }
    controls.bundleFailure = "trace-set mismatch";
    await expectAuthority("trace-mismatch", assemble());
    controls.bundleFailure = null;

    const firstResultRef = fixture.bench.profiles[0]?.data.repeats[0]?.result.ref;
    const firstResult =
      firstResultRef === undefined
        ? undefined
        : (controls.repeatResults.get(firstResultRef) as
            | { source_result: { ref: string } }
            | undefined);
    const firstSource =
      firstResult === undefined
        ? undefined
        : (controls.artifacts.get(firstResult.source_result.ref) as
            | {
                provenance: {
                  integrity: { source_commit: string; preregistration_sha256: string | null };
                };
              }
            | undefined);
    if (firstSource === undefined) throw new Error("missing source provenance fixture");
    const sourceCommit = firstSource.provenance.integrity.source_commit;
    firstSource.provenance.integrity.source_commit = "a".repeat(40);
    await expectAuthority("bench-profile-mismatch", assemble());
    firstSource.provenance.integrity.source_commit = sourceCommit;
    const preregistrationSha = firstSource.provenance.integrity.preregistration_sha256;
    firstSource.provenance.integrity.preregistration_sha256 = "f".repeat(64);
    await expectAuthority("bench-profile-mismatch", assemble());
    firstSource.provenance.integrity.preregistration_sha256 = preregistrationSha;

    controls.traceFailure = true;
    await expectAuthority("trace-mismatch", assemble());
    controls.traceFailure = false;
    controls.rigFailure = new Error("state snapshot digest mismatch");
    await expectAuthority("rig-state-mismatch", assemble());
    controls.rigFailure = null;
    if (controls.rig === null) throw new Error("missing Rig fixture");
    const authoritative = controls.rig.authoritative;
    (controls.rig as { authoritative: boolean }).authoritative = false;
    await expectAuthority("rig-not-authoritative", assemble());
    (controls.rig as { authoritative: boolean }).authoritative = authoritative;
    const rigSourceCommit = controls.rig.source_commit;
    (controls.rig as { source_commit: string }).source_commit = "b".repeat(40);
    await expectAuthority("rig-not-authoritative", assemble());
    (controls.rig as { source_commit: string }).source_commit = rigSourceCommit;
    if (controls.dogfood === null) throw new Error("missing dogfood fixture");
    controls.dogfood.exclusions["changed-source-file"] = 1;
    await expectAuthority("dogfood-mismatch", assemble());
    controls.dogfood.exclusions["changed-source-file"] = 0;
    controls.dogfoodFailure = new Error("frozen dogfood parse failure");
    await expectAuthority("dogfood-mismatch", assemble());
    controls.dogfoodFailure = null;

    git(fixture.root, ["rm", "--cached", "-q", fixture.preregRef]);
    writeFileSync(join(fixture.root, ".git/info/exclude"), `${fixture.preregRef}\n`, {
      flag: "a",
    });
    git(fixture.root, ["commit", "-qm", "remove preregistration from source"]);
    git(fixture.root, ["tag", "-f", "registered-source"]);
    rebindMockSourceHead(fixture.root);
    await expectAuthority("preregistration-mismatch", assemble());
    git(fixture.root, ["add", "-f", fixture.preregRef]);
    git(fixture.root, ["commit", "-qm", "restore preregistration to source"]);
    git(fixture.root, ["tag", "-f", "registered-source"]);
    rebindMockSourceHead(fixture.root);

    const preregBytesPath = join(fixture.root, fixture.preregRef);
    git(fixture.root, ["update-index", "--assume-unchanged", "--", fixture.preregRef]);
    writeFileSync(
      preregBytesPath,
      canonicalJson({ ...fixture.prereg, release: "tampered-head-bytes" }),
      { mode: 0o644 },
    );
    await expect(assemble()).rejects.toMatchObject({
      code: "preregistration-mismatch",
      message:
        "policy measurement: preregistration-mismatch — HEAD contains different preregistration bytes",
    });
    git(fixture.root, ["update-index", "--no-assume-unchanged", "--", fixture.preregRef]);
    writeFileSync(preregBytesPath, fixture.preregBytes, { mode: 0o644 });

    await expectAuthority(
      "artifact-ref-invalid",
      assemblePolicyMeasurement({
        repoRoot: fixture.root,
        preregistrationPath: "../prereg.json",
        benchBundlePath: fixture.benchRef,
        rigManifestPath: fixture.rigRef,
      }),
    );
    assertNoOutput();
  }, 60_000);

  test("rejects Bench provenance that does not bind the preregistered effective configuration", async () => {
    const repeat = fixture.bench.profiles[0]?.data.repeats[0];
    if (repeat === undefined) throw new Error("missing baseline repeat fixture");
    const repeatResult = controls.repeatResults.get(repeat.result.ref) as
      | { source_result: { ref: string } }
      | undefined;
    const source =
      repeatResult === undefined
        ? undefined
        : (controls.artifacts.get(repeatResult.source_result.ref) as
            | { provenance: { config_hash: string } }
            | undefined);
    if (source === undefined) throw new Error("missing source-result fixture");
    const original = source.provenance.config_hash;
    source.provenance.config_hash = "f".repeat(64);
    await expectAuthority("bench-profile-mismatch", assemble());
    source.provenance.config_hash = original;
  });

  test("rejects Bench trace configuration that does not bind the preregistered effective configuration", async () => {
    const repeat = fixture.bench.profiles[0]?.data.repeats[0];
    const repeatResult =
      repeat === undefined
        ? undefined
        : (controls.repeatResults.get(repeat.result.ref) as { cases: CaseResult[] } | undefined);
    const caseRow = repeatResult?.cases[0];
    if (caseRow?.policy_trace === undefined)
      throw new Error("missing baseline trace configuration");
    const original = caseRow.policy_trace.effective_config_sha256;
    caseRow.policy_trace.effective_config_sha256 = "f".repeat(64);
    await expectAuthority("bench-profile-mismatch", assemble());
    caseRow.policy_trace.effective_config_sha256 = original;
  });

  test("rejects a self-consistent Bench case identity that differs from the registered corpus", async () => {
    const changed = structuredClone(fixture.bench);
    const rows = changed.profiles.flatMap((profile) =>
      profile.data.repeats.map((repeat) => {
        const authority = repeat.cases[0];
        const repeatResult = controls.repeatResults.get(repeat.result.ref) as
          | { cases: CaseResult[] }
          | undefined;
        const caseRow = repeatResult?.cases[0];
        if (authority === undefined || caseRow === undefined) {
          throw new Error("missing policy case fixture");
        }
        return { authority, caseRow, original: caseRow.content_hash };
      }),
    );
    for (const row of rows) {
      row.authority.content_sha256 = "f".repeat(64);
      row.caseRow.content_hash = row.authority.content_sha256;
    }
    for (const profile of changed.profiles) {
      const profileDigest = sha256(canonicalJson(profile.data));
      profile.artifact = {
        ref: `artifacts/policy-profiles/${profileDigest}.json`,
        sha256: profileDigest,
      };
    }
    writeCanonical(fixture.root, fixture.benchRef, PolicyBenchBundleSchema.parse(changed));
    await expectAuthority("corpus-mismatch", assemble());
    for (const row of rows) row.caseRow.content_hash = row.original;
    writeFileSync(join(fixture.root, fixture.benchRef), fixture.benchBytes, { mode: 0o600 });
  });

  test("rejects Bench truth whose expected-label count differs from the registered case manifest", async () => {
    const changed = structuredClone(fixture.bench);
    const rows = changed.profiles.flatMap((profile) =>
      profile.data.repeats.map((repeat) => {
        const authority = repeat.cases[16];
        const repeatResult = controls.repeatResults.get(repeat.result.ref) as
          | { cases: CaseResult[] }
          | undefined;
        const caseRow = repeatResult?.cases[16];
        if (authority === undefined || caseRow === undefined) {
          throw new Error("missing seeded policy case fixture");
        }
        return {
          authority,
          caseRow,
          original: structuredClone(caseRow.policy_truth),
        };
      }),
    );
    for (const row of rows) {
      row.caseRow.policy_truth = truth(0);
      row.authority.policy_truth_sha256 = sha256(canonicalJson(row.caseRow.policy_truth));
    }
    for (const profile of changed.profiles) {
      const profileDigest = sha256(canonicalJson(profile.data));
      profile.artifact = {
        ref: `artifacts/policy-profiles/${profileDigest}.json`,
        sha256: profileDigest,
      };
    }
    writeCanonical(fixture.root, fixture.benchRef, PolicyBenchBundleSchema.parse(changed));
    await expectAuthority("corpus-mismatch", assemble());
    for (const row of rows) row.caseRow.policy_truth = row.original;
    writeFileSync(join(fixture.root, fixture.benchRef), fixture.benchBytes, { mode: 0o600 });
  });

  test("fails closed when a no-opportunity singleton changes the observed output", async () => {
    const profile = fixture.bench.profiles[3];
    const rows = profile?.data.repeats.map((repeat) => {
      const repeatResult = controls.repeatResults.get(repeat.result.ref) as
        | { cases: CaseResult[] }
        | undefined;
      const caseRow = repeatResult?.cases[2];
      if (caseRow === undefined) throw new Error("missing no-opportunity singleton case fixture");
      return { caseRow, original: structuredClone(caseRow) };
    });
    if (rows === undefined) throw new Error("missing no-opportunity singleton profile fixture");
    for (const row of rows) {
      row.caseRow.counts = { ...row.caseRow.counts, fp: 1 };
      row.caseRow.policy_truth = truth(1);
    }
    await expect(assemble()).rejects.toThrow(
      "no-opportunity singleton output differs for judgment.hypothetical case clean-03",
    );
    for (const row of rows) Object.assign(row.caseRow, row.original);
  });

  test("fails closed when a no-opportunity interaction changes the observed output", async () => {
    const profile = fixture.bench.profiles[POLICY_PASS_IDS.length + 2];
    const rows = profile?.data.repeats.map((repeat) => {
      const repeatResult = controls.repeatResults.get(repeat.result.ref) as
        | { cases: CaseResult[] }
        | undefined;
      const caseRow = repeatResult?.cases[2];
      if (caseRow === undefined) throw new Error("missing no-opportunity interaction case fixture");
      return { caseRow, original: structuredClone(caseRow) };
    });
    if (rows === undefined) throw new Error("missing no-opportunity interaction profile fixture");
    for (const row of rows) {
      row.caseRow.counts = { ...row.caseRow.counts, fp: 1 };
      row.caseRow.policy_truth = truth(1);
    }
    await expect(assemble()).rejects.toThrow(
      "no-opportunity interaction output differs for scope.diff/scope.delta/scope.session case clean-03",
    );
    for (const row of rows) Object.assign(row.caseRow, row.original);
  });

  test("maps a unique blocking-FN benefit to preserved blocking truth", async () => {
    const rows = fixture.bench.profiles.flatMap((profile, profileIndex) =>
      profile.data.repeats.map((repeat) => {
        const repeatResult = controls.repeatResults.get(repeat.result.ref) as
          | { cases: CaseResult[] }
          | undefined;
        const caseRow = repeatResult?.cases[16];
        if (caseRow === undefined) throw new Error("missing seeded profile case fixture");
        return { profileIndex, caseRow, original: structuredClone(caseRow) };
      }),
    );
    for (const row of rows) {
      if (row.profileIndex === 1) continue;
      row.caseRow.counts = { ...row.caseRow.counts, tp: 1, fn: 0 };
      row.caseRow.policy_truth = {
        expected_label_count: 1,
        findings: [
          {
            signature: "matched-fixture-label",
            severity: "WARN",
            outcome: "TP",
            label_index: 0,
            near_miss: false,
          },
        ],
        fn_label_indexes: [],
      };
    }
    const assembled = await assemble();
    const benefit = assembled.result.passes[0]?.evidence.unique_contributions.find(
      (row) => row.kind === "preserved-blocking-tp",
    );
    expect(benefit).toBeDefined();
    expect(assembled.result.passes[0]?.vetoes).toContain("unique-preserved-tp");
    for (const row of rows) Object.assign(row.caseRow, row.original);
  });

  test("rejects a real Bench stack whose per-case request identities are self-declared", () => {
    const real = materializeRealBenchFixture({ requestIdentity: "self-declared" });
    const result = runRealAssembler(real);
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("corpus-mismatch");
  }, 120_000);

  test("rejects a real Bench stack whose raw responses are not closed per case", () => {
    const real = materializeRealBenchFixture({ responseClosure: "shared" });
    const result = runRealAssembler(real);
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("response-pair-mismatch");
  }, 120_000);

  test("rejects a real Bench stack whose case response sequence is reordered", () => {
    const real = materializeRealBenchFixture({ responseClosure: "reordered" });
    const result = runRealAssembler(real);
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("response-pair-mismatch");
  }, 120_000);

  test("rejects a real Bench stack that reuses an earlier case response span", () => {
    const real = materializeRealBenchFixture({ responseClosure: "reused" });
    const result = runRealAssembler(real);
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("response-pair-mismatch");
  }, 120_000);

  test("rejects a real Bench stack with one unconsumed response entry", () => {
    const real = materializeRealBenchFixture({ responseClosure: "partial" });
    const result = runRealAssembler(real);
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("response-pair-mismatch");
  }, 120_000);

  test("rejects a real authoritative Bench span with one missing raw response digest", () => {
    const real = materializeRealBenchFixture({ responseClosure: "missing-digest" });
    const result = runRealAssembler(real);
    expect(result.exitCode).toBe(4);
    expect(result.stderr).toContain("response-pair-mismatch");
  }, 120_000);

  test("assembles a real canonical Bench artifact stack and rejects mode, bytes, and root drift", () => {
    const real = materializeRealBenchFixture();
    const valid = runRealAssembler(real);
    expect(valid, valid.stderr).toMatchObject({ exitCode: 0 });
    expect(JSON.parse(valid.stdout)).toMatchObject({ ok: true, passes: 18 });

    chmodSync(join(real.fixture.root, real.fixture.benchRef), 0o644);
    const publicNamedArtifact = runRealAssembler(real);
    expect(publicNamedArtifact.exitCode).toBe(4);
    expect(publicNamedArtifact.stderr).toContain("bench-profile-mismatch");
    chmodSync(join(real.fixture.root, real.fixture.benchRef), 0o600);

    const profileBytes = readFileSync(real.firstProfilePath);
    writeFileSync(real.firstProfilePath, `${profileBytes.toString("utf8")} `, { mode: 0o600 });
    const tampered = runRealAssembler(real);
    expect(tampered.exitCode).toBe(4);
    expect(tampered.stderr).toContain("response-pair-mismatch");
    writeFileSync(real.firstProfilePath, profileBytes, { mode: 0o600 });

    const escaped = runRealAssembler(real, { benchRef: "../bench.json" });
    expect(escaped.exitCode).toBe(4);
    expect(escaped.stderr).toContain("artifact-ref-invalid");
  }, 120_000);

  test("assembles a real nested registered Bench stack from the attempt root", () => {
    const real = materializeRealBenchFixture({ nestedBenchBundle: true });
    const result = runRealAssembler(real);

    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: true, passes: 18 });
  }, 120_000);

  test("rejects every trace-set identity that differs from the verified case result", () => {
    const real = materializeRealBenchFixture();
    for (const field of [
      "effective_config_sha256",
      "request_identity_sha256",
      "final_identity_sha256",
      "raw_response_sha256",
    ] as const) {
      const result = runRealBundleVerifier({
        root: dirname(join(real.fixture.root, real.fixture.benchRef)),
        bundle: realBundleWithTraceSetIdentityDrift(real, field),
      });
      expect(result, `${field}: ${result.stderr}`).toMatchObject({ exitCode: 0 });
      const verified = JSON.parse(result.stdout) as { ok: boolean; reason?: string };
      expect(verified.ok, field).toBe(false);
      expect(verified.reason, field).toBe("baseline repeat 1 trace-set mismatch");
    }
  }, 120_000);
});
