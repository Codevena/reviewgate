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
import { dirname, join, relative } from "node:path";
import { canonicalJson } from "../../src/audit/canonical.ts";
import { AuditLogger } from "../../src/audit/logger.ts";
import { buildBenchConfig, policyBenchRequestIdentity } from "../../src/bench/runner.ts";
import { __policyStatsTest } from "../../src/cli/commands/stats.ts";
import {
  POLICY_CATALOG_VERSION,
  POLICY_PASSES,
  POLICY_PASS_IDS,
  type PolicyPassId,
} from "../../src/core/policy/catalog.ts";
import {
  sortIdentityEvents,
  sortSingletonIdentityEvents,
} from "../../src/core/policy/identity-events.ts";
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

function trace(caseId: string, findingSignature: string) {
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
    // Bench truth is keyed by final finding signature.  The real trace contract carries that
    // same lineage through every applicable evaluation; keep the authority fixture faithful so
    // attribution cannot use an unbound placeholder label.
    source_signatures: [findingSignature, `sig-${caseId}`],
    final_signature: findingSignature,
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
    const policyTrace = trace(caseId, "fp-0");
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
            pass_ids: [...POLICY_MEASUREMENT_INTERACTIONS[2]].sort(
              (left, right) => POLICY_PASS_IDS.indexOf(left) - POLICY_PASS_IDS.indexOf(right),
            ),
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

/** Materialize the byte-bound Rig artifact inventory used by publication verification. */
function writeRigEvidenceArtifacts(root: string, manifest: PolicyRigScenarioManifest): void {
  const writeBoundText = (ref: string, text: string): void => {
    const path = join(root, ref);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, text, { mode: 0o600 });
  };
  writeBoundText(binding("rig-cassettes", "closed-cassette").ref, "closed-cassette");
  for (const scenario of manifest.scenarios) {
    const [passId, sequence] = scenario.id.split(/-(?=\d+$)/);
    if (passId === undefined || sequence === undefined)
      throw new Error(`invalid fixture scenario ${scenario.id}`);
    writeBoundText(scenario.manifest.ref, `${passId}:${sequence}:manifest`);
    writeBoundText(scenario.result.ref, `${passId}:${sequence}:result`);
    writeBoundText(scenario.script.ref, `${passId}:${sequence}:script`);
    writeBoundText(scenario.initial_state.ref, `${passId}:${sequence}:state`);
  }
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
    declined: 0,
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

function fixtureProfileCases(
  fixture: Fixture,
  profileIndex: number,
  caseIndexes: readonly number[],
): Array<{ caseRow: CaseResult; original: CaseResult }> {
  const profile = fixture.bench.profiles[profileIndex];
  if (profile === undefined) throw new Error(`missing fixture profile ${profileIndex}`);
  return profile.data.repeats.flatMap((repeat) => {
    const result = controls.repeatResults.get(repeat.result.ref) as
      | { cases: CaseResult[] }
      | undefined;
    if (result === undefined)
      throw new Error(`missing fixture repeat ${profileIndex}:${repeat.repeat}`);
    return caseIndexes.map((caseIndex) => {
      const caseRow = result.cases[caseIndex];
      if (caseRow === undefined)
        throw new Error(`missing fixture case ${profileIndex}:${caseIndex}`);
      return { caseRow, original: structuredClone(caseRow) };
    });
  });
}

function setFixtureBlockingFp(rows: readonly { caseRow: CaseResult }[], fp: number): void {
  for (const { caseRow } of rows) {
    caseRow.counts = { ...caseRow.counts, fp };
    caseRow.policy_truth = truth(fp);
  }
}

function restoreFixtureCases(rows: readonly { caseRow: CaseResult; original: CaseResult }[]): void {
  for (const { caseRow, original } of rows) Object.assign(caseRow, original);
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
  carrierPassIds: readonly PolicyPassId[] = [],
): PolicyTrace {
  const orderedAblations = POLICY_PASS_IDS.filter((passId) => ablatedPassIds.includes(passId));
  const carrierPassId = carrierPassIds[0];
  const carrierAblated = carrierPassId !== undefined && orderedAblations.includes(carrierPassId);
  return PolicyTraceSchema.parse({
    schema: "reviewgate.policy-trace.v1",
    catalog_version: POLICY_CATALOG_VERSION,
    run_id: `real-profile-${profileIndex}-repeat-${repeat}-${caseId}`,
    iter: 1,
    ablated: orderedAblations,
    raw_response_sha256: [...rawResponseSha256],
    passes: POLICY_PASS_IDS.map((passId) =>
      passId === carrierPassId
        ? {
            pass_id: passId,
            status: "ran" as const,
            considered: 1,
            opportunities: 1,
            would_apply: 1,
            applied: carrierAblated ? 0 : 1,
            protected: 0,
            blocking_removed: carrierAblated ? 0 : 1,
            blocking_preserved: carrierAblated ? 1 : 0,
            dropped: 0,
          }
        : {
            pass_id: passId,
            status: "ran" as const,
            considered: 0,
            opportunities: 0,
            would_apply: 0,
            applied: 0,
            protected: 0,
            blocking_removed: 0,
            blocking_preserved: 0,
            dropped: 0,
          },
    ),
    evaluations:
      carrierPassId === undefined
        ? []
        : [
            {
              pass_id: carrierPassId,
              order: POLICY_PASSES.find((pass) => pass.id === carrierPassId)?.order ?? 0,
              result: carrierAblated ? ("would-apply" as const) : ("applied" as const),
              before: "WARN" as const,
              after: carrierAblated ? ("WARN" as const) : ("INFO" as const),
              reason_code: "location-out-of-range",
              source_signatures: ["fp-0"],
              final_signature: "fp-0",
            },
          ],
    stages:
      carrierPassId === undefined
        ? [
            {
              stage_id: "verdict.compute",
              order: 190,
              reason_code: "no-blocking-findings",
              input_signatures: [],
              verdict: "PASS",
            },
          ]
        : [
            {
              stage_id: "aggregation.cluster",
              order: 65,
              reason_code: "singleton",
              member_count: 1,
              input_signatures: ["fp-0"],
              output_signature: "fp-0",
            },
            {
              stage_id: "verdict.compute",
              order: 190,
              reason_code: carrierAblated ? "blocking-present" : "no-blocking-findings",
              input_signatures: carrierAblated ? ["fp-0"] : [],
              verdict: carrierAblated ? "SOFT-PASS" : "PASS",
            },
          ],
    final:
      carrierPassId === undefined
        ? {
            verdict: "PASS",
            counts: { critical: 0, warn: 0, info: 0 },
            finding_signatures: [],
            finding_severities: [],
          }
        : {
            verdict: carrierAblated ? "SOFT-PASS" : "PASS",
            counts: { critical: 0, warn: carrierAblated ? 1 : 0, info: carrierAblated ? 0 : 1 },
            finding_signatures: ["fp-0"],
            finding_severities: [
              {
                signature: "fp-0",
                severity: carrierAblated ? ("WARN" as const) : ("INFO" as const),
              },
            ],
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
  dogfoodSourceRefs?: readonly string[];
}

interface RealBenchFixtureOptions {
  requestIdentity?: "derived" | "self-declared";
  responseClosure?: "closed" | "shared" | "reordered" | "reused" | "partial" | "missing-digest";
  nestedBenchBundle?: boolean;
  benchSingletonLoss?: boolean;
  /** Supply observed TP/FP/FN denominators on both sides of the Bench singleton comparison. */
  benchFiniteRates?: boolean;
  /** Add one complete frozen Dogfood audit/trace pair owned by exactly one pass. */
  dogfoodUnrelatedEntry?: boolean;
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

function materializeNonemptyDogfoodSource(root: string): {
  entries: PolicyDogfoodInputManifest["entries"];
  rows: readonly PolicyDogfoodAttestation["rows"][number][];
  refs: readonly string[];
} {
  const auditDir = join(root, ".reviewgate", "audit");
  mkdirSync(auditDir, { recursive: true, mode: 0o700 });
  const log = new AuditLogger(auditDir);
  const trace = emptyAuthoritativeTrace(
    0,
    1,
    [],
    "dogfood-owned-run",
    [sha256("dogfood-owned-response")],
    ["evidence.fact-location"],
  );
  const stored = log.writePolicyTrace(trace);
  if (stored.status !== "complete") throw new Error("failed to write nonempty Dogfood trace");
  void log.append({
    event: "run.complete",
    run_id: trace.run_id,
    iter: trace.iter,
    trigger: "stop-hook",
    run_summary: {
      verdict: "PASS",
      source: "panel",
      counts: { critical: 0, warn: 0, info: 0 },
      cost_usd: 0,
      duration_ms: 1,
      demoted: 0,
      signatures: [],
      providers: [],
      policy_trace_status: "complete",
      policy_trace_ref: stored.ref,
      policy_trace_sha256: stored.sha256,
    },
  });
  void log.append({
    event: "decision.applied",
    run_id: trace.run_id,
    iter: trace.iter,
    trigger: "stop-hook",
    finding_signatures: ["fp-0"],
    decision_outcome: {
      finding_id: "F-dogfood-owned",
      severity: "WARN",
      bucket: "tp",
      providers: ["codex"],
    },
  });
  const auditPath = log.currentFilePath();
  const auditRef = relative(root, auditPath).split("\\").join("/");
  const traceRef = `.reviewgate/audit/${stored.ref}`;
  const auditBytes = readFileSync(auditPath);
  const traceBytes = readFileSync(join(auditDir, stored.ref));
  const entries = [
    {
      kind: "audit" as const,
      ref: auditRef,
      sha256: sha256(auditBytes),
      bytes: auditBytes.length,
      runs: [
        {
          run_id: trace.run_id,
          iter: trace.iter,
          trace_ref: stored.ref,
          trace_sha256: stored.sha256,
        },
      ],
    },
    {
      kind: "trace" as const,
      ref: traceRef,
      audit_ref: auditRef,
      trace_ref: stored.ref,
      sha256: stored.sha256,
      bytes: traceBytes.length,
      run_id: trace.run_id,
      iter: trace.iter,
    },
  ].sort((left, right) => (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0));
  return {
    entries: PolicyDogfoodInputManifestSchema.parse({
      schema: "reviewgate.policy-dogfood-input-manifest.v1",
      since: "2000-01-01T00:00:00.000Z",
      until: "2100-01-01T00:00:00.000Z",
      entries,
    }).entries,
    rows: [
      {
        run_id: trace.run_id,
        iter: trace.iter,
        finding_signature: "fp-0",
        disposition: "tp",
      },
    ],
    refs: [auditRef, traceRef].sort(),
  };
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
  const dogfoodSource =
    options.dogfoodUnrelatedEntry === true
      ? materializeNonemptyDogfoodSource(fixture.root)
      : undefined;
  const dogfoodManifest = PolicyDogfoodInputManifestSchema.parse({
    schema: "reviewgate.policy-dogfood-input-manifest.v1",
    since: dogfoodSource === undefined ? fixture.prereg.dogfood.since : "2000-01-01T00:00:00.000Z",
    until: dogfoodSource === undefined ? fixture.prereg.dogfood.until : "2100-01-01T00:00:00.000Z",
    entries: dogfoodSource?.entries ?? [],
  });
  const manifestBinding = writeContentAddressedArtifact(
    fixture.root,
    "policy-dogfood-input",
    dogfoodManifest,
  );
  const attestationRows = dogfoodSource?.rows ?? [
    { run_id: "unavailable-real-stack-run", iter: 1, finding_signature: "sig", disposition: "tp" },
  ];
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
    registered_at: dogfoodManifest.until,
    dogfood: {
      ...fixture.prereg.dogfood,
      since: dogfoodManifest.since,
      until: dogfoodManifest.until,
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
        const benchSingletonLoss =
          options.benchSingletonLoss === true &&
          (scheduled.id === "single:evidence.fact-location" || scheduled.id === "interaction:4") &&
          caseId.startsWith("clean-");
        const finiteRateAblation =
          options.benchFiniteRates === true &&
          (scheduled.id === "single:evidence.fact-location" || scheduled.id === "interaction:4");
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
          options.benchSingletonLoss === true ? ["evidence.fact-location"] : [],
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
          counts:
            options.benchFiniteRates === true
              ? finiteRateAblation
                ? { tp: 1, fp: 1, fn: 2, neutral: 0 }
                : { tp: 2, fp: 0, fn: 1, neutral: 0 }
              : { tp: 0, fp: benchSingletonLoss ? 1 : 0, fn: 0, neutral: 0 },
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
          policy_truth: truth(benchSingletonLoss ? 1 : 0, caseId.startsWith("seeded-") ? 1 : 0),
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
            opportunities:
              options.benchSingletonLoss === true && passId === "evidence.fact-location" ? 30 : 0,
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
  writeRigEvidenceArtifacts(fixture.root, rig.manifest);
  (rig as { source_commit: string }).source_commit = sourceHead;
  const firstProfile = profiles[0];
  if (firstProfile === undefined) throw new Error("missing real baseline profile");
  return {
    fixture,
    prereg,
    rig,
    firstProfilePath: join(attemptRoot, firstProfile.artifact.ref),
    ...(dogfoodSource === undefined ? {} : { dogfoodSourceRefs: dogfoodSource.refs }),
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

function runRealPolicyStats(real: RealBenchFixture): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const scratch = mkdtempSync(join(tmpdir(), "rg-policy-real-stats-"));
  const payloadPath = join(scratch, "payload.json");
  const runnerPath = join(scratch, "runner.ts");
  const rigModule = new URL("../../src/stats/policy/rig.ts", import.meta.url).href;
  const statsModule = new URL("../../src/cli/commands/stats.ts", import.meta.url).href;
  writeFileSync(
    payloadPath,
    JSON.stringify({
      rig: real.rig,
      input: {
        repoRoot: real.fixture.root,
        preregistration: real.fixture.preregRef,
        bench: real.fixture.benchRef,
        rig: real.fixture.rigRef,
        out: real.prereg.outputs.attempt_dir,
      },
    }),
  );
  writeFileSync(
    runnerPath,
    [
      'import { mock } from "bun:test";',
      "const payload = JSON.parse(await Bun.file(process.argv[2]).text());",
      `mock.module(${JSON.stringify(rigModule)}, () => ({ collectPolicyRigEvidence: async () => payload.rig }));`,
      `const { runPolicyStats } = await import(${JSON.stringify(statsModule)});`,
      "const result = await runPolicyStats(payload.input);",
      "console.log(JSON.stringify(result));",
      "process.exit(result.exitCode);",
    ].join("\n"),
  );
  const run = Bun.spawnSync({ cmd: [process.execPath, runnerPath, payloadPath] });
  return {
    exitCode: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
  };
}

function rewritePublishedResult(
  output: string,
  mutate: (value: Record<string, unknown>) => void,
): void {
  const markerPath = join(output, "complete.json");
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
    result: { ref: string; sha256: string };
    outputs: { result_json: { ref: string; sha256: string } };
  };
  const resultPath = join(output, marker.result.ref);
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
  mutate(result);
  const text = canonicalJson(result);
  const digest = sha256(text);
  writeFileSync(resultPath, text, { mode: 0o600 });
  marker.result.sha256 = digest;
  marker.outputs.result_json.sha256 = digest;
  writeFileSync(markerPath, canonicalJson(marker), { mode: 0o600 });
}

/** Rebind every final projection after a schema-valid publication mutation. */
function rewritePublishedProjection(
  output: string,
  mutate: (value: Record<string, unknown>) => void,
): void {
  const markerPath = join(output, "complete.json");
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
    result: { ref: string; sha256: string };
    report: { ref: string; sha256: string };
    outputs: {
      result_json: { ref: string; sha256: string };
      report_md: { ref: string; sha256: string };
    };
  };
  const resultPath = join(output, marker.result.ref);
  const result = JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
  mutate(result);
  const parsed = PolicyMeasurementSchema.parse(result);
  const resultText = canonicalJson(parsed);
  const reportText = renderPolicyMeasurement(parsed);
  const resultDigest = sha256(resultText);
  const reportDigest = sha256(reportText);
  writeFileSync(resultPath, resultText, { mode: 0o600 });
  writeFileSync(join(output, marker.report.ref), reportText, { mode: 0o600 });
  marker.result.sha256 = resultDigest;
  marker.outputs.result_json.sha256 = resultDigest;
  marker.report.sha256 = reportDigest;
  marker.outputs.report_md.sha256 = reportDigest;
  writeFileSync(markerPath, canonicalJson(marker), { mode: 0o600 });
}

function rewritePublishedDogfoodSnapshot(
  output: string,
  mutate: (value: Record<string, unknown>) => void,
): void {
  const markerPath = join(output, "complete.json");
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
    outputs: { dogfood_snapshot: { ref: string; sha256: string } };
  };
  const snapshotPath = join(output, marker.outputs.dogfood_snapshot.ref);
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
  mutate(snapshot);
  const text = canonicalJson(snapshot);
  marker.outputs.dogfood_snapshot.sha256 = sha256(text);
  writeFileSync(snapshotPath, text, { mode: 0o600 });
  writeFileSync(markerPath, canonicalJson(marker), { mode: 0o600 });
}

/** Rebind only the completion marker after a byte-level Markdown mutation. */
function rewritePublishedReport(output: string, mutate: (markdown: string) => string): void {
  const markerPath = join(output, "complete.json");
  const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
    report: { ref: string; sha256: string };
    outputs: { report_md: { ref: string; sha256: string } };
  };
  const reportPath = join(output, marker.report.ref);
  const markdown = mutate(readFileSync(reportPath, "utf8"));
  const digest = sha256(markdown);
  writeFileSync(reportPath, markdown, { mode: 0o600 });
  marker.report.sha256 = digest;
  marker.outputs.report_md.sha256 = digest;
  writeFileSync(markerPath, canonicalJson(marker), { mode: 0o600 });
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
    expect(markdown).toContain("dogfood:post-registered-at=2");
    expect(markdown).toContain("95% interval");
    expect(markdown).not.toContain("statistically significant");
    const identityFacts = assembled.result.identity_evidence.flatMap((row) => [
      ...row.ground_truth_harms,
      ...row.dogfood_dispositions,
      ...row.beneficial_effects,
    ]);
    expect(identityFacts.length).toBeGreaterThan(0);
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
        const expected = `benefit identity=${fact.identity} evidence=${fact.evidence_ref}`;
        const lines = markdown.split("\n");
        const start = lines.indexOf(`### \`${identity.pass_id}\``);
        const dossierLine = lines
          .slice(start + 1, lines.indexOf("## Artifact inventory"))
          .find((line) =>
            line.includes(`benefit identity=${fact.identity} evidence=${fact.evidence_ref}`),
          );
        expect(dossierLine).toContain(expected);
        expect(dossierLine).toContain(
          `reproduced_by=${
            fact.reproduced_by_pass_ids.map((passId) => `\`${passId}\``).join(",") || "none"
          }`,
        );
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
      classification: "inconclusive",
      evidence: {
        opportunities: { runs: 3 },
        exclusions: [{ lane: "dogfood", code: "post-registered-at", count: 2 }],
      },
    });
    expect(assembled.result.passes[0]).toMatchObject({
      classification: "inconclusive",
      reasons: ["incomplete-authority"],
    });
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

  test("persists every raw paired effect from the assembled 30-case Bench fixture", async () => {
    const assembled = await assemble();
    const pass = assembled.result.passes.find((row) => row.pass_id === "evidence.fact-location");
    const summary = pass?.evidence.lane_summaries.find((row) => row.lane === "stateless-bench");
    if (summary === undefined) throw new Error("missing 30-case Bench summary");
    const statistics = summary.statistics as unknown as {
      raw_effects: number[];
      case_effects: Array<{ case_id: string; repeat: number; error_reduction: number }>;
    };

    // This must fail if the producer reduces 90 raw paired case effects to three repeat means.
    expect(statistics.case_effects).toHaveLength(90);
    expect(statistics.raw_effects).toHaveLength(90);
    expect(statistics.case_effects.map((effect) => effect.error_reduction)).toEqual(
      statistics.raw_effects,
    );
  }, 30_000);

  test("does not fabricate repeat directions for a complete no-opportunity Bench lane", async () => {
    const assembled = await assemble();
    const pass = assembled.result.passes.find((row) => row.pass_id === "judgment.hypothetical");
    const summary = pass?.evidence.lane_summaries.find((row) => row.lane === "stateless-bench");
    if (summary === undefined) throw new Error("missing no-opportunity Bench summary");
    expect(summary.statistics).toMatchObject({
      case_effects: [],
      raw_effects: [],
      mean_error_reduction: 0,
      median_error_reduction: 0,
      repeat_directions: [],
    });
  }, 30_000);

  test("keeps singleton losses unique when a necessary overlapping cofactor has the same group loss", async () => {
    const groupProfile = POLICY_PASS_IDS.length + 1 + 3;
    const groupRows = fixtureProfileCases(
      fixture,
      groupProfile,
      Array.from({ length: 10 }, (_, index) => index + 2),
    );
    setFixtureBlockingFp(groupRows, 1);
    try {
      const assembled = await assemble();
      const pass = assembled.result.passes.find((row) => row.pass_id === "evidence.fact-location");
      const facts = assembled.result.identity_evidence.find(
        (row) => row.pass_id === "evidence.fact-location",
      );
      const identity = "bench:clean-03:blocking-fp:fp-0";
      const group = assembled.result.interactions[3];
      if (pass === undefined || facts === undefined || group === undefined) {
        throw new Error("missing C4 fixture authority row");
      }
      expect(facts.beneficial_effects.find((row) => row.identity === identity)).toMatchObject({
        identity,
        reproduced_by_pass_ids: [],
        singleton_evidence: {
          ref: `${dirname(fixture.benchRef)}/${fixture.bench.profiles[1]?.artifact.ref}`,
          sha256: fixture.bench.profiles[1]?.artifact.sha256,
        },
        group_comparison: {
          pass_ids: [...POLICY_MEASUREMENT_INTERACTIONS[3]],
          artifact: group.artifact,
        },
      });
      const benefit = facts.beneficial_effects.find((row) => row.identity === identity);
      if (benefit === undefined) throw new Error("missing C4 singleton benefit");
      const markdown = renderPolicyMeasurement(assembled.result);
      expect(markdown).toContain(
        `singleton=\`${benefit.singleton_evidence.ref}\` (${benefit.singleton_evidence.sha256})`,
      );
      expect(markdown).toContain(`group=\`${group.artifact.ref}\` (${group.artifact.sha256})`);
      expect(markdown).toContain(
        `group_raw=${benefit.group_comparison?.raw_evidence
          .map((entry) => `\`${entry.ref}\` (${entry.sha256})`)
          .join(",")}`,
      );
      expect(pass.evidence.unique_contributions).toContainEqual(
        expect.objectContaining({
          identity,
          kind: "prevented-blocking-fp",
          group_comparison: expect.objectContaining({ artifact: group.artifact }),
        }),
      );
      const cofactor = assembled.result.passes.find(
        (row) => row.pass_id === "evidence.grounding-token",
      );
      const cofactorFacts = assembled.result.identity_evidence.find(
        (row) => row.pass_id === "evidence.grounding-token",
      );
      if (cofactor === undefined || cofactorFacts === undefined) {
        throw new Error("missing C4 cofactor fixture authority row");
      }
      expect(
        cofactorFacts.beneficial_effects.find((row) => row.identity === identity),
      ).toMatchObject({ reproduced_by_pass_ids: [] });
      expect(cofactor.evidence.unique_contributions).toContainEqual(
        expect.objectContaining({ identity, kind: "prevented-blocking-fp" }),
      );
    } finally {
      restoreFixtureCases(groupRows);
    }
  }, 30_000);

  test("does not invent a group-only benefit without a retained singleton cover", async () => {
    const groupProfile = POLICY_PASS_IDS.length + 1 + 3;
    const caseIndexes = Array.from({ length: 9 }, (_, index) => index + 2);
    const groupRows = fixtureProfileCases(fixture, groupProfile, caseIndexes);
    const memberRows = POLICY_MEASUREMENT_INTERACTIONS[3].flatMap((passId) =>
      fixtureProfileCases(fixture, POLICY_PASS_IDS.indexOf(passId) + 1, caseIndexes),
    );
    setFixtureBlockingFp(groupRows, 1);
    setFixtureBlockingFp(memberRows, 0);
    try {
      const assembled = await assemble();
      const facts = assembled.result.identity_evidence.find(
        (row) => row.pass_id === "evidence.redaction-placeholder",
      );
      if (facts === undefined) throw new Error("missing group-only identity fixture authority row");
      expect(facts.beneficial_effects).toEqual([]);
    } finally {
      restoreFixtureCases(memberRows);
      restoreFixtureCases(groupRows);
    }
  }, 30_000);

  test("leaves a singleton loss inconclusive without the same paired group identity", async () => {
    const groupProfile = POLICY_PASS_IDS.length + 1 + 3;
    const caseIndexes = Array.from({ length: 9 }, (_, index) => index + 2);
    const singletonRows = fixtureProfileCases(fixture, 1, caseIndexes);
    const groupRows = fixtureProfileCases(fixture, groupProfile, caseIndexes);
    setFixtureBlockingFp(singletonRows, 1);
    setFixtureBlockingFp(groupRows, 0);
    try {
      const assembled = await assemble();
      const pass = assembled.result.passes.find((row) => row.pass_id === "evidence.fact-location");
      const facts = assembled.result.identity_evidence.find(
        (row) => row.pass_id === "evidence.fact-location",
      );
      const identity = "bench:clean-03:blocking-fp:fp-0";
      if (pass === undefined || facts === undefined) {
        throw new Error("missing C4 uncorroborated singleton fixture authority row");
      }
      expect(facts.beneficial_effects.find((row) => row.identity === identity)).toBeUndefined();
      expect(
        pass.evidence.unique_contributions.find((row) => row.identity === identity),
      ).toBeUndefined();
      expect(pass).toMatchObject({
        classification: "inconclusive",
        reasons: ["incomplete-authority"],
      });
    } finally {
      restoreFixtureCases(groupRows);
      restoreFixtureCases(singletonRows);
    }
  }, 30_000);

  test("attributes a covered singleton identity to an independently retained overlap", async () => {
    const groupProfile = POLICY_PASS_IDS.length + 1 + 3;
    const caseIndexes = Array.from({ length: 9 }, (_, index) => index + 2);
    const groupRows = fixtureProfileCases(fixture, groupProfile, caseIndexes);
    const targetRows = fixtureProfileCases(fixture, 4, caseIndexes);
    setFixtureBlockingFp(groupRows, 1);
    setFixtureBlockingFp(targetRows, 0);
    try {
      const assembled = await assemble();
      const target = assembled.result.passes.find(
        (row) => row.pass_id === "evidence.grounding-token",
      );
      const targetFacts = assembled.result.identity_evidence.find(
        (row) => row.pass_id === "evidence.grounding-token",
      );
      const identity = "bench:clean-03:blocking-fp:fp-0";
      if (target === undefined || targetFacts === undefined) {
        throw new Error("missing C4 covered fixture authority row");
      }
      expect(targetFacts.beneficial_effects.find((row) => row.identity === identity)).toMatchObject(
        {
          reproduced_by_pass_ids: ["evidence.fact-location"],
        },
      );
      expect(target.reasons).toEqual(["sufficient-covered-zero-unique-benefit"]);
      expect(target.classification).toBe("delete-candidate");
    } finally {
      restoreFixtureCases(targetRows);
      restoreFixtureCases(groupRows);
    }
  }, 30_000);

  test("emits a catalog-bound required-backstop identity only from its singleton and paired group loss", async () => {
    const groupProfile = POLICY_PASS_IDS.length + 1 + 3;
    const caseIndexes = Array.from({ length: 9 }, (_, index) => index + 2);
    const groupRows = fixtureProfileCases(fixture, groupProfile, caseIndexes);
    const singletonRows = fixtureProfileCases(fixture, 6, caseIndexes);
    const baselineRows = fixtureProfileCases(fixture, 0, caseIndexes);
    setFixtureBlockingFp(groupRows, 1);
    setFixtureBlockingFp(singletonRows, 1);
    for (const { caseRow } of baselineRows) {
      const evaluations = caseRow.policy_trace?.trace?.evaluations;
      const evaluation = evaluations?.find(
        (row) => row.pass_id === "evidence.redaction-placeholder",
      );
      if (evaluation === undefined) throw new Error("missing backstop trace evaluation");
      Object.assign(evaluation, {
        result: "protected",
        reason_code: "placeholder-code-hallucination",
        protected_by: "secret-evidence-backstop",
      });
    }
    try {
      const assembled = await assemble();
      const pass = assembled.result.passes.find(
        (row) => row.pass_id === "evidence.redaction-placeholder",
      );
      const identity = "bench:clean-03:blocking-fp:fp-0";
      if (pass === undefined) throw new Error("missing C4 backstop fixture authority row");
      expect(pass.evidence.unique_contributions).toContainEqual(
        expect.objectContaining({ identity, kind: "required-backstop" }),
      );
      expect(pass).toMatchObject({
        classification: "retain",
        vetoes: ["required-backstop"],
      });
    } finally {
      restoreFixtureCases(baselineRows);
      restoreFixtureCases(singletonRows);
      restoreFixtureCases(groupRows);
    }
  }, 30_000);

  test("retains one exact paired Rig identity from its singleton and applicable group", async () => {
    const assembled = await assemble();
    const pass = assembled.result.passes.find((row) => row.pass_id === "history.fp-signature");
    const facts = assembled.result.identity_evidence.find(
      (row) => row.pass_id === "history.fp-signature",
    );
    const interaction = assembled.result.interactions[2];
    const identity = "rig:1:turn-1:blocking-fp:fp-1";
    if (pass === undefined || facts === undefined || interaction === undefined) {
      throw new Error("missing paired Rig C4 authority row");
    }
    expect(interaction.primary_lane).toBe("stateful-rig");
    expect(interaction.identity_inventory.outcomes).toContainEqual({
      identity,
      // Four members participate in this group, but the target pass's exact scenario/turn
      // observation is one independently valid Rig unit. The persisted attribution must not
      // apply the Bench repeat threshold to that target-member direction.
      worsened: 4,
      improved: 0,
    });
    expect(facts.beneficial_effects).toContainEqual(
      expect.objectContaining({ identity, reproduced_by_pass_ids: [] }),
    );
    expect(pass).toMatchObject({
      classification: "retain",
      vetoes: ["unique-prevented-fp"],
    });
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
          "blocking_count_delta",
          "case_effects",
          "error_components",
          "interval",
          "mean_error_reduction",
          "median_error_reduction",
          "p_value",
          "precision_delta",
          "raw_effects",
          "recall_delta",
          "repeat_directions",
          "severity_deltas",
          "verdict_deltas",
        ]);
        expect(Array.isArray(summary.limitations)).toBe(true);
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
          "blocking_count_delta",
          "case_effects",
          "error_components",
          "interval",
          "mean_error_reduction",
          "median_error_reduction",
          "p_value",
          "precision_delta",
          "raw_effects",
          "recall_delta",
          "repeat_directions",
          "severity_deltas",
          "verdict_deltas",
        ]);
        expect(Array.isArray(summary.limitations)).toBe(true);
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
    for (const summary of stateful.evidence.lane_summaries) {
      const line = markdown
        .split("\n")
        .find((row) =>
          row.includes(
            `Lane ${summary.lane}: primary=${summary.primary}; descriptive=${summary.descriptive};`,
          ),
        );
      expect(line).toContain(
        `interval=[${summary.statistics.interval.lo},${summary.statistics.interval.hi}]`,
      );
      expect(line).toContain("exclusions=none");
    }
    const interactionWithExclusion = structuredClone(assembled.result);
    const firstInteraction = interactionWithExclusion.interactions[0];
    const firstInteractionLane = firstInteraction?.lane_summaries.find(
      (summary) => summary.lane === "stateless-bench",
    );
    if (firstInteractionLane === undefined) {
      throw new Error("missing stateless interaction lane");
    }
    firstInteractionLane.exclusions = [{ lane: "artifact", code: "artifact-mismatch", count: 1 }];
    const interactionMarkdown = renderPolicyMeasurement(
      PolicyMeasurementSchema.parse(interactionWithExclusion),
    );
    expect(interactionMarkdown).toContain("exclusions=artifact:artifact-mismatch=1");
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
    const groupProfile = POLICY_PASS_IDS.length + 1 + 3;
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
      if (row.profileIndex === 1 || row.profileIndex === groupProfile) continue;
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
    expect(benefit).toMatchObject({
      identity: "bench:seeded-01:blocking-fn:label-0",
      group_comparison: {
        pass_ids: [...POLICY_MEASUREMENT_INTERACTIONS[3]],
        artifact: assembled.result.interactions[3]?.artifact,
      },
    });
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

  test("publishes all 30 paired case effects and their complete statistical Markdown dossier", () => {
    // This is a closed 30-case canonical Bench stack, not a synthetic statistics object. The
    // singleton profile has 16 clean cases with loss and 14 seeded cases without loss on every
    // repeat, so both the 90 raw effects and the collapsed 30-case statistics stay non-vacuous.
    const real = materializeRealBenchFixture({ nestedBenchBundle: true, benchSingletonLoss: true });
    const output = join(real.fixture.root, real.prereg.outputs.attempt_dir);
    chmodSync(output, 0o700);
    expect(runRealPolicyStats(real)).toMatchObject({ exitCode: 0 });

    const marker = JSON.parse(readFileSync(join(output, "complete.json"), "utf8")) as {
      result: { ref: string };
      outputs: { report_md: { ref: string } };
    };
    const result = PolicyMeasurementSchema.parse(
      JSON.parse(readFileSync(join(output, marker.result.ref), "utf8")),
    );
    const markdown = readFileSync(join(output, marker.outputs.report_md.ref), "utf8");
    const pass = result.passes.find((row) => row.pass_id === "evidence.fact-location");
    const summary = pass?.evidence.lane_summaries.find((row) => row.lane === "stateless-bench");
    if (summary === undefined) throw new Error("missing real 30-case Bench summary");
    expect(summary.limitations).toEqual([
      "case-effects-are-opportunity-conditioned",
      "precision-denominator-unavailable",
      "recall-denominator-unavailable",
    ]);
    const statistics = summary.statistics as unknown as {
      raw_effects: number[];
      case_effects: Array<{
        case_id: string;
        repeat: number;
        error_reduction: number;
        baseline_dossier: { ref: string; sha256: string };
        ablated_dossier: { ref: string; sha256: string };
      }>;
      mean_error_reduction: number;
      median_error_reduction: number;
      repeat_directions: Array<{ repeat: number; mean_error_reduction: number; direction: string }>;
      error_components: {
        blocking_fp: { baseline: number; ablated: number; delta: number };
        blocking_fn: { baseline: number; ablated: number; delta: number };
      };
      precision_delta: { baseline: number | null; ablated: number | null; delta: number | null };
      recall_delta: { baseline: number | null; ablated: number | null; delta: number | null };
      blocking_count_delta: { baseline: number; ablated: number; delta: number };
      severity_deltas: Record<string, { baseline: number; ablated: number; delta: number }>;
      verdict_deltas: Record<string, { baseline: number; ablated: number; delta: number }>;
      interval: { lo: number; hi: number };
      p_value: number;
      adjusted_p_value: number;
    };

    // Removing case-level persistence, collapsing it to three repeat means, or omitting either
    // source dossier must make this assertion fail.
    expect(Array.isArray(statistics.case_effects)).toBe(true);
    expect(statistics.case_effects).toHaveLength(90);
    expect(statistics.raw_effects).toEqual([
      ...Array.from({ length: 48 }, () => 1),
      ...Array.from({ length: 42 }, () => 0),
    ]);
    expect(statistics.mean_error_reduction).toBe(8 / 15);
    expect(statistics.median_error_reduction).toBe(1);
    expect(statistics.repeat_directions).toEqual([
      { repeat: 1, mean_error_reduction: 8 / 15, direction: "positive" },
      { repeat: 2, mean_error_reduction: 8 / 15, direction: "positive" },
      { repeat: 3, mean_error_reduction: 8 / 15, direction: "positive" },
    ]);
    expect(statistics.error_components).toEqual({
      blocking_fp: { baseline: 0, ablated: 48, delta: 48 },
      blocking_fn: { baseline: 42, ablated: 42, delta: 0 },
    });
    // The canonical fixture has only truth-effect counts, not per-result TP/FP/FN denominators,
    // so precision and recall are explicitly unavailable rather than inferred from truth effects.
    expect(statistics.precision_delta).toEqual({ baseline: null, ablated: null, delta: null });
    expect(statistics.recall_delta).toEqual({ baseline: null, ablated: null, delta: null });
    expect(statistics.blocking_count_delta).toEqual({ baseline: 0, ablated: 90, delta: 90 });
    expect(statistics.severity_deltas).toEqual({
      critical: { baseline: 0, ablated: 0, delta: 0 },
      warn: { baseline: 0, ablated: 90, delta: 90 },
      info: { baseline: 90, ablated: 0, delta: -90 },
    });
    expect(statistics.verdict_deltas).toEqual({
      pass: { baseline: 90, ablated: 0, delta: -90 },
      soft_pass: { baseline: 0, ablated: 90, delta: 90 },
      fail: { baseline: 0, ablated: 0, delta: 0 },
    });
    for (const effect of statistics.case_effects) {
      expect(markdown).toContain(
        `case=${effect.case_id}; repeat=${effect.repeat}; error reduction=${effect.error_reduction}; baseline dossier=\`${effect.baseline_dossier.ref}\` (${effect.baseline_dossier.sha256}); ablated dossier=\`${effect.ablated_dossier.ref}\` (${effect.ablated_dossier.sha256})`,
      );
    }
    expect(markdown).toContain(`Raw effects: ${statistics.raw_effects.join(", ")}`);
    expect(markdown).toContain(
      `Raw p-value: ${statistics.p_value}; adjusted p-value: ${statistics.adjusted_p_value}; 95% interval: [${statistics.interval.lo}, ${statistics.interval.hi}]`,
    );
    expect(markdown).toContain(
      "limitations=case-effects-are-opportunity-conditioned,precision-denominator-unavailable,recall-denominator-unavailable",
    );
    expect(markdown).toContain("Mean paired error reduction: 0.5333333333333333");
    expect(markdown).toContain("Median paired error reduction: 1");
    expect(markdown).toContain(
      "Repeat directions: repeat 1=positive (mean=0.5333333333333333), repeat 2=positive (mean=0.5333333333333333), repeat 3=positive (mean=0.5333333333333333)",
    );
    expect(markdown).toContain(
      "Error components FP baseline/ablated/delta=0/48/48; FN baseline/ablated/delta=42/42/0",
    );
    expect(markdown).toContain(
      "Precision baseline/ablated/delta=none/none/none; recall baseline/ablated/delta=none/none/none",
    );
    expect(markdown).toContain("Blocking count baseline/ablated/delta=0/90/90");
    expect(markdown).toContain("Severity deltas critical=0/0/0; warn=0/90/90; info=90/0/-90");
    expect(markdown).toContain("Verdict deltas pass=90/0/-90; soft-pass=0/90/90; fail=0/0/0");
  }, 120_000);

  test("publishes finite precision and recall deltas from non-zero paired case denominators", () => {
    // This uses the same nested authoritative 30-case stack, but supplies CaseResult counts with
    // non-zero TP/FP/FN denominators on both sides of the singleton comparison. A null-only
    // fixture would not prove either calculation or Markdown parity.
    const real = materializeRealBenchFixture({
      nestedBenchBundle: true,
      benchSingletonLoss: true,
      benchFiniteRates: true,
    });
    const output = join(real.fixture.root, real.prereg.outputs.attempt_dir);
    chmodSync(output, 0o700);
    expect(runRealPolicyStats(real)).toMatchObject({ exitCode: 0 });

    const marker = JSON.parse(readFileSync(join(output, "complete.json"), "utf8")) as {
      result: { ref: string };
      outputs: { report_md: { ref: string } };
    };
    const result = PolicyMeasurementSchema.parse(
      JSON.parse(readFileSync(join(output, marker.result.ref), "utf8")),
    );
    const markdown = readFileSync(join(output, marker.outputs.report_md.ref), "utf8");
    const pass = result.passes.find((row) => row.pass_id === "evidence.fact-location");
    const summary = pass?.evidence.lane_summaries.find((row) => row.lane === "stateless-bench");
    if (summary === undefined) throw new Error("missing finite-rate Bench summary");

    expect(summary.statistics.precision_delta).toEqual({
      baseline: 1,
      ablated: 1 / 2,
      delta: -1 / 2,
    });
    expect(summary.statistics.recall_delta).toEqual({
      baseline: 2 / 3,
      ablated: 1 / 3,
      delta: -1 / 3,
    });
    expect(markdown).toContain(
      "Precision baseline/ablated/delta=1/0.5/-0.5; recall baseline/ablated/delta=0.6666666666666666/0.3333333333333333/-0.3333333333333333",
    );
  }, 120_000);

  test("reverifies a nested parseable Bench and Rig publication from copied sources", () => {
    const real = materializeRealBenchFixture({ nestedBenchBundle: true });
    chmodSync(join(real.fixture.root, real.prereg.outputs.attempt_dir), 0o700);
    const result = runRealPolicyStats(real);

    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
  }, 120_000);

  test("publishes a nonempty Dogfood manifest with audit and trace refs owned only by labeled passes", () => {
    const real = materializeRealBenchFixture({
      nestedBenchBundle: true,
      dogfoodUnrelatedEntry: true,
    });
    const output = join(real.fixture.root, real.prereg.outputs.attempt_dir);
    chmodSync(output, 0o700);

    const result = runRealPolicyStats(real);
    expect(result, result.stderr).toMatchObject({ exitCode: 0 });
    expect(__policyStatsTest.verifyPublishedPolicyBundle(output)).toBe(true);

    const sourceRefs = real.dogfoodSourceRefs;
    if (sourceRefs === undefined) throw new Error("missing nonempty Dogfood source refs");
    const parsed = PolicyMeasurementSchema.parse(
      JSON.parse(readFileSync(join(output, "result.json"), "utf8")),
    );
    const unowned = parsed.passes.find((pass) => pass.pass_id === "judgment.hypothetical");
    const owned = parsed.passes.find((pass) => pass.pass_id === "evidence.fact-location");
    const unownedDogfood = unowned?.evidence.lane_summaries.find((row) => row.lane === "dogfood");
    const ownedDogfood = owned?.evidence.lane_summaries.find((row) => row.lane === "dogfood");
    if (unownedDogfood === undefined || ownedDogfood === undefined) {
      throw new Error("missing Dogfood lane summaries");
    }
    expect(unownedDogfood.raw_evidence_refs).toEqual(
      [real.prereg.dogfood.input_manifest_ref, real.prereg.dogfood.attestation_ref].sort(),
    );
    expect(ownedDogfood.raw_evidence_refs).toEqual(
      expect.arrayContaining([
        real.prereg.dogfood.input_manifest_ref,
        real.prereg.dogfood.attestation_ref,
        ...sourceRefs,
      ]),
    );
    for (const ref of sourceRefs) expect(unownedDogfood.raw_evidence_refs).not.toContain(ref);
  }, 120_000);

  test("rejects a marker-rebound Markdown drift from the verified JSON projection", () => {
    const real = materializeRealBenchFixture({ nestedBenchBundle: true });
    const output = join(real.fixture.root, real.prereg.outputs.attempt_dir);
    chmodSync(output, 0o700);
    expect(runRealPolicyStats(real)).toMatchObject({ exitCode: 0 });
    expect(__policyStatsTest.verifyPublishedPolicyBundle(output)).toBe(true);

    rewritePublishedReport(output, (markdown) => `${markdown}unbound report drift\n`);

    expect(__policyStatsTest.verifyPublishedPolicyBundle(output)).toBe(false);
  }, 120_000);

  test("rejects a self-consistent published Bench C5 statistic substitution", () => {
    const real = materializeRealBenchFixture({ nestedBenchBundle: true });
    const output = join(real.fixture.root, real.prereg.outputs.attempt_dir);
    chmodSync(output, 0o700);
    expect(runRealPolicyStats(real)).toMatchObject({ exitCode: 0 });
    expect(__policyStatsTest.verifyPublishedPolicyBundle(output)).toBe(true);

    rewritePublishedProjection(output, (result) => {
      const pass = (result.passes as Array<Record<string, unknown>>).find(
        (row) => row.pass_id === "judgment.hypothetical",
      );
      const evidence = pass?.evidence as Record<string, unknown> | undefined;
      const summary = (
        evidence?.lane_summaries as Array<Record<string, unknown>> | undefined
      )?.find((row) => row.lane === "stateless-bench");
      if (pass === undefined || evidence === undefined || summary === undefined) {
        throw new Error("missing no-opportunity Bench C5 fixture");
      }
      const substituted = {
        ...(summary.statistics as Record<string, unknown>),
        case_effects: [],
        raw_effects: [123],
        mean_error_reduction: 123,
        median_error_reduction: 123,
        repeat_directions: [],
      };
      summary.statistics = substituted;
      evidence.statistics = substituted;
    });

    expect(__policyStatsTest.verifyPublishedPolicyBundle(output)).toBe(false);
  }, 120_000);

  test("rejects a marker-rebound Holm adjustment detached from verified Bench effects", () => {
    const real = materializeRealBenchFixture({ nestedBenchBundle: true, benchSingletonLoss: true });
    const output = join(real.fixture.root, real.prereg.outputs.attempt_dir);
    chmodSync(output, 0o700);
    expect(runRealPolicyStats(real)).toMatchObject({ exitCode: 0 });
    expect(__policyStatsTest.verifyPublishedPolicyBundle(output)).toBe(true);

    rewritePublishedProjection(output, (result) => {
      const pass = (result.passes as Array<Record<string, unknown>>).find(
        (row) => row.pass_id === "evidence.fact-location",
      );
      const evidence = pass?.evidence as Record<string, unknown> | undefined;
      const summary = (
        evidence?.lane_summaries as Array<Record<string, unknown>> | undefined
      )?.find((row) => row.lane === "stateless-bench");
      const statistics = summary?.statistics as Record<string, unknown> | undefined;
      if (evidence === undefined || summary === undefined || statistics === undefined) {
        throw new Error("missing published corrected Bench lane");
      }
      expect(statistics.p_value).toBeLessThan(1);
      statistics.adjusted_p_value = 1;
      evidence.statistics = statistics;
    });

    expect(__policyStatsTest.verifyPublishedPolicyBundle(output)).toBe(false);
  }, 120_000);

  test("rejects a self-consistent published Rig C5 statistic substitution", () => {
    const real = materializeRealBenchFixture({ nestedBenchBundle: true });
    const output = join(real.fixture.root, real.prereg.outputs.attempt_dir);
    chmodSync(output, 0o700);
    expect(runRealPolicyStats(real)).toMatchObject({ exitCode: 0 });
    expect(__policyStatsTest.verifyPublishedPolicyBundle(output)).toBe(true);

    rewritePublishedProjection(output, (result) => {
      const pass = (result.passes as Array<Record<string, unknown>>).find(
        (row) => row.pass_id === "history.fp-signature",
      );
      const evidence = pass?.evidence as Record<string, unknown> | undefined;
      const summary = (
        evidence?.lane_summaries as Array<Record<string, unknown>> | undefined
      )?.find((row) => row.lane === "stateful-rig");
      if (evidence === undefined || summary === undefined) {
        throw new Error("missing published Rig C5 lane");
      }
      const substituted = {
        ...(summary.statistics as Record<string, unknown>),
        raw_effects: [123],
        mean_error_reduction: 123,
        median_error_reduction: 123,
      };
      summary.statistics = substituted;
      evidence.statistics = substituted;
    });

    expect(__policyStatsTest.verifyPublishedPolicyBundle(output)).toBe(false);
  }, 120_000);

  test("rejects a self-consistent published Dogfood declined substitution", () => {
    const real = materializeRealBenchFixture({ nestedBenchBundle: true });
    const output = join(real.fixture.root, real.prereg.outputs.attempt_dir);
    chmodSync(output, 0o700);
    expect(runRealPolicyStats(real)).toMatchObject({ exitCode: 0 });
    expect(__policyStatsTest.verifyPublishedPolicyBundle(output)).toBe(true);

    rewritePublishedDogfoodSnapshot(output, (snapshot) => {
      snapshot.declined = 1;
      snapshot.exclusions = { declined: 1 };
    });
    rewritePublishedProjection(output, (result) => {
      for (const pass of result.passes as Array<Record<string, unknown>>) {
        const evidence = pass.evidence as Record<string, unknown> | undefined;
        const dogfood = (
          evidence?.lane_summaries as Array<Record<string, unknown>> | undefined
        )?.find((summary) => summary.lane === "dogfood");
        if (evidence === undefined || dogfood === undefined) {
          throw new Error("missing published Dogfood lane fixture");
        }
        const exclusions = [{ lane: "dogfood", code: "declined", count: 1 }];
        evidence.exclusions = exclusions;
        dogfood.exclusions = exclusions;
      }
    });

    expect(__policyStatsTest.verifyPublishedPolicyBundle(output)).toBe(false);
  }, 120_000);

  test("rejects a marker-rebound Dogfood trace total detached from the copied snapshot", () => {
    const real = materializeRealBenchFixture({ nestedBenchBundle: true });
    const output = join(real.fixture.root, real.prereg.outputs.attempt_dir);
    chmodSync(output, 0o700);
    expect(runRealPolicyStats(real)).toMatchObject({ exitCode: 0 });
    expect(__policyStatsTest.verifyPublishedPolicyBundle(output)).toBe(true);

    rewritePublishedProjection(output, (result) => {
      const pass = (result.passes as Array<Record<string, unknown>>).find(
        (row) => row.pass_id === "judgment.hypothetical",
      );
      const evidence = pass?.evidence as Record<string, unknown> | undefined;
      const dogfood = (
        evidence?.lane_summaries as Array<Record<string, unknown>> | undefined
      )?.find((summary) => summary.lane === "dogfood");
      const traceTotals = dogfood?.trace_totals as Record<string, number> | undefined;
      if (dogfood === undefined || traceTotals === undefined) {
        throw new Error("missing published Dogfood trace-total fixture");
      }
      traceTotals.applied = (traceTotals.applied ?? 0) + 1;
    });

    const parsed = PolicyMeasurementSchema.safeParse(
      JSON.parse(readFileSync(join(output, "result.json"), "utf8")),
    );
    expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(
      true,
    );
    expect(__policyStatsTest.verifyPublishedPolicyBundle(output)).toBe(false);
  }, 120_000);

  test("rejects a self-consistent published singleton source substitution", () => {
    const real = materializeRealBenchFixture({ nestedBenchBundle: true });
    const output = join(real.fixture.root, real.prereg.outputs.attempt_dir);
    chmodSync(output, 0o700);
    expect(runRealPolicyStats(real)).toMatchObject({ exitCode: 0 });
    expect(__policyStatsTest.verifyPublishedPolicyBundle(output)).toBe(true);

    rewritePublishedResult(output, (result) => {
      const facts = result.identity_evidence as Array<Record<string, unknown>>;
      const stateful = facts.find((row) => row.pass_id === "history.fp-signature");
      if (stateful === undefined) throw new Error("missing stateful singleton identity fixture");
      const singleton = stateful.singleton_inventory as {
        raw_evidence: Array<{ ref: string; sha256: string }>;
        events: Array<{ identity: string; source: { ref: string; sha256: string } }>;
      };
      const event = singleton.events[0];
      const replacement = singleton.raw_evidence.find(
        (binding) => binding.ref !== event?.source.ref,
      );
      if (event === undefined || replacement === undefined)
        throw new Error("missing singleton source substitution fixture");
      event.source = replacement;
      singleton.events = sortSingletonIdentityEvents(singleton.events as never) as never;
      for (const benefit of stateful.beneficial_effects as Array<Record<string, unknown>>) {
        if (benefit.identity !== event.identity) continue;
        benefit.evidence_ref = replacement.ref;
        benefit.singleton_evidence = replacement;
      }
      const pass = (result.passes as Array<Record<string, unknown>>).find(
        (row) => row.pass_id === "history.fp-signature",
      );
      if (pass === undefined) throw new Error("missing stateful singleton pass fixture");
      for (const contribution of (pass.evidence as Record<string, unknown>)
        .unique_contributions as Array<Record<string, unknown>>) {
        if (contribution.identity === event.identity) contribution.evidence = replacement;
      }
    });

    const parsed = PolicyMeasurementSchema.safeParse(
      JSON.parse(readFileSync(join(output, "result.json"), "utf8")),
    );
    expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(
      true,
    );
    expect(__policyStatsTest.verifyPublishedPolicyBundle(output)).toBe(false);
  }, 120_000);

  test("rejects a self-consistent published Rig group source substitution", () => {
    const real = materializeRealBenchFixture({ nestedBenchBundle: true });
    const output = join(real.fixture.root, real.prereg.outputs.attempt_dir);
    chmodSync(output, 0o700);
    expect(runRealPolicyStats(real)).toMatchObject({ exitCode: 0 });
    expect(__policyStatsTest.verifyPublishedPolicyBundle(output)).toBe(true);

    rewritePublishedResult(output, (result) => {
      const interaction = (result.interactions as Array<Record<string, unknown>>)[2];
      if (interaction === undefined) throw new Error("missing Rig group interaction fixture");
      const original = interaction.artifact as { ref: string; sha256: string };
      const inventory = interaction.identity_inventory as {
        raw_evidence: Array<{ ref: string; sha256: string }>;
        events: Array<{ source: { ref: string; sha256: string } }>;
      };
      const replacement = inventory.raw_evidence.find((binding) => binding.ref !== original.ref);
      if (replacement === undefined || inventory.events.length === 0)
        throw new Error("missing Rig group source substitution fixture");
      interaction.artifact = replacement;
      for (const event of inventory.events) event.source = replacement;
      inventory.events = sortIdentityEvents(inventory.events as never) as never;
      for (const facts of result.identity_evidence as Array<Record<string, unknown>>) {
        for (const benefit of facts.beneficial_effects as Array<Record<string, unknown>>) {
          const comparison = benefit.group_comparison as
            | { artifact: { ref: string; sha256: string } }
            | undefined;
          if (comparison?.artifact.ref === original.ref) comparison.artifact = replacement;
        }
      }
      for (const pass of result.passes as Array<Record<string, unknown>>) {
        const evidence = pass.evidence as Record<string, unknown>;
        for (const contribution of evidence.unique_contributions as Array<
          Record<string, unknown>
        >) {
          const comparison = contribution.group_comparison as {
            artifact: { ref: string; sha256: string };
          };
          if (comparison.artifact.ref === original.ref) comparison.artifact = replacement;
        }
      }
    });

    const parsed = PolicyMeasurementSchema.safeParse(
      JSON.parse(readFileSync(join(output, "result.json"), "utf8")),
    );
    expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(
      true,
    );
    expect(__policyStatsTest.verifyPublishedPolicyBundle(output)).toBe(false);
  }, 120_000);

  test("rejects a self-consistent published Rig manifest source substitution", () => {
    const real = materializeRealBenchFixture({ nestedBenchBundle: true });
    const output = join(real.fixture.root, real.prereg.outputs.attempt_dir);
    chmodSync(output, 0o700);
    expect(runRealPolicyStats(real)).toMatchObject({ exitCode: 0 });
    expect(__policyStatsTest.verifyPublishedPolicyBundle(output)).toBe(true);

    const markerPath = join(output, "complete.json");
    const marker = JSON.parse(readFileSync(markerPath, "utf8")) as {
      outputs: { rig_bundle: { ref: string; sha256: string } };
    };
    const rigPath = join(output, marker.outputs.rig_bundle.ref);
    const rig = JSON.parse(readFileSync(rigPath, "utf8")) as {
      scenario_manifest: { ref: string; sha256: string };
      artifacts: Array<{ ref: string; sha256: string; kind: string }>;
    };
    const original = rig.scenario_manifest;
    const replacement = rig.artifacts.find(
      (binding) => binding.kind === "rig" && binding.ref !== original.ref,
    );
    if (replacement === undefined) throw new Error("missing Rig manifest substitution fixture");
    const replacementBinding = { ref: replacement.ref, sha256: replacement.sha256 };
    rig.scenario_manifest = replacementBinding;
    const rigText = canonicalJson(rig);
    writeFileSync(rigPath, rigText, { mode: 0o600 });
    marker.outputs.rig_bundle.sha256 = sha256(rigText);
    writeFileSync(markerPath, canonicalJson(marker), { mode: 0o600 });

    rewritePublishedResult(output, (result) => {
      for (const facts of result.identity_evidence as Array<Record<string, unknown>>) {
        const inventory = facts.singleton_inventory as {
          events: Array<{ source: { ref: string; sha256: string } }>;
        };
        for (const event of inventory.events) {
          if (event.source.ref === original.ref) event.source = replacementBinding;
        }
        inventory.events = sortSingletonIdentityEvents(inventory.events as never) as never;
        for (const harm of facts.ground_truth_harms as Array<Record<string, unknown>>) {
          if (harm.evidence_ref === original.ref) harm.evidence_ref = replacement.ref;
        }
        for (const benefit of facts.beneficial_effects as Array<Record<string, unknown>>) {
          if (benefit.evidence_ref === original.ref) {
            benefit.evidence_ref = replacement.ref;
            benefit.singleton_evidence = replacementBinding;
          }
          const comparison = benefit.group_comparison as
            | { artifact: { ref: string; sha256: string } }
            | undefined;
          if (comparison?.artifact.ref === original.ref) comparison.artifact = replacementBinding;
        }
      }
      for (const interaction of result.interactions as Array<Record<string, unknown>>) {
        if ((interaction.artifact as { ref: string }).ref !== original.ref) continue;
        interaction.artifact = replacementBinding;
        const inventory = interaction.identity_inventory as {
          events: Array<{ source: { ref: string; sha256: string } }>;
        };
        for (const event of inventory.events) event.source = replacementBinding;
        inventory.events = sortIdentityEvents(inventory.events as never) as never;
      }
      for (const pass of result.passes as Array<Record<string, unknown>>) {
        const evidence = pass.evidence as Record<string, unknown>;
        for (const contribution of evidence.unique_contributions as Array<
          Record<string, unknown>
        >) {
          if ((contribution.evidence as { ref: string }).ref === original.ref)
            contribution.evidence = replacementBinding;
          const comparison = contribution.group_comparison as {
            artifact: { ref: string; sha256: string };
          };
          if (comparison.artifact.ref === original.ref) comparison.artifact = replacementBinding;
        }
      }
    });

    const parsed = PolicyMeasurementSchema.safeParse(
      JSON.parse(readFileSync(join(output, "result.json"), "utf8")),
    );
    expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(
      true,
    );
    expect(__policyStatsTest.verifyPublishedPolicyBundle(output)).toBe(false);
  }, 120_000);

  test("rejects a self-consistent published Bench singleton source substitution", () => {
    const real = materializeRealBenchFixture({ nestedBenchBundle: true, benchSingletonLoss: true });
    const output = join(real.fixture.root, real.prereg.outputs.attempt_dir);
    chmodSync(output, 0o700);
    expect(runRealPolicyStats(real)).toMatchObject({ exitCode: 0 });

    rewritePublishedResult(output, (result) => {
      const facts = result.identity_evidence as Array<Record<string, unknown>>;
      const stateless = facts.find((row) => row.pass_id === "evidence.fact-location");
      if (stateless === undefined) throw new Error("missing stateless singleton identity fixture");
      const singleton = stateless.singleton_inventory as {
        raw_evidence: Array<{ ref: string; sha256: string }>;
        events: Array<{ identity: string; source: { ref: string; sha256: string } }>;
      };
      const event = singleton.events[0];
      const replacement = singleton.raw_evidence.find(
        (binding) => binding.ref !== event?.source.ref,
      );
      if (event === undefined || replacement === undefined)
        throw new Error("missing Bench singleton source substitution fixture");
      event.source = replacement;
      singleton.events = sortSingletonIdentityEvents(singleton.events as never) as never;
      for (const benefit of stateless.beneficial_effects as Array<Record<string, unknown>>) {
        if (benefit.identity !== event.identity) continue;
        benefit.evidence_ref = replacement.ref;
        benefit.singleton_evidence = replacement;
      }
      const pass = (result.passes as Array<Record<string, unknown>>).find(
        (row) => row.pass_id === "evidence.fact-location",
      );
      if (pass === undefined) throw new Error("missing stateless singleton pass fixture");
      for (const contribution of (pass.evidence as Record<string, unknown>)
        .unique_contributions as Array<Record<string, unknown>>) {
        if (contribution.identity === event.identity) contribution.evidence = replacement;
      }
    });

    const parsed = PolicyMeasurementSchema.safeParse(
      JSON.parse(readFileSync(join(output, "result.json"), "utf8")),
    );
    expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(
      true,
    );
    expect(__policyStatsTest.verifyPublishedPolicyBundle(output)).toBe(false);
  }, 600_000);

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
