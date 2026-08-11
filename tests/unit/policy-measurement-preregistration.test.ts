import { describe, expect, test } from "bun:test";
import { POLICY_PASS_IDS } from "../../src/core/policy/catalog.ts";
import {
  POLICY_MEASUREMENT_INTERACTIONS,
  POLICY_MEASUREMENT_SINGLETONS,
  POLICY_MEASUREMENT_THRESHOLDS,
} from "../../src/core/policy/measurement-contract.ts";
import { PolicyMeasurementPreregistrationSchema } from "../../src/schemas/policy-measurement-preregistration.ts";

const SHA = "a".repeat(64);
const ATTEMPT = "attempt-2026-08-12";
const ROOT = `bench/results/policy-measurement/${ATTEMPT}`;

function preregistration(): Record<string, unknown> {
  return {
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
      critic: {
        provider: "codex",
        model: "gpt-5",
        persona: "critic",
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
      manifest_sha256: SHA,
      min_sequences_per_pass: 3,
      min_opportunity_turns: 2,
    },
    dogfood: {
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-12T09:00:00.000Z",
      input_manifest_ref: "bench/inputs/dogfood.json",
      input_manifest_sha256: SHA,
      attestation_ref: "bench/attestations/dogfood.json",
      attestation_sha256: SHA,
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
      attempt_dir: ROOT,
      bench_bundle: `${ROOT}/bench.json`,
      rig_bundle: `${ROOT}/rig.json`,
      dogfood_snapshot: `${ROOT}/dogfood.json`,
      result_json: `${ROOT}/result.json`,
      report_md: `${ROOT}/report.md`,
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
  };
}

function expectInvalid(change: (value: Record<string, unknown>) => void): void {
  const value = preregistration();
  change(value);
  expect(() => PolicyMeasurementPreregistrationSchema.parse(value)).toThrow();
}

function set(object: Record<string, unknown>, key: string, value: unknown): void {
  object[key] = value;
}

describe("policy measurement preregistration", () => {
  test("pins the closed 18-pass measurement contract", () => {
    expect(POLICY_MEASUREMENT_SINGLETONS).toEqual(POLICY_PASS_IDS);
    expect(POLICY_MEASUREMENT_INTERACTIONS).toEqual([
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
    ]);
    expect(POLICY_MEASUREMENT_THRESHOLDS).toEqual({
      statelessCases: 8,
      statelessSignatures: 15,
      repeats: 3,
      statefulSequences: 3,
      opportunityTurnsPerSequence: 2,
      dogfoodDispositions: 5,
      dogfoodRuns: 3,
      bootstrapResamples: 10_000,
    });
  });

  test("accepts the one fully bound preregistration shape", () => {
    expect(() => PolicyMeasurementPreregistrationSchema.parse(preregistration())).not.toThrow();
  });

  test("rejects inventory, profile, corpus, and threshold drift", () => {
    expectInvalid((value) => (value.pass_ids as string[]).reverse());
    expectInvalid((value) => (value.pass_ids as string[]).pop());
    expectInvalid((value) => (value.pass_ids as string[]).splice(1, 1, POLICY_PASS_IDS[0]));
    expectInvalid((value) =>
      ((value.profiles as Record<string, unknown>).interactions as string[][])[0]?.pop(),
    );
    expectInvalid((value) => set(value.corpus as Record<string, unknown>, "unique_cases", 29));
    expectInvalid((value) => set(value.corpus as Record<string, unknown>, "unique_cases", 31));
    expectInvalid((value) => set(value.corpus as Record<string, unknown>, "repeats", 2));
    expectInvalid((value) =>
      set(value.analysis as Record<string, unknown>, "stateless_min_cases", 7),
    );
    expectInvalid((value) =>
      set(value.analysis as Record<string, unknown>, "stateless_min_signatures", 14),
    );
    expectInvalid((value) =>
      set(value.analysis as Record<string, unknown>, "bootstrap_resamples", 1_000),
    );
  });

  test("rejects mutable source, closed-analysis, and authority drift", () => {
    expectInvalid((value) =>
      set(
        value.source as Record<string, unknown>,
        "require_exact_clean_head_containing_this_file",
        false,
      ),
    );
    expectInvalid((value) =>
      set(value.dogfood as Record<string, unknown>, "until", "2026-08-12T09:01:00.000Z"),
    );
    expectInvalid((value) =>
      set(value.analysis as Record<string, unknown>, "interval", "normal-95"),
    );
    expectInvalid((value) =>
      set(value.analysis as Record<string, unknown>, "correction", {
        singleton: "holm-22",
        interaction: "holm-22",
      }),
    );
    expectInvalid((value) =>
      set(value.analysis as Record<string, unknown>, "candidate_rules", "data-driven-v1"),
    );
    expectInvalid((value) =>
      set(value.analysis as Record<string, unknown>, "vetoes", ["unique-prevented-fp"]),
    );
    expectInvalid((value) =>
      set(value.hard_gates as Record<string, unknown>, "maximum_provider_calls", 0),
    );
    expectInvalid((value) =>
      set(value.dogfood as Record<string, unknown>, "input_manifest_sha256", "short"),
    );
    expectInvalid((value) =>
      set(value.dogfood as Record<string, unknown>, "attestation_sha256", "short"),
    );
  });

  test("requires structural OpenRouter routes and bounded execution", () => {
    expectInvalid((value) => {
      const reviewer = (
        (value.roster as Record<string, unknown>).reviewers as Record<string, unknown>[]
      )[0];
      if (reviewer !== undefined) set(reviewer, "openrouter_provider", null);
    });
    expectInvalid((value) => {
      const reviewer = (
        (value.roster as Record<string, unknown>).reviewers as Record<string, unknown>[]
      )[0];
      if (reviewer !== undefined) set(reviewer, "openrouter_provider", { allowFallbacks: false });
    });
    expectInvalid((value) =>
      set(
        (value.roster as Record<string, unknown>).critic as Record<string, unknown>,
        "openrouter_provider",
        { only: ["openai"] },
      ),
    );
    expectInvalid((value) =>
      set(value.execution as Record<string, unknown>, "reviewer_max_attempts", 0),
    );
    expectInvalid((value) =>
      set(value.execution as Record<string, unknown>, "critic_max_attempts", 4),
    );
    expectInvalid((value) =>
      set(value.execution as Record<string, unknown>, "max_output_tokens", 0),
    );
  });

  test("binds exactly thirty canonically named case hashes to the declared split", () => {
    expectInvalid((value) => {
      const hashes = (value.corpus as Record<string, unknown>).content_sha256 as Record<
        string,
        string | undefined
      >;
      hashes["cases/clean-16.json"] = undefined;
    });
    expectInvalid((value) => {
      const hashes = (value.corpus as Record<string, unknown>).content_sha256 as Record<
        string,
        string
      >;
      hashes["cases/seeded-15.json"] = SHA;
    });
    expectInvalid((value) => {
      const hashes = (value.corpus as Record<string, unknown>).content_sha256 as Record<
        string,
        string | undefined
      >;
      hashes["other.json"] = SHA;
      hashes["cases/seeded-14.json"] = undefined;
    });
  });

  test("requires unique immutable output paths below the named attempt root", () => {
    expectInvalid((value) =>
      set(
        value.outputs as Record<string, unknown>,
        "report_md",
        "bench/results/policy-measurement/other/report.md",
      ),
    );
    expectInvalid((value) =>
      set(value.outputs as Record<string, unknown>, "report_md", `${ROOT}/../report.md`),
    );
    expectInvalid((value) => {
      const outputs = value.outputs as Record<string, unknown>;
      outputs.report_md = outputs.result_json;
    });
  });
});
