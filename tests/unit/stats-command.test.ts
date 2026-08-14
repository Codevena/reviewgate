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
} from "../../src/core/policy/measurement-contract.ts";
import { PolicyMeasurementPreregistrationSchema } from "../../src/schemas/policy-measurement-preregistration.ts";
import {
  PolicyDogfoodInputManifestSchema,
  PolicyMeasurementSchema,
} from "../../src/schemas/policy-measurement.ts";
import {
  validPolicyDogfoodSnapshot,
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

function policyPreregistration(out: string) {
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
      manifest_ref: "rig/policy-scenarios.json",
      manifest_sha256: sha,
      min_sequences_per_pass: 3,
      min_opportunity_turns: 2,
    },
    dogfood: {
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-12T09:00:00.000Z",
      input_manifest_ref: "bench/inputs/dogfood.json",
      input_manifest_sha256: sha,
      attestation_ref: "bench/attestations/dogfood.json",
      attestation_sha256: sha,
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

function emptyEvidence(pass: (typeof POLICY_PASSES)[number], ref: string) {
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
    raw_evidence_refs: [ref],
  };
}

function publishableMeasurement(sources: readonly { ref: string; sha256: string }[]) {
  const binding = sources.find((source) => source.ref.includes("preregistrations/"));
  if (binding === undefined)
    throw new Error("publication fixture needs one preregistration binding");
  const ref = binding.ref;
  return PolicyMeasurementSchema.parse({
    schema: "reviewgate.policy-measurement.v1",
    preregistration: binding,
    catalog_version: "reviewgate.policy-catalog.v1",
    passes: POLICY_PASSES.map((pass) => ({
      pass_id: pass.id,
      classification: "inconclusive",
      reasons: ["insufficient-opportunities"],
      vetoes: [],
      harm_observed: false,
      evidence_refs: [ref],
      evidence: emptyEvidence(pass, ref),
    })),
    interactions: POLICY_MEASUREMENT_INTERACTIONS.map((passIds) => ({
      pass_ids: [...passIds],
      artifact: binding,
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
        raw_evidence_refs: [ref],
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

function policyRuntime(root: string, out: string) {
  const ref = "bench/preregistrations/policy.json";
  const bytes = canonicalJson(policyPreregistration(out));
  const benchRef = `${out}/bench.json`;
  const benchBytes = canonicalJson({ schema: "fixture.bench.v1" });
  const path = join(root, ref);
  mkdirSync(join(root, "bench", "preregistrations"), { recursive: true });
  writeFileSync(path, bytes, { mode: 0o644 });
  const source = { kind: "preregistration" as const, ref, sha256: digest(bytes) };
  mkdirSync(join(root, out), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, benchRef), benchBytes, { mode: 0o600 });
  const benchSource = { kind: "bench" as const, ref: benchRef, sha256: digest(benchBytes) };
  const sources = [source, benchSource].sort((left, right) =>
    left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0,
  );
  return {
    source,
    benchRef,
    path,
    runtime: {
      async assemble() {
        return {
          result: publishableMeasurement(sources.map(({ ref, sha256 }) => ({ ref, sha256 }))),
          sources,
          publication: {
            rig_bundle: validPolicyRigEvidence(),
            dogfood_snapshot: validPolicyDogfoodSnapshot(),
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
  const auditRef = ".reviewgate/audit/closed.jsonl";
  const preregistration = canonicalJson(policyPreregistration(out));
  const bench = canonicalJson({ schema: "fixture.bench.v1" });
  const audit = `${JSON.stringify({ schema: "reviewgate.audit.v1", event: "run.complete" })}\n`;
  for (const [ref, bytes, mode] of [
    [preregRef, preregistration, 0o644],
    [benchRef, bench, 0o600],
    [auditRef, audit, 0o600],
  ] as const) {
    mkdirSync(dirname(join(root, ref)), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, ref), bytes, { mode });
  }
  const sources = [
    { kind: "preregistration" as const, ref: preregRef, sha256: digest(preregistration) },
    { kind: "bench" as const, ref: benchRef, sha256: digest(bench) },
    { kind: "dogfood" as const, ref: auditRef, sha256: digest(audit) },
  ].sort((left, right) => (left.ref < right.ref ? -1 : left.ref > right.ref ? 1 : 0));
  return {
    sources,
    runtime: {
      async assemble() {
        const measurementSources = sources.map(({ ref, sha256 }) => ({ ref, sha256 }));
        return {
          result: publishableMeasurement(measurementSources),
          sources,
          publication: {
            rig_bundle: validPolicyRigEvidence(),
            dogfood_snapshot: validPolicyDogfoodSnapshot(),
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
  const { runtime, source, benchRef, path } = policyRuntime(root, out);
  const sourceBefore = lstatSync(path);
  const result = await __policyStatsTest.run(
    { repoRoot: root, preregistration: source.ref, bench: benchRef, rig: "rig.json", out },
    runtime,
  );
  const published = join(root, out);
  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(readdirSync(join(published, "artifacts", "policy-measurement-sources"))).toHaveLength(2);
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
  ).toHaveLength(2);
  expect(lstatSync(path).ino).toBe(sourceBefore.ino);
  expect(readFileSync(path, "utf8")).toBe(canonicalJson(policyPreregistration(out)));
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
