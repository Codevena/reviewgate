import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { canonicalJson } from "../../src/audit/canonical.ts";
import { aggregate } from "../../src/core/aggregator.ts";
import { POLICY_CATALOG_VERSION } from "../../src/core/policy/catalog.ts";
import {
  capturePolicyReplayEnvelope,
  verifyPolicyReplayEnvelope,
} from "../../src/core/policy/replay-capture.ts";
import { PolicyTraceRecorder } from "../../src/core/policy/trace.ts";
import {
  cleanupReplayBranches,
  createPolicyStateSnapshot,
  createReplayBranches,
  digestPolicyState,
  verifyPolicyStateSnapshot,
} from "../../src/rig/policy-replay-state.ts";
import {
  type PolicyReplayEnvelope,
  PolicyReplayEnvelopeSchema,
  policyReplayCallId,
} from "../../src/schemas/policy-replay.ts";

const H = "a".repeat(64);

function finding(signature = "sig-a") {
  return {
    id: "raw-1",
    signature,
    severity: "WARN" as const,
    category: "quality" as const,
    rule_id: "safe-rule",
    file: "src/example.ts",
    line_start: 1,
    line_end: 1,
    message: "A real issue",
    details: "The value is not checked.",
    reviewer: { provider: "codex", model: "gpt-5", persona: "correctness" },
    confidence: 0.9,
    consensus: "singleton" as const,
  };
}

function envelope(overrides: Partial<PolicyReplayEnvelope> = {}): PolicyReplayEnvelope {
  const runtime = PolicyTraceRecorder.start({
    runId: "rig-run-1",
    iter: 1,
    ablated: new Set(),
  });
  const aggregateResult = aggregate({
    findings: [],
    reviewersTotal: 1,
    changedRanges: new Map(),
    scopeToDiff: true,
    outOfDiffBlocking: [],
    confidenceFloor: 0,
    demoteCorrectness: true,
    corroborateCritical: true,
    demoteTestSecurity: true,
    capDocsSeverity: true,
    policyRuntime: runtime,
  });
  const policyTrace = runtime.finalize({
    rawResponseSha256: ["b".repeat(64), "c".repeat(64)],
    verdict: aggregateResult.verdict,
    finalFindings: aggregateResult.dedupedFindings,
  });
  if (policyTrace === null) throw new Error("policy trace fixture failed");
  return PolicyReplayEnvelopeSchema.parse({
    schema: "reviewgate.policy-replay-envelope.v1",
    catalog_version: POLICY_CATALOG_VERSION,
    run_id: "rig-run-1",
    iter: 1,
    source_commit: H,
    exact_diff: [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -0,0 +1 @@",
      "+export const value = 1;",
      "",
    ].join("\n"),
    pre_policy_findings: [finding()],
    grounding: {
      corpus: "export const value = 1;",
      verdicts: [],
      llm_status: "not-run",
    },
    aggregate: {
      findings: [finding()],
      reviewers_total: 1,
      changed_ranges: [{ file: "src/example.ts", ranges: [{ start: 1, end: 2 }] }],
      scope_to_diff: true,
      out_of_diff_blocking: [],
      confidence_floor: 0,
      demote_correctness: true,
      corroborate_critical: true,
      demote_test_security: true,
      cap_docs_severity: true,
      critic: [],
      fp_active: [],
      fp_active_clusters: [],
      rep_unreliable: [],
      protected_reviewers: [],
      foreign_files: [],
      cycle_rejected: [],
      claimed_fixed: [],
      delta_scope: [],
      rejected_regions: [],
      policy_inactive: [],
    },
    policy_final_findings: [finding()],
    pre_policy: { self_refutation_enabled: true, hypothetical_enabled: true },
    state_sha256: H,
    raw_response_sha256: ["b".repeat(64), "c".repeat(64)],
    response_calls: [
      {
        call_id: policyReplayCallId({
          runId: "rig-run-1",
          iter: 1,
          kind: "reviewer",
          provider: "codex",
          method: "review",
          key: "codex-correctness",
          promptSha256: "d".repeat(64),
          ordinal: 0,
          slot: 0,
          attempt: 1,
          occurrence: 0,
        }),
        kind: "reviewer",
        provider: "codex",
        method: "review",
        key: "codex-correctness",
        prompt_sha256: "d".repeat(64),
        ordinal: 0,
        slot: 0,
        attempt: 1,
        occurrence: 0,
        response_sha256: "b".repeat(64),
      },
      {
        call_id: policyReplayCallId({
          runId: "rig-run-1",
          iter: 1,
          kind: "critic",
          provider: "openrouter",
          method: "complete",
          key: `openrouter:complete:${"e".repeat(64)}`,
          promptSha256: "e".repeat(64),
          ordinal: 1,
          slot: 0,
          attempt: 1,
          occurrence: 0,
        }),
        kind: "critic",
        provider: "openrouter",
        method: "complete",
        key: `openrouter:complete:${"e".repeat(64)}`,
        prompt_sha256: "e".repeat(64),
        ordinal: 1,
        slot: 0,
        attempt: 1,
        occurrence: 0,
        response_sha256: "c".repeat(64),
      },
    ],
    history: {
      fp_ledger: { enabled: false },
      reputation: { enabled: false },
      cycle_state: { source: "state.json", region_rejected_enabled: false },
      implicit_outcomes: { enabled: false },
    },
    policy_trace: policyTrace,
    lossless: true,
    ...overrides,
  });
}

function gitRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "rg-policy-replay-source-"));
  execFileSync("git", ["init", "-q", "."], { cwd: root });
  execFileSync("git", ["config", "user.email", "rig@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "rig"], { cwd: root });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "example.ts"), "export const value = 0;\n");
  mkdirSync(join(root, ".reviewgate", "reputation"), { recursive: true });
  writeFileSync(join(root, ".reviewgate", "fp-ledger.jsonl"), '{"id":"fp-1"}\n');
  writeFileSync(join(root, ".reviewgate", "reputation", "events.jsonl"), '{"tp":1}\n');
  execFileSync("git", ["add", "src/example.ts"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

describe("policy replay envelope schema", () => {
  test("is strict, closed-catalog, deterministically ordered, and preserves response order", () => {
    expect(PolicyReplayEnvelopeSchema.parse(envelope()).raw_response_sha256).toEqual([
      "b".repeat(64),
      "c".repeat(64),
    ]);
    expect(() =>
      PolicyReplayEnvelopeSchema.parse({ ...envelope(), catalog_version: "future" }),
    ).toThrow(/catalog/i);
    expect(() =>
      PolicyReplayEnvelopeSchema.parse({
        ...envelope(),
        aggregate: {
          ...envelope().aggregate,
          changed_ranges: [
            { file: "z.ts", ranges: [{ start: 1, end: 2 }] },
            { file: "a.ts", ranges: [{ start: 1, end: 2 }] },
          ],
        },
      }),
    ).toThrow(/sort/i);
    expect(() => PolicyReplayEnvelopeSchema.parse({ ...envelope(), extra: true })).toThrow();
    expect(() =>
      PolicyReplayEnvelopeSchema.parse({
        ...envelope(),
        raw_response_sha256: ["c".repeat(64), "b".repeat(64)],
      }),
    ).toThrow(/ordered response hashes/i);
  });

  test("binds response hashes to stable calls and records effective history-store inputs", () => {
    const base = envelope();
    const promptSha256 = "d".repeat(64);
    const call = {
      call_id: policyReplayCallId({
        runId: base.run_id,
        iter: base.iter,
        kind: "reviewer",
        provider: "codex",
        method: "review",
        key: "codex-correctness",
        promptSha256,
        ordinal: 0,
        slot: 0,
        attempt: 1,
        occurrence: 0,
      }),
      kind: "reviewer",
      provider: "codex",
      method: "review",
      key: "codex-correctness",
      prompt_sha256: promptSha256,
      ordinal: 0,
      slot: 0,
      attempt: 1,
      occurrence: 0,
      response_sha256: "b".repeat(64),
    };
    expect(() =>
      PolicyReplayEnvelopeSchema.parse({
        ...base,
        response_calls: [call],
        raw_response_sha256: ["b".repeat(64)],
        policy_trace: { ...base.policy_trace, raw_response_sha256: ["b".repeat(64)] },
        history: {
          fp_ledger: { enabled: false },
          reputation: { enabled: false },
          cycle_state: { source: "state.json", region_rejected_enabled: false },
          implicit_outcomes: { enabled: false },
        },
      }),
    ).not.toThrow();
  });
});

describe("policy replay capture", () => {
  test("preserves only the trusted matching Gate ULID identity despite its entropy", () => {
    const measuredRepoRoot = gitRepo();
    const runId = "01KZS1PT1A6VXW9VDGBNCTJ8KV";
    const withRunId = (
      message = "A real issue",
      envelopeRunId = runId,
      traceRunId = envelopeRunId,
    ): PolicyReplayEnvelope => {
      const candidate = envelope();
      candidate.run_id = envelopeRunId;
      candidate.policy_trace.run_id = traceRunId;
      const prePolicyFinding = candidate.pre_policy_findings[0];
      const aggregateFinding = candidate.aggregate.findings[0];
      const finalFinding = candidate.policy_final_findings[0];
      if (
        prePolicyFinding === undefined ||
        aggregateFinding === undefined ||
        finalFinding === undefined
      ) {
        throw new Error("ULID fixture is missing its finding");
      }
      prePolicyFinding.message = message;
      aggregateFinding.message = message;
      finalFinding.message = message;
      candidate.response_calls = candidate.response_calls.map((call) => ({
        ...call,
        call_id: policyReplayCallId({
          runId: envelopeRunId,
          iter: candidate.iter,
          kind: call.kind,
          provider: call.provider,
          method: call.method,
          key: call.key,
          promptSha256: call.prompt_sha256,
          ordinal: call.ordinal,
          slot: call.slot,
          attempt: call.attempt,
          occurrence: call.occurrence,
        }),
      }));
      return candidate;
    };

    const trustedSink = mkdtempSync(join(tmpdir(), "rg-policy-ulid-trusted-"));
    const trusted = capturePolicyReplayEnvelope({
      sinkDir: trustedSink,
      measuredRepoRoot,
      envelope: withRunId(),
    });
    expect(trusted).toMatchObject({ status: "complete" });
    if (trusted.status !== "complete") throw new Error("capture failed");
    expect(trusted.envelope.lossless).toBe(true);
    expect(trusted.envelope.run_id).toBe(runId);
    expect(trusted.envelope.policy_trace.run_id).toBe(runId);
    expect(
      verifyPolicyReplayEnvelope({
        sinkDir: trustedSink,
        ref: trusted.ref,
        sha256: trusted.sha256,
        authoritative: true,
      }).ok,
    ).toBe(true);

    const untrustedSink = mkdtempSync(join(tmpdir(), "rg-policy-ulid-untrusted-"));
    const untrusted = capturePolicyReplayEnvelope({
      sinkDir: untrustedSink,
      measuredRepoRoot,
      envelope: withRunId(runId),
    });
    expect(untrusted.status).toBe("complete");
    if (untrusted.status !== "complete") throw new Error("capture failed");
    expect(untrusted.envelope.lossless).toBe(false);
    expect(untrusted.envelope.pre_policy_findings[0]?.message).not.toBe(runId);

    const invalidUlid = `8${runId.slice(1)}`;
    expect(
      capturePolicyReplayEnvelope({
        sinkDir: mkdtempSync(join(tmpdir(), "rg-policy-ulid-invalid-")),
        measuredRepoRoot,
        envelope: withRunId("A real issue", invalidUlid),
      }),
    ).toEqual({ status: "error", reason: "invalid-envelope" });
    expect(
      capturePolicyReplayEnvelope({
        sinkDir: mkdtempSync(join(tmpdir(), "rg-policy-ulid-mismatch-")),
        measuredRepoRoot,
        envelope: withRunId("A real issue", runId, "01KZS1PT1A6VXW9VDGBNCTJ8KW"),
      }),
    ).toEqual({ status: "error", reason: "invalid-envelope" });
  });

  test("writes canonical mode-0600 data outside the measured repo and verifies its identity", () => {
    const measuredRepoRoot = gitRepo();
    const outputRoot = mkdtempSync(join(tmpdir(), "rg-policy-replay-output-"));
    const sinkDir = join(outputRoot, "policy-replay");
    mkdirSync(sinkDir, { mode: 0o700 });

    const stored = capturePolicyReplayEnvelope({ sinkDir, measuredRepoRoot, envelope: envelope() });
    expect(stored.status).toBe("complete");
    if (stored.status !== "complete") throw new Error("capture failed");
    const path = join(sinkDir, stored.ref);
    expect(realpathSync(path).startsWith(realpathSync(outputRoot))).toBe(true);
    expect(realpathSync(path).startsWith(realpathSync(measuredRepoRoot))).toBe(false);
    expect(lstatSync(path).mode & 0o7777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe(canonicalJson(stored.envelope));
    expect(verifyPolicyReplayEnvelope({ sinkDir, ref: stored.ref, sha256: stored.sha256 })).toEqual(
      {
        ok: true,
        envelope: stored.envelope,
      },
    );
  });

  test("redaction makes the artifact diagnostic-only instead of claiming exact authority", () => {
    const measuredRepoRoot = gitRepo();
    const sinkDir = mkdtempSync(join(tmpdir(), "rg-policy-replay-sink-"));
    const leaked = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    const candidate = {
      ...envelope(),
      pre_policy_findings: [finding("sig-secret")],
      grounding: {
        corpus: `Authorization: Bearer ${leaked}`,
        verdicts: [],
        llm_status: "not-run" as const,
      },
    };
    const stored = capturePolicyReplayEnvelope({ sinkDir, measuredRepoRoot, envelope: candidate });
    expect(stored.status).toBe("complete");
    if (stored.status !== "complete") throw new Error("capture failed");
    expect(stored.envelope.lossless).toBe(false);
    expect(readFileSync(join(sinkDir, stored.ref), "utf8")).not.toContain(leaked);
    expect(
      verifyPolicyReplayEnvelope({
        sinkDir,
        ref: stored.ref,
        sha256: stored.sha256,
        authoritative: true,
      }),
    ).toEqual({ ok: false, reason: "lossy" });
  });

  test("persists a bounded mode-0600 overflow status for the driver", () => {
    const measuredRepoRoot = gitRepo();
    const sinkDir = mkdtempSync(join(tmpdir(), "rg-policy-replay-sink-"));
    expect(
      capturePolicyReplayEnvelope({
        sinkDir,
        measuredRepoRoot,
        envelope: envelope(),
        maxBytes: 1,
      }),
    ).toEqual({ status: "overflow", reason: "too-large" });
    const statusFiles = readdirSync(sinkDir).filter((name) => name.endsWith(".overflow"));
    expect(statusFiles).toHaveLength(1);
    expect(lstatSync(join(sinkDir, statusFiles[0] as string)).mode & 0o7777).toBe(0o600);
  });

  test("fails closed on measured-repo sinks, mode drift, symlink escape, and tamper", () => {
    const measuredRepoRoot = gitRepo();
    const inside = join(measuredRepoRoot, "capture");
    mkdirSync(inside);
    expect(
      capturePolicyReplayEnvelope({ sinkDir: inside, measuredRepoRoot, envelope: envelope() }),
    ).toEqual({ status: "error", reason: "sink-inside-measured-repo" });

    const sinkDir = mkdtempSync(join(tmpdir(), "rg-policy-replay-sink-"));
    const stored = capturePolicyReplayEnvelope({ sinkDir, measuredRepoRoot, envelope: envelope() });
    if (stored.status !== "complete") throw new Error("capture failed");
    const path = join(sinkDir, stored.ref);
    chmodSync(path, 0o644);
    expect(verifyPolicyReplayEnvelope({ sinkDir, ref: stored.ref, sha256: stored.sha256 })).toEqual(
      {
        ok: false,
        reason: "not-a-file",
      },
    );

    chmodSync(path, 0o600);
    writeFileSync(path, `${readFileSync(path, "utf8")} `, { mode: 0o600 });
    expect(verifyPolicyReplayEnvelope({ sinkDir, ref: stored.ref, sha256: stored.sha256 })).toEqual(
      {
        ok: false,
        reason: "hash-mismatch",
      },
    );

    const outside = mkdtempSync(join(tmpdir(), "rg-policy-replay-outside-"));
    const escapedSink = join(mkdtempSync(join(tmpdir(), "rg-policy-replay-parent-")), "sink");
    symlinkSync(outside, escapedSink);
    const traversing = envelope();
    traversing.run_id = "../../escape";
    traversing.policy_trace.run_id = "../../escape";
    traversing.response_calls = traversing.response_calls.map((call) => ({
      ...call,
      call_id: policyReplayCallId({
        runId: traversing.run_id,
        iter: traversing.iter,
        kind: call.kind,
        provider: call.provider,
        method: call.method,
        key: call.key,
        promptSha256: call.prompt_sha256,
        ordinal: call.ordinal,
        slot: call.slot,
        attempt: call.attempt,
        occurrence: call.occurrence,
      }),
    }));
    expect(
      capturePolicyReplayEnvelope({
        sinkDir: escapedSink,
        measuredRepoRoot,
        envelope: traversing,
      }),
    ).toEqual({ status: "error", reason: "invalid-sink" });
  });
});

describe("policy replay state isolation", () => {
  test("snapshots production-like state and creates independent same-commit branches", () => {
    const sourceRepoRoot = gitRepo();
    const outputRoot = mkdtempSync(join(tmpdir(), "rg-policy-state-output-"));
    const sourceBytes = readFileSync(join(sourceRepoRoot, ".reviewgate", "fp-ledger.jsonl"));
    const sourceDigest = digestPolicyState(join(sourceRepoRoot, ".reviewgate"));
    const snapshot = createPolicyStateSnapshot({ sourceRepoRoot, outputRoot });
    expect(snapshot.stateSha256).toBe(sourceDigest);
    expect(snapshot.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lstatSync(join(outputRoot, snapshot.ref)).mode & 0o7777).toBe(0o600);

    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRepoRoot,
      encoding: "utf8",
    }).trim();
    const branches = createReplayBranches({
      sourceRepoRoot,
      sourceCommit,
      stateSnapshotRoot: join(outputRoot, snapshot.stateRef),
      expectedStateSha256: sourceDigest,
      exactDiff: [
        "diff --git a/src/example.ts b/src/example.ts",
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -1 +1 @@",
        "-export const value = 0;",
        "+export const value = 1;",
        "",
      ].join("\n"),
    });
    try {
      expect(branches.baseline.startingStateSha256).toBe(sourceDigest);
      expect(branches.counterfactual.startingStateSha256).toBe(sourceDigest);
      expect(readFileSync(join(branches.baseline.checkoutRoot, "src", "example.ts"), "utf8")).toBe(
        "export const value = 1;\n",
      );
      expect(
        readFileSync(join(branches.counterfactual.checkoutRoot, "src", "example.ts"), "utf8"),
      ).toBe("export const value = 1;\n");
      const sourceStateReal = realpathSync(join(sourceRepoRoot, ".reviewgate"));
      for (const branch of [branches.baseline, branches.counterfactual]) {
        const branchStateReal = realpathSync(join(branch.checkoutRoot, ".reviewgate"));
        expect(relative(sourceStateReal, branchStateReal).startsWith("..")).toBe(true);
        expect(lstatSync(join(branch.checkoutRoot, ".reviewgate", "fp-ledger.jsonl")).ino).not.toBe(
          lstatSync(join(sourceRepoRoot, ".reviewgate", "fp-ledger.jsonl")).ino,
        );
      }
      writeFileSync(
        join(branches.baseline.checkoutRoot, ".reviewgate", "fp-ledger.jsonl"),
        '{"id":"baseline-only"}\n',
      );
      writeFileSync(
        join(branches.counterfactual.checkoutRoot, ".reviewgate", "fp-ledger.jsonl"),
        '{"id":"counterfactual-only"}\n',
      );
      expect(digestPolicyState(join(branches.baseline.checkoutRoot, ".reviewgate"))).not.toBe(
        digestPolicyState(join(branches.counterfactual.checkoutRoot, ".reviewgate")),
      );
      expect(readFileSync(join(sourceRepoRoot, ".reviewgate", "fp-ledger.jsonl"))).toEqual(
        sourceBytes,
      );
    } finally {
      cleanupReplayBranches(branches);
    }
    expect(existsSync(branches.root)).toBe(false);
  });

  test("rejects symlinked state before hashing or copying it", () => {
    const sourceRepoRoot = gitRepo();
    const outside = join(mkdtempSync(join(tmpdir(), "rg-policy-state-outside-")), "secret.json");
    writeFileSync(outside, "secret\n");
    symlinkSync(outside, join(sourceRepoRoot, ".reviewgate", "linked.json"));
    expect(() => digestPolicyState(join(sourceRepoRoot, ".reviewgate"))).toThrow(/symlink/i);
    expect(() =>
      createPolicyStateSnapshot({
        sourceRepoRoot,
        outputRoot: mkdtempSync(join(tmpdir(), "rg-policy-state-output-")),
      }),
    ).toThrow(/symlink/i);
  });

  test("refuses a symlinked policy-state ancestor without writing outside the output root", () => {
    const sourceRepoRoot = gitRepo();
    const outputRoot = mkdtempSync(join(tmpdir(), "rg-policy-state-output-"));
    const outside = mkdtempSync(join(tmpdir(), "rg-policy-state-escape-"));
    symlinkSync(outside, join(outputRoot, "policy-state"));

    expect(() => createPolicyStateSnapshot({ sourceRepoRoot, outputRoot })).toThrow(
      /symlink|escape|ordinary directory/i,
    );
    expect(readdirSync(outside)).toEqual([]);
  });

  test("create rejects existing digest-tree symlink ancestors even when the external tree is identical", () => {
    for (const ancestor of ["state-digest", "state-root"] as const) {
      const sourceRepoRoot = gitRepo();
      const seedOutput = mkdtempSync(join(tmpdir(), "rg-policy-state-seed-"));
      const seed = createPolicyStateSnapshot({ sourceRepoRoot, outputRoot: seedOutput });
      const outside = mkdtempSync(join(tmpdir(), "rg-policy-state-identical-"));
      const externalDigestTree = join(outside, seed.stateSha256);
      cpSync(join(seedOutput, "policy-state", seed.stateSha256), externalDigestTree, {
        recursive: true,
      });
      const outsideDigestBefore = digestPolicyState(join(externalDigestTree, ".reviewgate"));
      const outputRoot = mkdtempSync(join(tmpdir(), "rg-policy-state-output-"));
      mkdirSync(join(outputRoot, "policy-state"));
      if (ancestor === "state-digest") {
        symlinkSync(externalDigestTree, join(outputRoot, "policy-state", seed.stateSha256));
      } else {
        mkdirSync(join(outputRoot, "policy-state", seed.stateSha256));
        symlinkSync(
          join(externalDigestTree, ".reviewgate"),
          join(outputRoot, "policy-state", seed.stateSha256, ".reviewgate"),
        );
      }

      expect(() => createPolicyStateSnapshot({ sourceRepoRoot, outputRoot }), ancestor).toThrow(
        /symlink|escape|ordinary directory/i,
      );
      expect(digestPolicyState(join(externalDigestTree, ".reviewgate")), ancestor).toBe(
        outsideDigestBefore,
      );
    }
  });

  test("verify rejects digest-tree symlink ancestors even when manifest and external bytes match", () => {
    for (const ancestor of ["state-digest", "state-root"] as const) {
      const sourceRepoRoot = gitRepo();
      const outputRoot = mkdtempSync(join(tmpdir(), "rg-policy-state-output-"));
      const snapshot = createPolicyStateSnapshot({ sourceRepoRoot, outputRoot });
      const persistedDigestTree = join(outputRoot, "policy-state", snapshot.stateSha256);
      const outside = mkdtempSync(join(tmpdir(), "rg-policy-state-verify-identical-"));
      const externalDigestTree = join(outside, snapshot.stateSha256);
      if (ancestor === "state-digest") {
        renameSync(persistedDigestTree, externalDigestTree);
        symlinkSync(externalDigestTree, persistedDigestTree);
      } else {
        mkdirSync(externalDigestTree);
        renameSync(
          join(persistedDigestTree, ".reviewgate"),
          join(externalDigestTree, ".reviewgate"),
        );
        symlinkSync(
          join(externalDigestTree, ".reviewgate"),
          join(persistedDigestTree, ".reviewgate"),
        );
      }
      const outsideDigestBefore = digestPolicyState(join(externalDigestTree, ".reviewgate"));

      expect(
        () =>
          verifyPolicyStateSnapshot({
            outputRoot,
            ref: snapshot.ref,
            sha256: snapshot.sha256,
            expectedStateSha256: snapshot.stateSha256,
          }),
        ancestor,
      ).toThrow(/symlink|escape|ordinary directory/i);
      expect(digestPolicyState(join(externalDigestTree, ".reviewgate")), ancestor).toBe(
        outsideDigestBefore,
      );
    }
  });

  test("uses one code-unit order for traversal, digest, manifest, and verification", () => {
    const sourceRepoRoot = gitRepo();
    writeFileSync(join(sourceRepoRoot, ".reviewgate", "Z.json"), "upper\n");
    writeFileSync(join(sourceRepoRoot, ".reviewgate", "a.json"), "lower\n");
    const outputRoot = mkdtempSync(join(tmpdir(), "rg-policy-state-output-"));

    const snapshot = createPolicyStateSnapshot({ sourceRepoRoot, outputRoot });
    expect(() =>
      verifyPolicyStateSnapshot({
        outputRoot,
        ref: snapshot.ref,
        sha256: snapshot.sha256,
        expectedStateSha256: snapshot.stateSha256,
      }),
    ).not.toThrow();
    const manifest = JSON.parse(readFileSync(join(outputRoot, snapshot.ref), "utf8")) as {
      files: Array<{ path: string }>;
    };
    expect(manifest.files.map((entry) => entry.path)).toEqual([
      "Z.json",
      "a.json",
      "fp-ledger.jsonl",
      "reputation/events.jsonl",
    ]);
  });

  test("rejects mode drift in a persisted state tree while accepting legacy source modes", () => {
    const sourceRepoRoot = gitRepo();
    const sourcePath = join(sourceRepoRoot, ".reviewgate", "fp-ledger.jsonl");
    chmodSync(sourcePath, 0o644);
    const outputRoot = mkdtempSync(join(tmpdir(), "rg-policy-state-output-"));
    const snapshot = createPolicyStateSnapshot({ sourceRepoRoot, outputRoot });
    const persistedPath = join(outputRoot, snapshot.stateRef, "fp-ledger.jsonl");
    expect(lstatSync(persistedPath).mode & 0o7777).toBe(0o600);
    chmodSync(persistedPath, 0o644);

    expect(() =>
      verifyPolicyStateSnapshot({
        outputRoot,
        ref: snapshot.ref,
        sha256: snapshot.sha256,
        expectedStateSha256: snapshot.stateSha256,
      }),
    ).toThrow(/0600|mode/i);
  });

  test("rejects hardlinked and special state entries", () => {
    const hardlinkedRepo = gitRepo();
    linkSync(
      join(hardlinkedRepo, ".reviewgate", "fp-ledger.jsonl"),
      join(hardlinkedRepo, ".reviewgate", "hardlink.jsonl"),
    );
    expect(() => digestPolicyState(join(hardlinkedRepo, ".reviewgate"))).toThrow(/hardlink/i);

    const specialRepo = gitRepo();
    const fifo = join(specialRepo, ".reviewgate", "state.fifo");
    execFileSync("mkfifo", [fifo]);
    expect(() => digestPolicyState(join(specialRepo, ".reviewgate"))).toThrow(/special/i);
  });

  test("rejects source-state aliasing and unequal requested starting digests", () => {
    const sourceRepoRoot = gitRepo();
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: sourceRepoRoot,
      encoding: "utf8",
    }).trim();
    const stateRoot = join(sourceRepoRoot, ".reviewgate");
    const actualDigest = digestPolicyState(stateRoot);

    expect(() =>
      createReplayBranches({
        sourceRepoRoot,
        sourceCommit,
        stateSnapshotRoot: stateRoot,
        expectedStateSha256: actualDigest,
        exactDiff: "",
      }),
    ).toThrow(/must not alias/i);

    const outputRoot = mkdtempSync(join(tmpdir(), "rg-policy-state-output-"));
    const snapshot = createPolicyStateSnapshot({ sourceRepoRoot, outputRoot });
    expect(() =>
      createReplayBranches({
        sourceRepoRoot,
        sourceCommit,
        stateSnapshotRoot: join(outputRoot, snapshot.stateRef),
        expectedStateSha256: "f".repeat(64),
        exactDiff: "",
      }),
    ).toThrow(/digest mismatch/i);
  });
});
