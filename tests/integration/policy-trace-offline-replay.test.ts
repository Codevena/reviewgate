import { describe, expect, it, spyOn } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../../src/audit/canonical.ts";
import { type AggregateInput, aggregate } from "../../src/core/aggregator.ts";
import { validateFindingFacts } from "../../src/core/fact-check.ts";
import { groundFindings } from "../../src/core/grounding.ts";
import { demoteHypotheticalCriticals } from "../../src/core/hypothetical-demote.ts";
import {
  POLICY_CATALOG_VERSION,
  POLICY_PASS_IDS,
  type PolicyPassId,
} from "../../src/core/policy/catalog.ts";
import {
  capturePolicyReplayEnvelope,
  serializePolicyReplayAggregateInputs,
} from "../../src/core/policy/replay-capture.ts";
import { PolicyTraceRecorder } from "../../src/core/policy/trace.ts";
import { demoteSelfRefuting } from "../../src/core/self-refutation.ts";
import {
  createPolicyStateSnapshot,
  digestPolicyState,
  validateRigPolicyReplayArtifacts,
} from "../../src/rig/policy-replay-state.ts";
import { replayPolicyEnvelopePair } from "../../src/rig/replay.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import {
  type PolicyReplayEnvelope,
  type PolicyReplayEnvelopeInput,
  PolicyReplayEnvelopeSchema,
  policyReplayCallId,
} from "../../src/schemas/policy-replay.ts";
import type { PolicyTrace } from "../../src/schemas/policy-trace.ts";
import type { RigManifest } from "../../src/schemas/rig-manifest.ts";
import { initialState } from "../../src/schemas/state.ts";

type ReplayClass = "evidence" | "value-judgment" | "scope" | "history";

interface ReplayCase {
  className: ReplayClass;
  passId: PolicyPassId;
  finding: Finding;
  aggregateInput(findings: Finding[]): AggregateInput;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    signature: "offline-policy",
    severity: "WARN",
    category: "quality",
    rule_id: "offline-policy",
    file: "src/x.ts",
    line_start: 1,
    line_end: 1,
    message: "A concrete offline replay finding",
    details: "The recorded finding exercises one production policy pass.",
    reviewer: { provider: "codex", model: "m", persona: "quality" },
    confidence: 0.9,
    consensus: "singleton",
    ...overrides,
  };
}

function baseAggregateInput(findings: Finding[]): AggregateInput {
  return {
    findings,
    reviewersTotal: 1,
    changedRanges: new Map(),
    scopeToDiff: false,
    outOfDiffBlocking: [],
    confidenceFloor: 0,
    demoteCorrectness: true,
    corroborateCritical: true,
    demoteTestSecurity: false,
    capDocsSeverity: false,
    critic: new Map(),
    fpActive: new Map(),
    fpActiveClusters: new Map(),
    repUnreliable: new Set(),
    protectedReviewers: new Set(),
    foreignFiles: new Set(),
    cycleRejected: new Set(),
    claimedFixed: new Map(),
    deltaScope: new Set(),
    rejectedRegions: [],
    policyInactive: {
      "judgment.critic": "configured-off",
      "scope.diff": "configured-off",
      "scope.delta": "stage-precondition-miss",
      "scope.session": "stage-precondition-miss",
    },
  };
}

function replayCases(): ReplayCase[] {
  return [
    {
      className: "evidence",
      passId: "evidence.fact-location",
      finding: finding({ signature: "offline-fact", line_start: 99, line_end: 99 }),
      aggregateInput: baseAggregateInput,
    },
    {
      className: "value-judgment",
      passId: "judgment.confidence",
      finding: finding({ signature: "offline-confidence", confidence: 0.2 }),
      aggregateInput: (findings) => ({
        ...baseAggregateInput(findings),
        confidenceFloor: 0.8,
      }),
    },
    {
      className: "scope",
      passId: "scope.diff",
      finding: finding({ signature: "offline-scope", line_start: 10, line_end: 10 }),
      aggregateInput: (findings) => {
        const input = baseAggregateInput(findings);
        return {
          ...input,
          changedRanges: new Map([["src/x.ts", [[1, 2]]]]),
          scopeToDiff: true,
          policyInactive: {
            "judgment.critic": "configured-off",
            "scope.delta": "stage-precondition-miss",
            "scope.session": "stage-precondition-miss",
          },
        };
      },
    },
    {
      className: "history",
      passId: "history.fp-signature",
      finding: finding({ signature: "seeded-fp" }),
      aggregateInput: (findings) => ({
        ...baseAggregateInput(findings),
        fpActive: new Map([["seeded-fp", { id: "FP-001" }]]),
      }),
    },
  ];
}

function createSourceRepo(): { root: string; commit: string } {
  const root = mkdtempSync(join(tmpdir(), "reviewgate-offline-source-"));
  execFileSync("git", ["init", "-q", "."], { cwd: root });
  execFileSync("git", ["config", "user.email", "offline@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "offline"], { cwd: root });
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "src", "x.ts"),
    `${Array.from(
      { length: 20 },
      (_, index) => `export const line${index + 1} = ${index + 1};`,
    ).join("\n")}\n`,
  );
  execFileSync("git", ["add", "src/x.ts"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "source"], { cwd: root });

  mkdirSync(join(root, ".reviewgate", "learnings"), { recursive: true });
  writeFileSync(join(root, ".reviewgate", "state.json"), JSON.stringify(initialState("offline")), {
    mode: 0o600,
  });
  writeFileSync(
    join(root, ".reviewgate", "learnings", "known_fp.jsonl"),
    JSON.stringify({
      schema: "reviewgate.fpledger.v1",
      seq: 1,
      entries: [
        {
          id: "FP-001",
          signature: "seeded-fp",
          rule_id: "offline-policy",
          category: "quality",
          file: "src/x.ts",
          symbol: "",
          stage: "active",
          rejects: [
            {
              run_id: "seed-1",
              provider: "codex",
              ts: "2026-08-01T12:00:00.000Z",
              reason: "confirmed false positive one",
            },
            {
              run_id: "seed-2",
              provider: "openrouter",
              ts: "2026-08-02T12:00:00.000Z",
              reason: "confirmed false positive two",
            },
            {
              run_id: "seed-3",
              provider: "codex",
              ts: "2026-08-03T12:00:00.000Z",
              reason: "confirmed false positive three",
            },
          ],
          distinct_providers: ["codex", "openrouter"],
          first_seen_at: "2026-08-01T12:00:00.000Z",
          last_seen_at: "2026-08-03T12:00:00.000Z",
          created_at: "2026-08-01T12:00:00.000Z",
        },
      ],
    }),
    { mode: 0o600 },
  );
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  return { root, commit };
}

function executeProductionBaseline(input: {
  sourceRepoRoot: string;
  runId: string;
  rawResponseSha256: string[];
  replayCase: ReplayCase;
}): {
  aggregateInput: AggregateInput;
  aggregateFindings: Finding[];
  finalFindings: Finding[];
  trace: PolicyTrace;
} {
  const recorder = PolicyTraceRecorder.start({ runId: input.runId, iter: 1, ablated: [] });
  const factChecked = validateFindingFacts(
    [input.replayCase.finding],
    input.sourceRepoRoot,
    new Set(),
    recorder,
  );
  const selfScreened = demoteSelfRefuting(factChecked, true, recorder);
  const hypothetical = demoteHypotheticalCriticals(selfScreened, true, recorder);
  const grounded = groundFindings(hypothetical, "", recorder);
  recorder.markInactive("judgment.grounding-llm", "configured-off");
  const aggregateInput = input.replayCase.aggregateInput(grounded);
  const result = aggregate({ ...aggregateInput, policyRuntime: recorder });
  const trace = recorder.finalize({
    rawResponseSha256: input.rawResponseSha256,
    verdict: result.verdict,
    finalFindings: result.dedupedFindings,
  });
  if (trace === null) throw new Error("offline production trace did not finalize");
  return {
    aggregateInput,
    aggregateFindings: grounded,
    finalFindings: result.dedupedFindings,
    trace,
  };
}

function responseCall(runId: string, rawText: string) {
  const identity = {
    runId,
    iter: 1,
    kind: "reviewer" as const,
    provider: "openrouter" as const,
    method: "review" as const,
    key: "openrouter-quality",
    promptSha256: "a".repeat(64),
    ordinal: 0,
    slot: 0,
    attempt: 1,
    occurrence: 0,
  };
  return {
    call_id: policyReplayCallId(identity),
    kind: identity.kind,
    provider: identity.provider,
    method: identity.method,
    key: identity.key,
    prompt_sha256: identity.promptSha256,
    ordinal: identity.ordinal,
    slot: identity.slot,
    attempt: identity.attempt,
    occurrence: identity.occurrence,
    response_sha256: sha256(rawText),
  };
}

function cassetteEntry(runId: string, rawText: string, call: ReturnType<typeof responseCall>) {
  return {
    schema: "reviewgate.cassette.entry.v1",
    provider: call.provider,
    method: call.method,
    key: call.key,
    promptSha256: call.prompt_sha256,
    policyReplayCall: {
      callId: call.call_id,
      runId,
      iter: 1,
      kind: call.kind,
      ordinal: call.ordinal,
      slot: call.slot,
      attempt: call.attempt,
      occurrence: call.occurrence,
    },
    result: {
      reviewerId: call.key,
      verdict: "PASS",
      findings: [],
      usage: { inputTokens: 1, outputTokens: 1, costUsd: 0, quotaUsedPct: null },
      durationMs: 1,
      exitCode: 0,
      rawEventsPath: "",
      status: "ok",
      rawText,
    },
  };
}

function persistAuthoritativeFixture(input: {
  sourceRepoRoot: string;
  sourceCommit: string;
  outputRoot: string;
  replayCase: ReplayCase;
}): {
  envelope: PolicyReplayEnvelope;
  stateSnapshotRoot: string;
  callsBefore: string;
} {
  const runId = `offline-${input.replayCase.className}`;
  const rawText = `safe recorded response for ${input.replayCase.className}`;
  const rawHash = sha256(rawText);
  const call = responseCall(runId, rawText);
  const production = executeProductionBaseline({
    sourceRepoRoot: input.sourceRepoRoot,
    runId,
    rawResponseSha256: [rawHash],
    replayCase: input.replayCase,
  });
  const state = createPolicyStateSnapshot({
    sourceRepoRoot: input.sourceRepoRoot,
    outputRoot: input.outputRoot,
  });
  const envelopeInput: PolicyReplayEnvelopeInput = {
    schema: "reviewgate.policy-replay-envelope.v1",
    catalog_version: POLICY_CATALOG_VERSION,
    run_id: runId,
    iter: 1,
    source_commit: input.sourceCommit,
    exact_diff: "",
    pre_policy_findings: [input.replayCase.finding],
    grounding: { corpus: "", verdicts: [], llm_status: "not-run" },
    aggregate: serializePolicyReplayAggregateInputs(production.aggregateInput),
    policy_final_findings: production.finalFindings,
    pre_policy: { self_refutation_enabled: true, hypothetical_enabled: true },
    state_sha256: state.stateSha256,
    raw_response_sha256: [rawHash],
    response_calls: [call],
    history: {
      fp_ledger:
        input.replayCase.className === "history"
          ? {
              enabled: true,
              active_at: "2026-08-11T12:00:00.000Z",
              clusters_at: "2026-08-11T12:00:00.000Z",
            }
          : { enabled: false },
      reputation: { enabled: false },
      cycle_state: { source: "state.json", region_rejected_enabled: false },
      implicit_outcomes: {
        enabled: true,
        created_at: "2026-08-11T12:00:00.000Z",
        cap: 100,
      },
    },
    policy_trace: production.trace,
    lossless: true,
  };
  const envelope = PolicyReplayEnvelopeSchema.parse(envelopeInput);
  const sinkDir = join(input.outputRoot, "policy-replay");
  mkdirSync(sinkDir, { mode: 0o700 });
  const stored = capturePolicyReplayEnvelope({
    sinkDir,
    measuredRepoRoot: input.sourceRepoRoot,
    envelope,
  });
  if (stored.status !== "complete") throw new Error("offline replay envelope did not persist");
  const cassettePath = join(input.outputRoot, "cassette.jsonl");
  writeFileSync(cassettePath, `${JSON.stringify(cassetteEntry(runId, rawText, call))}\n`, {
    mode: 0o600,
  });
  const manifestPath = join(input.outputRoot, "manifest.json");
  const manifest: RigManifest = {
    schema: "reviewgate.rig.manifest.v1",
    runId,
    scriptId: `script-${input.replayCase.className}`,
    outDir: input.outputRoot,
    turns: [
      {
        index: 1,
        snapshotDir: join(input.outputRoot, "turns", "1"),
        agentExitCode: 0,
        wallMs: 1,
        policyReplay: { status: "complete", traces: [{ ref: stored.ref, sha256: stored.sha256 }] },
      },
    ],
    policyReplay: {
      catalogVersion: POLICY_CATALOG_VERSION,
      sourceCommit: input.sourceCommit,
      initialStateRef: state.ref,
      initialStateSha256: state.sha256,
      initialStateDigest: state.stateSha256,
      cassetteSha256: sha256(readFileSync(cassettePath)),
      cassetteRef: "cassette.jsonl",
      captureDir: "policy-replay",
    },
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const validated = validateRigPolicyReplayArtifacts({ manifest, manifestPath });
  if (validated === null) throw new Error("offline replay fixture was treated as legacy");
  const authoritative = validated.turns.get(1)?.[0];
  if (authoritative === undefined) throw new Error("offline replay envelope was not authoritative");
  return {
    envelope: authoritative.envelope,
    stateSnapshotRoot: authoritative.stateRoot,
    callsBefore: canonicalJson(authoritative.envelope.response_calls),
  };
}

describe("policy trace offline replay", () => {
  it("replays evidence, judgment, scope, and stateful history without live providers", async () => {
    const source = createSourceRepo();
    const outputRoots: string[] = [];
    const sourceFileBefore = readFileSync(join(source.root, "src", "x.ts"));
    const stateBefore = digestPolicyState(join(source.root, ".reviewgate"));
    const statusBefore = execFileSync("git", ["status", "--porcelain=v1"], {
      cwd: source.root,
      encoding: "utf8",
    });
    const fetchSpy = spyOn(globalThis, "fetch");
    const spawnSpy = spyOn(Bun, "spawn");
    try {
      const observed: Array<{
        className: ReplayClass;
        baselineVerdict: PolicyTrace["final"]["verdict"];
        counterfactualVerdict: PolicyTrace["final"]["verdict"];
      }> = [];
      for (const replayCase of replayCases()) {
        const outputRoot = mkdtempSync(join(tmpdir(), "reviewgate-offline-run-"));
        outputRoots.push(outputRoot);
        const fixture = persistAuthoritativeFixture({
          sourceRepoRoot: source.root,
          sourceCommit: source.commit,
          outputRoot,
          replayCase,
        });
        const pair = await replayPolicyEnvelopePair({
          sourceRepoRoot: source.root,
          envelope: fixture.envelope,
          stateSnapshotRoot: fixture.stateSnapshotRoot,
          passId: replayCase.passId,
        });

        expect(pair.baseline.passes).toHaveLength(POLICY_PASS_IDS.length);
        expect(pair.counterfactual.passes).toHaveLength(POLICY_PASS_IDS.length);
        expect(pair.baseline.stages.map(({ stage_id }) => stage_id)).toContain(
          "aggregation.cluster",
        );
        expect(pair.baseline.stages.map(({ stage_id }) => stage_id)).toContain("verdict.compute");
        expect(pair.baseline.raw_response_sha256).toEqual(pair.counterfactual.raw_response_sha256);
        expect(canonicalJson(fixture.envelope.response_calls)).toBe(fixture.callsBefore);
        expect(pair.baseline.final.finding_severities.map(({ severity }) => severity)).toEqual([
          "INFO",
        ]);
        expect(
          pair.counterfactual.final.finding_severities.map(({ severity }) => severity),
        ).toEqual(["WARN"]);
        expect(pair.baseline.final.verdict).toBe("PASS");
        expect(pair.counterfactual.final.verdict).toBe("SOFT-PASS");
        expect(pair.state.baseline.history_reads).toBeGreaterThan(0);
        expect(pair.state.baseline.history_writes).toBe(1);
        expect(pair.state.counterfactual.history_writes).toBe(0);
        expect(pair.state.baseline.digest).not.toBe(pair.state.counterfactual.digest);
        observed.push({
          className: replayCase.className,
          baselineVerdict: pair.baseline.final.verdict,
          counterfactualVerdict: pair.counterfactual.final.verdict,
        });
      }

      expect(observed).toEqual([
        { className: "evidence", baselineVerdict: "PASS", counterfactualVerdict: "SOFT-PASS" },
        {
          className: "value-judgment",
          baselineVerdict: "PASS",
          counterfactualVerdict: "SOFT-PASS",
        },
        { className: "scope", baselineVerdict: "PASS", counterfactualVerdict: "SOFT-PASS" },
        { className: "history", baselineVerdict: "PASS", counterfactualVerdict: "SOFT-PASS" },
      ]);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(spawnSpy).not.toHaveBeenCalled();
      expect(readFileSync(join(source.root, "src", "x.ts"))).toEqual(sourceFileBefore);
      expect(digestPolicyState(join(source.root, ".reviewgate"))).toBe(stateBefore);
      expect(
        execFileSync("git", ["status", "--porcelain=v1"], {
          cwd: source.root,
          encoding: "utf8",
        }),
      ).toBe(statusBefore);
    } finally {
      fetchSpy.mockRestore();
      spawnSpy.mockRestore();
      for (const root of outputRoots) rmSync(root, { recursive: true, force: true });
      rmSync(source.root, { recursive: true, force: true });
    }
  });
});
