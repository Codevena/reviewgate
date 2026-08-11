import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
} from "../../src/rig/policy-replay-state.ts";
import {
  type PolicyReplayEnvelope,
  PolicyReplayEnvelopeSchema,
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
});

describe("policy replay capture", () => {
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
