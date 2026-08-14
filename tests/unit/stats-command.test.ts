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
import {
  PolicyDogfoodInputManifestSchema,
  PolicyMeasurementSchema,
} from "../../src/schemas/policy-measurement.ts";

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

function publishableMeasurement(ref: string, sha256: string) {
  const binding = { ref, sha256 };
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
      sources: [binding],
      exclusions: [],
      evidence: [binding],
      inventory: [binding],
    },
  });
}

function policyRuntime(root: string, out: string) {
  const ref = "bench/preregistrations/policy.json";
  const bytes = canonicalJson({ schema: "fixture.source.v1" });
  const path = join(root, ref);
  mkdirSync(join(root, "bench", "preregistrations"), { recursive: true });
  writeFileSync(path, bytes, { mode: 0o644 });
  const source = { kind: "preregistration" as const, ref, sha256: digest(bytes) };
  return {
    source,
    path,
    runtime: {
      async assemble() {
        return { result: publishableMeasurement(ref, source.sha256), sources: [source] };
      },
      rereadPreregistration() {
        return {
          outputs: {
            attempt_dir: out,
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
  const { runtime, source, path } = policyRuntime(root, out);
  const sourceBefore = lstatSync(path);
  const result = await __policyStatsTest.run(
    { repoRoot: root, preregistration: source.ref, bench: "bench.json", rig: "rig.json", out },
    runtime,
  );
  const published = join(root, out);
  expect(result.exitCode).toBe(0);
  expect(readdirSync(join(published, "artifacts", "policy-measurement-sources"))).toEqual([
    `${source.sha256}.json`,
  ]);
  expect(lstatSync(join(published, "result.json")).mode & 0o7777).toBe(0o600);
  expect(lstatSync(join(published, "report.md")).mode & 0o7777).toBe(0o600);
  expect(lstatSync(join(published, "complete.json")).mode & 0o7777).toBe(0o600);
  expect(__policyStatsTest.verifyPublishedPolicyBundle(published)).toBe(true);
  const copy = join(published, "artifacts", "policy-measurement-sources", `${source.sha256}.json`);
  expect(lstatSync(copy).mode & 0o7777).toBe(0o600);
  expect(digest(readFileSync(copy))).toBe(source.sha256);
  expect(
    PolicyMeasurementSchema.parse(JSON.parse(readFileSync(join(published, "result.json"), "utf8")))
      .artifacts.inventory,
  ).toEqual([{ ref: source.ref, sha256: source.sha256 }]);
  expect(lstatSync(path).ino).toBe(sourceBefore.ino);
  expect(readFileSync(path, "utf8")).toBe(canonicalJson({ schema: "fixture.source.v1" }));
  expect(
    readdirSync(dirname(published)).filter((name) => name.startsWith(".attempt.staging-")),
  ).toEqual([]);
});

it("refuses an existing policy output without replacing its inode or bytes", async () => {
  const root = seedRepo();
  const out = "bench/results/policy-measurement/attempt";
  const published = join(root, out);
  mkdirSync(published, { recursive: true });
  const sentinel = join(published, "sentinel");
  writeFileSync(sentinel, "do not replace");
  const before = lstatSync(published);
  const { runtime, source } = policyRuntime(root, out);
  const result = await __policyStatsTest.run(
    { repoRoot: root, preregistration: source.ref, bench: "bench.json", rig: "rig.json", out },
    runtime,
  );
  expect(result.exitCode).toBe(2);
  expect(lstatSync(published).ino).toBe(before.ino);
  expect(readFileSync(sentinel, "utf8")).toBe("do not replace");
});

it("removes only its validated staging directory when publication fails before rename", async () => {
  const root = seedRepo();
  const out = "bench/results/policy-measurement/attempt";
  const { runtime, source, path } = policyRuntime(root, out);
  const sourceBefore = lstatSync(path);
  await expect(
    __policyStatsTest.run(
      { repoRoot: root, preregistration: source.ref, bench: "bench.json", rig: "rig.json", out },
      {
        ...runtime,
        beforeRename: () => {
          throw new Error("injected before rename");
        },
      },
    ),
  ).rejects.toThrow("injected before rename");
  expect(existsSync(join(root, out))).toBe(false);
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
  const { runtime, source } = policyRuntime(root, out);
  let replacement = "";
  await expect(
    __policyStatsTest.run(
      { repoRoot: root, preregistration: source.ref, bench: "bench.json", rig: "rig.json", out },
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

it("loses an exclusive output reservation race without changing the creator's empty directory", async () => {
  const root = seedRepo();
  const out = "bench/results/policy-measurement/attempt";
  const published = join(root, out);
  const { runtime, source } = policyRuntime(root, out);
  const result = await __policyStatsTest.run(
    { repoRoot: root, preregistration: source.ref, bench: "bench.json", rig: "rig.json", out },
    { ...runtime, beforeRename: () => mkdirSync(published) },
  );
  const creator = lstatSync(published);
  expect(result.exitCode).toBe(2);
  expect(lstatSync(published).ino).toBe(creator.ino);
  expect(readdirSync(published)).toEqual([]);
  expect(
    readdirSync(dirname(published)).filter((name) => name.startsWith(".attempt.staging-")),
  ).toEqual([]);
});

it("treats missing or tampered completion markers as non-authoritative and removes pre-marker failures", async () => {
  const root = seedRepo();
  const out = "bench/results/policy-measurement/attempt";
  const published = join(root, out);
  const { runtime, source } = policyRuntime(root, out);
  await expect(
    __policyStatsTest.run(
      { repoRoot: root, preregistration: source.ref, bench: "bench.json", rig: "rig.json", out },
      {
        ...runtime,
        beforeComplete: (candidate) => {
          expect(existsSync(join(candidate, "complete.json"))).toBe(false);
          throw new Error("injected pre-marker failure");
        },
      },
    ),
  ).rejects.toThrow("injected pre-marker failure");
  expect(existsSync(published)).toBe(false);

  const second = policyRuntime(root, out);
  const success = await __policyStatsTest.run(
    {
      repoRoot: root,
      preregistration: second.source.ref,
      bench: "bench.json",
      rig: "rig.json",
      out,
    },
    second.runtime,
  );
  expect(success.exitCode).toBe(0);
  expect(__policyStatsTest.verifyPublishedPolicyBundle(published)).toBe(true);
  const markerPath = join(published, "complete.json");
  const marker = JSON.parse(readFileSync(markerPath, "utf8"));
  marker.result.sha256 = "0".repeat(64);
  writeFileSync(markerPath, canonicalJson(marker), { mode: 0o600 });
  expect(__policyStatsTest.verifyPublishedPolicyBundle(published)).toBe(false);
  marker.result.sha256 = digest(readFileSync(join(published, "result.json")));
  marker.sources = [];
  writeFileSync(markerPath, canonicalJson(marker), { mode: 0o600 });
  expect(__policyStatsTest.verifyPublishedPolicyBundle(published)).toBe(false);
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
