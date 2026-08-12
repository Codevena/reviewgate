import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../../src/audit/canonical.ts";
import { buildBenchConfig } from "../../src/bench/runner.ts";
import {
  __benchPolicyTest,
  runBenchPolicy,
  validatePolicyEffectiveConfiguration,
  verifyPolicyBenchCaseAuthority,
} from "../../src/cli/commands/bench.ts";
import { POLICY_PASS_IDS } from "../../src/core/policy/catalog.ts";
import { POLICY_MEASUREMENT_INTERACTIONS } from "../../src/core/policy/measurement-contract.ts";
import type {
  ProviderAdapter,
  ProviderConfig,
  ReviewResult,
} from "../../src/providers/adapter-base.ts";
import type { CaseResult } from "../../src/schemas/bench-result.ts";
import { PolicyMeasurementPreregistrationSchema } from "../../src/schemas/policy-measurement-preregistration.ts";
import { RG_VERSION } from "../../src/version.ts";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function okReview(reviewerId: string): ReviewResult {
  return {
    reviewerId,
    verdict: "PASS",
    findings: [],
    usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
    durationMs: 1,
    exitCode: 0,
    rawEventsPath: "",
    rawText: "",
    status: "ok",
  };
}

interface MutablePolicyPreregistration {
  roster: {
    reviewers: Array<{
      openrouter_provider: {
        only?: string[];
        order?: string[];
        allowFallbacks?: boolean;
      } | null;
    }>;
  };
  execution: {
    reviewer_max_attempts: number;
    critic_max_attempts: number;
    max_output_tokens: number;
  };
  analysis: {
    candidate_rules: string;
    vetoes: string[];
    correction: { singleton: string };
  };
  outputs: {
    attempt_dir: string;
    bench_bundle: string;
    rig_bundle: string;
    dogfood_snapshot: string;
    result_json: string;
    report_md: string;
  };
  profiles: { singleton: string[][]; interactions: string[][] };
}

function openRouterRoute(config: ReturnType<typeof buildBenchConfig>) {
  const route = config.providers.openrouter?.openrouterProvider;
  if (route === undefined) throw new Error("missing OpenRouter route fixture");
  return route;
}

function reviewerRoute(value: MutablePolicyPreregistration) {
  const route = value.roster.reviewers[0]?.openrouter_provider;
  if (route === undefined || route === null) throw new Error("missing reviewer route fixture");
  return route;
}

describe("runBenchPolicy", () => {
  test("captures two cases across three repeats once and fully replays the closed 23 profiles", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-policy-schedule-"));
    const promptFile = join(dir, "prompt.txt");
    const diffPath = join(dir, "diff.patch");
    const findingsPath = join(dir, "findings.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(promptFile, "review");
    writeFileSync(diffPath, "diff");
    const calls = { preflight: 0, review: 0, complete: 0 };
    const live: ProviderAdapter = {
      id: "codex",
      async preflight() {
        calls.preflight += 1;
        return { available: true, version: "stub", authMode: "oauth", error: null };
      },
      async review(input) {
        calls.review += 1;
        return okReview(input.reviewerId);
      },
      async complete() {
        calls.complete += 1;
        return '{"verdicts":[]}';
      },
    };
    const config = buildBenchConfig({ providers: ["codex"] });
    const providerConfig = config.providers.codex as ProviderConfig | undefined;
    if (providerConfig === undefined) throw new Error("missing codex config");

    const scheduled = await __benchPolicyTest.executeCapturedProfileSchedule({
      profiles: __benchPolicyTest.profiles,
      underlying: { codex: live },
      async execute(profile, adapters, _live, _index, context) {
        const adapter = adapters.codex;
        if (adapter === undefined) throw new Error("missing scheduled adapter");
        for (let repeat = 1; repeat <= 3; repeat += 1) {
          context.repeat = repeat;
          await adapter.preflight(providerConfig);
          for (const caseId of ["case-a", "case-b"]) {
            await adapter.review({
              promptFile,
              workingDir: dir,
              findingsPath,
              persona: "security",
              diffPath,
              cfg: providerConfig,
              reviewerId: caseId,
            });
            await adapter.complete?.(`critic:${caseId}`, {
              model: "gpt-5.5",
              auth: "oauth",
            });
          }
        }
        return { id: profile.id, ablated: [...profile.ablatedPassIds] };
      },
    });

    expect(scheduled.values).toHaveLength(23);
    expect(scheduled.values[0]?.ablated).toEqual([]);
    expect(scheduled.values.slice(1, 19).map((row) => row.ablated)).toEqual(
      POLICY_PASS_IDS.map((passId) => [passId]),
    );
    expect(scheduled.values.slice(19).map((row) => row.ablated)).toEqual(
      POLICY_MEASUREMENT_INTERACTIONS.map((group) => [...group]),
    );
    expect(calls).toEqual({ preflight: 3, review: 6, complete: 6 });
    expect(scheduled.capture.entries).toHaveLength(12);
    expect(
      [1, 2, 3].map(
        (repeat) => scheduled.capture.entries.filter((entry) => entry.repeat === repeat).length,
      ),
    ).toEqual([4, 4, 4]);
    expect(scheduled.capture.preflights.get("codex")?.map((entry) => entry.repeat)).toEqual([
      1, 2, 3,
    ]);
    const manifests = ([1, 2, 3] as const).map((repeat) =>
      __benchPolicyTest.responseManifestForRepeat(scheduled.capture, repeat),
    );
    for (const [index, manifest] of manifests.entries()) {
      const repeat = index + 1;
      expect(manifest.preflights?.map((entry) => entry.repeat)).toEqual([repeat]);
      expect(manifest.entries.every((entry) => entry.repeat === repeat)).toBe(true);
    }
    expect(
      new Set(manifests.map((manifest) => sha256(canonicalJson(manifest))).values()).size,
    ).toBe(3);
  });

  test("exports the preregistered policy command", () => {
    expect(typeof runBenchPolicy).toBe("function");
  });

  test("rejects a self-consistent authority row when its truth block is tampered", () => {
    const truth = { expected_label_count: 0, findings: [], fn_label_indexes: [] };
    const row = {
      id: "clean-01",
      repeat: 1,
      content_hash: "a".repeat(64),
      policy_truth: truth,
      policy_trace: { authoritative: true },
    } as unknown as CaseResult;
    const authority = {
      case_id: row.id,
      repeat: 1 as const,
      content_sha256: row.content_hash,
      policy_truth_sha256: sha256(canonicalJson(truth)),
    };
    expect(verifyPolicyBenchCaseAuthority(row, authority)).toBe(true);
    row.policy_truth = { expected_label_count: 1, findings: [], fn_label_indexes: [0] };
    expect(verifyPolicyBenchCaseAuthority(row, authority)).toBe(false);
  });

  test("rejects an existing named output before reading preregistration or constructing adapters", async () => {
    const root = mkdtempSync(join(tmpdir(), "rg-policy-existing-"));
    const out = "bench/results/policy-measurement/attempt/existing.json";
    mkdirSync(join(root, "bench/results/policy-measurement/attempt"), { recursive: true });
    writeFileSync(join(root, out), "sentinel");
    let factories = 0;
    const result = await runBenchPolicy({
      repoRoot: root,
      preregistration: "missing.json",
      out,
      adapterFactory() {
        factories += 1;
        return {};
      },
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("output already exists");
    expect(factories).toBe(0);
    expect(readFileSync(join(root, out), "utf8")).toBe("sentinel");
  });

  test("fails when a replay leaves one response unconsumed or changes request order/identity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-policy-consumption-"));
    const promptFile = join(dir, "prompt.txt");
    const diffPath = join(dir, "diff.patch");
    writeFileSync(promptFile, "review");
    writeFileSync(diffPath, "diff");
    const config = buildBenchConfig({ providers: ["codex"] });
    const cfg = config.providers.codex as ProviderConfig | undefined;
    if (cfg === undefined) throw new Error("missing codex config");
    const adapter: ProviderAdapter = {
      id: "codex",
      async preflight() {
        return { available: true, version: "stub", authMode: "oauth", error: null };
      },
      async review(input) {
        return okReview(input.reviewerId);
      },
    };
    const execute =
      (changeRequest: boolean) =>
      async (
        profile: (typeof __benchPolicyTest.profiles)[number],
        adapters: Partial<Record<"codex", ProviderAdapter>>,
        _live: boolean,
        index: number,
      ) => {
        const current = adapters.codex;
        if (current === undefined) throw new Error("missing adapter");
        const calls = changeRequest ? 1 : index === 0 ? 2 : 1;
        for (let call = 0; call < calls; call += 1) {
          await current.review({
            promptFile,
            ...(changeRequest && index > 0 ? { promptText: "changed-request" } : {}),
            workingDir: dir,
            findingsPath: join(dir, "findings.json"),
            persona: "security",
            diffPath,
            cfg,
            reviewerId: `case-${call}`,
          });
        }
        return profile.id;
      };
    await expect(
      __benchPolicyTest.executeCapturedProfileSchedule({
        profiles: __benchPolicyTest.profiles.slice(0, 2),
        underlying: { codex: adapter },
        execute: execute(false),
      }),
    ).rejects.toThrow(/consumed 1\/2/);
    await expect(
      __benchPolicyTest.executeCapturedProfileSchedule({
        profiles: __benchPolicyTest.profiles.slice(0, 2),
        underlying: { codex: adapter },
        execute: execute(true),
      }),
    ).rejects.toThrow(/match baseline/);
  });

  test("validates the literal 16-clean/14-seeded corpus and all protocol fields before adapter construction", async () => {
    const root = mkdtempSync(join(tmpdir(), "rg-policy-prereg-"));
    const corpus = join(root, "bench", "corpus", "policy-measurement");
    const content: Record<string, string> = {};
    for (const [kind, count] of [
      ["clean", 16],
      ["seeded", 14],
    ] as const) {
      for (let index = 1; index <= count; index += 1) {
        const id = `${kind}-${String(index).padStart(2, "0")}`;
        const caseDir = join(corpus, id);
        mkdirSync(caseDir, { recursive: true });
        const caseJson = JSON.stringify({
          schema: "reviewgate.bench.case.v1",
          id,
          kind: kind === "clean" ? "clean" : "seeded-bug",
          language: "ts",
          expected:
            kind === "clean"
              ? []
              : [{ tag: "bug", file: `src/${id}.ts`, line: 1, min_severity: "WARN" }],
          allowed: [],
          strict_region: true,
          source: "hand-written",
        });
        const diff = [
          `diff --git a/src/${id}.ts b/src/${id}.ts`,
          "new file mode 100644",
          "--- /dev/null",
          `+++ b/src/${id}.ts`,
          "@@ -0,0 +1 @@",
          "+export const value = 1;",
          "",
        ].join("\n");
        writeFileSync(join(caseDir, "case.json"), caseJson);
        writeFileSync(join(caseDir, "diff.patch"), diff);
        content[`cases/${id}.json`] = sha256(`${sha256(caseJson)}${sha256(diff)}`);
      }
    }
    const attempt = "attempt-test";
    const attemptRoot = `bench/results/policy-measurement/${attempt}`;
    const preregRef = "bench/preregistrations/policy.json";
    const out = `${attemptRoot}/bench.json`;
    const preregistration = PolicyMeasurementPreregistrationSchema.parse({
      schema: "reviewgate.policy-measurement.preregistration.v1",
      registered_at: "2026-08-12T09:00:00.000Z",
      release: RG_VERSION,
      attempt,
      source: {
        ref: "HEAD",
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
        manifest_sha256: sha256(JSON.stringify(content)),
        content_sha256: content,
      },
      roster: {
        reviewers: [
          {
            provider: "openrouter",
            model: "openai/gpt-5",
            persona: "security",
            openrouter_provider: {
              only: ["openai"],
              order: ["openai"],
              allowFallbacks: false,
            },
          },
        ],
        critic: {
          provider: "codex",
          model: "gpt-5.5",
          persona: "fp-filter",
          openrouter_provider: null,
        },
        substitution_allowed: false,
      },
      execution: { reviewer_max_attempts: 1, critic_max_attempts: 1, max_output_tokens: 4096 },
      profiles: {
        singleton: POLICY_PASS_IDS.map((passId) => [passId]),
        interactions: POLICY_MEASUREMENT_INTERACTIONS.map((group) => [...group]),
      },
      stateful: {
        manifest_ref: "rig/policy-scenarios.json",
        manifest_sha256: "a".repeat(64),
        min_sequences_per_pass: 3,
        min_opportunity_turns: 2,
      },
      dogfood: {
        since: "2026-08-01T00:00:00.000Z",
        until: "2026-08-12T09:00:00.000Z",
        input_manifest_ref: "bench/inputs/dogfood.json",
        input_manifest_sha256: "b".repeat(64),
        attestation_ref: "bench/attestations/dogfood.json",
        attestation_sha256: "c".repeat(64),
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
        maximum_provider_calls: 1000,
        maximum_failed_fraction: 0,
        reviewer_coverage: 1,
        eligible_critic_coverage: 1,
        immutable_artifacts: true,
        no_variant_provider_calls: true,
      },
      outputs: {
        attempt_dir: attemptRoot,
        bench_bundle: out,
        rig_bundle: `${attemptRoot}/rig.json`,
        dogfood_snapshot: `${attemptRoot}/dogfood.json`,
        result_json: `${attemptRoot}/result.json`,
        report_md: `${attemptRoot}/report.md`,
      },
      commands: {
        bench: ["dist/reviewgate", "bench", "policy", "--preregistration", preregRef, "--out", out],
        stats: ["dist/reviewgate", "stats", "policy"],
      },
      rerun_policy: {
        failed_attempts_are_preserved: true,
        overwrite_allowed: false,
        favorable_repeat_selection_allowed: false,
      },
    });
    const effective = buildBenchConfig({
      providers: ["openrouter"],
      providerModels: { openrouter: "openai/gpt-5", codex: "gpt-5.5" },
      suppressors: { critic: "codex" },
      criticModel: "gpt-5.5",
      maxOutputTokens: 4096,
    });
    if (effective.providers.openrouter === undefined) throw new Error("missing OpenRouter config");
    effective.providers.openrouter.openrouterProvider = {
      only: ["openai"],
      order: ["openai"],
      allowFallbacks: false,
    };
    const runtime = {
      reviewerMaxAttempts: 1,
      criticMaxAttempts: 1,
      maxOutputTokens: 4096,
      out,
    };
    expect(validatePolicyEffectiveConfiguration(preregistration, effective, runtime)).toEqual([]);
    for (const [name, mutate] of [
      [
        "only",
        (config: typeof effective) => {
          openRouterRoute(config).only = ["different"];
        },
      ],
      [
        "order",
        (config: typeof effective) => {
          openRouterRoute(config).order = ["different"];
        },
      ],
      [
        "allowFallbacks",
        (config: typeof effective) => {
          openRouterRoute(config).allowFallbacks = true;
        },
      ],
    ] as const) {
      const changed = structuredClone(effective);
      mutate(changed);
      expect(
        validatePolicyEffectiveConfiguration(preregistration, changed, runtime),
        name,
      ).toContain("reviewer roster/model/persona/route differs");
    }
    expect(
      validatePolicyEffectiveConfiguration(preregistration, effective, {
        ...runtime,
        reviewerMaxAttempts: 2,
      }),
    ).toContain("reviewer-attempt limit differs");
    expect(
      validatePolicyEffectiveConfiguration(preregistration, effective, {
        ...runtime,
        criticMaxAttempts: 2,
      }),
    ).toContain("critic-attempt limit differs");
    expect(
      validatePolicyEffectiveConfiguration(preregistration, effective, {
        ...runtime,
        maxOutputTokens: 2048,
      }),
    ).toContain("output-token ceiling differs");
    expect(
      validatePolicyEffectiveConfiguration(preregistration, effective, {
        ...runtime,
        out: `${attemptRoot}/other.json`,
      }),
    ).toContain("Bench output path differs");
    const preregPath = join(root, preregRef);
    mkdirSync(join(root, "bench", "preregistrations"), { recursive: true });
    const cases: Array<[string, (value: MutablePolicyPreregistration) => void]> = [
      [
        "only route",
        (value) => {
          reviewerRoute(value).only = ["x"];
        },
      ],
      [
        "ordered route",
        (value) => {
          reviewerRoute(value).order?.reverse();
        },
      ],
      [
        "fallback route",
        (value) => {
          reviewerRoute(value).allowFallbacks = true;
        },
      ],
      [
        "reviewer retry",
        (value) => {
          value.execution.reviewer_max_attempts = 2;
        },
      ],
      [
        "critic retry",
        (value) => {
          value.execution.critic_max_attempts = 2;
        },
      ],
      [
        "output tokens",
        (value) => {
          value.execution.max_output_tokens = 2048;
        },
      ],
      [
        "candidate rules",
        (value) => {
          value.analysis.candidate_rules = "changed";
        },
      ],
      ["vetoes", (value) => value.analysis.vetoes.pop()],
      [
        "correction",
        (value) => {
          value.analysis.correction.singleton = "holm-4";
        },
      ],
      [
        "Bench output path",
        (value) => {
          value.outputs.bench_bundle = `${attemptRoot}/other.json`;
        },
      ],
      [
        "attempt output path",
        (value) => {
          value.outputs.attempt_dir = `${attemptRoot}/nested`;
        },
      ],
      [
        "Rig output path",
        (value) => {
          value.outputs.rig_bundle = "bench/results/outside/rig.json";
        },
      ],
      [
        "dogfood output path",
        (value) => {
          value.outputs.dogfood_snapshot = "bench/results/outside/dogfood.json";
        },
      ],
      [
        "result output path",
        (value) => {
          value.outputs.result_json = "bench/results/outside/result.json";
        },
      ],
      [
        "report output path",
        (value) => {
          value.outputs.report_md = "bench/results/outside/report.md";
        },
      ],
      ["singleton inventory", (value) => value.profiles.singleton.pop()],
      ["group inventory", (value) => value.profiles.interactions[0]?.pop()],
    ];
    for (const [name, mutate] of cases) {
      const changed = structuredClone(preregistration) as unknown as MutablePolicyPreregistration;
      mutate(changed);
      writeFileSync(preregPath, canonicalJson(changed));
      let factories = 0;
      const result = await runBenchPolicy({
        repoRoot: root,
        preregistration: preregRef,
        out,
        runnerInfo: { kind: "compiled", sha256: "d".repeat(64) },
        adapterFactory(config, adapters) {
          factories += 1;
          return {};
        },
      });
      expect(result.exitCode, name).toBe(4);
      expect(factories, name).toBe(0);
      expect(existsSync(join(root, out)), name).toBe(false);
    }
    writeFileSync(preregPath, canonicalJson(preregistration));
    expect(readFileSync(preregPath, "utf8")).toBe(canonicalJson(preregistration));
  });
});
