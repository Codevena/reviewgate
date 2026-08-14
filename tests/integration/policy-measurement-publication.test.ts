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
} from "../../src/core/policy/measurement-contract.ts";
import { PolicyMeasurementPreregistrationSchema } from "../../src/schemas/policy-measurement-preregistration.ts";
import { PolicyMeasurementSchema } from "../../src/schemas/policy-measurement.ts";
import {
  validPolicyDogfoodSnapshot,
  validPolicyRigEvidence,
} from "../fixtures/policy-publication.ts";

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const SHA = "a".repeat(64);
const ATTEMPT = "attempt-publication";
const ATTEMPT_ROOT = `bench/results/policy-measurement/${ATTEMPT}`;

function preregistration(nested = false) {
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

function measurement(sources: readonly { ref: string; sha256: string }[]) {
  const prereg = sources.find((source) => source.ref === "bench/preregistrations/policy.json");
  if (prereg === undefined) throw new Error("missing preregistration binding");
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
    exclusions: [],
    truth_effects: {
      baseline: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
      ablated: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
      error_reduction: 0,
    },
    trace_totals: { applied: 0, would_apply: 0, protected: 0, no_opportunity: 0 },
    statistics: { raw_effects: [], interval: { lo: 0, hi: 0 }, p_value: 1, adjusted_p_value: 1 },
    unique_contributions: [],
    raw_evidence_refs: sources.map((source) => source.ref),
  });
  return PolicyMeasurementSchema.parse({
    schema: "reviewgate.policy-measurement.v1",
    preregistration: prereg,
    catalog_version: "reviewgate.policy-catalog.v1",
    passes: POLICY_PASSES.map((pass) => ({
      pass_id: pass.id,
      classification: "inconclusive",
      reasons: ["insufficient-opportunities"],
      vetoes: [],
      harm_observed: false,
      evidence_refs: sources.map((source) => source.ref),
      evidence: emptyEvidence(pass),
    })),
    interactions: POLICY_MEASUREMENT_INTERACTIONS.map((pass_ids) => ({
      pass_ids: [...pass_ids],
      artifact: prereg,
      evidence: {
        authoritative: false,
        eligibility: { stateless: false, stateful: false, dogfood: false },
        authority: { stateless: false, stateful: false, dogfood: false },
        opportunities: { cases: 0, signatures: 0, turns: 0, runs: 0 },
        exclusions: [],
        truth_effects: {
          baseline: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
          ablated: { blocking_fp: 0, blocking_fn: 0, blocking_tp: 0 },
          error_reduction: 0,
        },
        statistics: {
          raw_effects: [],
          interval: { lo: 0, hi: 0 },
          p_value: 1,
          adjusted_p_value: 1,
        },
        raw_evidence_refs: sources.map((source) => source.ref),
      },
    })),
    identity_evidence: POLICY_PASS_IDS.map((pass_id) => ({
      pass_id,
      ground_truth_harms: [],
      dogfood_dispositions: [],
      beneficial_effects: [],
    })),
    artifacts: {
      authoritative: true,
      sources,
      exclusions: [],
      evidence: sources,
      inventory: sources,
    },
  });
}

function fixture(nested = false) {
  const root = mkdtempSync(join(tmpdir(), "rg-policy-publication-"));
  const prereg = preregistration(nested);
  const files = new Map<
    string,
    { kind: "preregistration" | "bench" | "rig" | "dogfood"; text: string; mode: number }
  >([
    [
      "bench/preregistrations/policy.json",
      { kind: "preregistration", text: canonicalJson(prereg), mode: 0o644 },
    ],
    [
      prereg.outputs.bench_bundle,
      { kind: "bench", text: canonicalJson({ schema: "fixture.bench.v1" }), mode: 0o600 },
    ],
    [
      "rig/evidence.json",
      { kind: "rig", text: canonicalJson({ schema: "fixture.rig-source.v1" }), mode: 0o600 },
    ],
    [
      "dogfood/source.json",
      {
        kind: "dogfood",
        text: canonicalJson({ schema: "fixture.dogfood-source.v1" }),
        mode: 0o600,
      },
    ],
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
    { kind: "dogfood" as const, ref: auditRef, sha256: sha256(audit) },
  ].sort((left, right) => left.ref.localeCompare(right.ref));
  const bindings = sources.map(({ ref, sha256 }) => ({ ref, sha256 }));
  const runtime = {
    async assemble() {
      return {
        result: measurement(bindings),
        sources,
        publication: {
          rig_bundle: validPolicyRigEvidence(),
          dogfood_snapshot: validPolicyDogfoodSnapshot(),
        },
      } as never;
    },
  };
  return { root, prereg, audit, auditRef, runtime, sources };
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
