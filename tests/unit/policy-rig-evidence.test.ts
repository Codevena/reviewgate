import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { canonicalJson } from "../../src/audit/canonical.ts";
import { makeMetric, summarizeSpread } from "../../src/bench/metrics.ts";
import { aggregate } from "../../src/core/aggregator.ts";
import { validateFindingFacts } from "../../src/core/fact-check.ts";
import { computeFpClusters } from "../../src/core/fp-ledger/clusters.ts";
import { FpLedgerStore } from "../../src/core/fp-ledger/store.ts";
import { groundFindings } from "../../src/core/grounding.ts";
import { demoteHypotheticalCriticals } from "../../src/core/hypothetical-demote.ts";
import { ImplicitOutcomeStore } from "../../src/core/learnings/implicit-outcomes.ts";
import { deriveImplicitOutcomes } from "../../src/core/learnings/implicit-outcomes.ts";
import { POLICY_CATALOG_VERSION, POLICY_PASS_IDS } from "../../src/core/policy/catalog.ts";
import { capturePolicyReplayEnvelope } from "../../src/core/policy/replay-capture.ts";
import { PolicyTraceRecorder } from "../../src/core/policy/trace.ts";
import { mergeRegions } from "../../src/core/region-memory.ts";
import { ReputationStore } from "../../src/core/reputation/store.ts";
import { demoteSelfRefuting } from "../../src/core/self-refutation.ts";
import { StateStore } from "../../src/core/state-store.ts";
import { checkSeedLanded } from "../../src/rig/harvest.ts";
import { createPolicyStateSnapshot } from "../../src/rig/policy-replay-state.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import type { PolicyMeasurementPreregistration } from "../../src/schemas/policy-measurement-preregistration.ts";
import type { PolicyReplayEnvelopeInput } from "../../src/schemas/policy-replay.ts";
import { policyReplayCallId } from "../../src/schemas/policy-replay.ts";
import type { RigManifest } from "../../src/schemas/rig-manifest.ts";
import { type RigResult, RigResultSchema } from "../../src/schemas/rig-result.ts";
import type { RigTurnScript } from "../../src/schemas/rig-turn-script.ts";
import {
  POLICY_RIG_HISTORY_GROUP,
  collectPolicyRigEvidence,
  policyRigOpportunity,
  policyRigSeedTags,
} from "../../src/stats/policy/rig.ts";

const STATEFUL = [
  "history.fp-signature",
  "history.cycle-rejected",
  "history.fp-cluster",
  "judgment.reputation",
  "history.region-rejected",
] as const;
const HISTORY = [
  "history.fp-signature",
  "history.cycle-rejected",
  "history.fp-cluster",
  "history.region-rejected",
] as const;
const WRITES = new Set(["history.fp-signature", "history.fp-cluster", "judgment.reputation"]);
const OBSERVED_AT = "2026-08-11T12:00:00.000Z";

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function writeBound(root: string, ref: string, value: unknown): { ref: string; sha256: string } {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  const path = join(root, ref);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes, { mode: 0o600 });
  return { ref, sha256: sha256(bytes) };
}

function finding(passId: (typeof STATEFUL)[number], scenario: number, turn: number): Finding {
  const target = turn === 1;
  return {
    id: `F-${scenario}-${turn}`,
    signature:
      target && passId === "history.fp-signature"
        ? "active-signature"
        : target
          ? `${passId}-signature-${scenario}`
          : "plain-control",
    severity: "WARN",
    category: "quality",
    rule_id:
      target && passId === "history.fp-cluster"
        ? "cluster-target"
        : target
          ? `${passId.replaceAll(".", "-")}-rule`
          : "plain-control",
    file: "src/x.ts",
    line_start: target ? 1 : 30,
    line_end: target ? 1 : 30,
    message: `${passId} seeded defect`,
    details: "The seeded defect remains a blocking quality finding before history policy.",
    reviewer: {
      provider: "codex",
      model: "gpt-5",
      persona: !target && passId === "judgment.reputation" ? "control" : "quality",
    },
    confidence: 0.9,
    consensus: "singleton",
  };
}

async function stateFixture(passId: (typeof STATEFUL)[number]): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "rg-policy-rig-state-"));
  await new StateStore(root).initialise(`state-${passId}`);
  await new StateStore(root).update((state) => ({
    ...state,
    cycle_rejected_signatures: [
      passId === "history.cycle-rejected" ? `${passId}-signature-1` : "cycle-control",
      ...(passId === "history.cycle-rejected"
        ? [`${passId}-signature-2`, `${passId}-signature-3`]
        : []),
    ],
    cycle_rejected_dispositions: [
      {
        key: "1:F-001",
        file: "src/x.ts",
        start_line: passId === "history.region-rejected" ? 1 : 50,
        end_line: passId === "history.region-rejected" ? 1 : 50,
        severity: "WARN",
        categories: ["quality"],
        reason: "first explicit rejected region fixture",
      },
      {
        key: "2:F-002",
        file: "src/x.ts",
        start_line: passId === "history.region-rejected" ? 2 : 51,
        end_line: passId === "history.region-rejected" ? 2 : 51,
        severity: "WARN",
        categories: ["quality"],
        reason: "second explicit rejected region fixture",
      },
    ],
  }));

  const ledger = new FpLedgerStore(root);
  for (const [index, provider] of ["codex", "openrouter", "codex"].entries()) {
    await ledger.recordReject(
      "active-signature",
      { rule_id: "signature-control", category: "quality", file: "src/x.ts", symbol: "" },
      { run_id: `signature-${index}`, provider, reason: "real signature fixture rejection" },
      OBSERVED_AT,
    );
  }
  for (const [index, signature] of ["cluster-a", "cluster-b", "cluster-c"].entries()) {
    await ledger.recordReject(
      signature,
      {
        rule_id: signature === "cluster-a" ? "cluster-one" : "cluster-two",
        category: "quality",
        file: "src/x.ts",
        symbol: "",
      },
      {
        run_id: `cluster-${index}`,
        provider: index === 1 ? "openrouter" : "codex",
        reason: "real cluster fixture rejection",
      },
      OBSERVED_AT,
    );
  }
  await new ReputationStore(root).record(
    Array.from({ length: 8 }, (_, index) => ({
      reviewerKey: passId === "judgment.reputation" ? "codex:quality" : "codex:control",
      outcome: "wrong" as const,
      eid: `${passId}-wrong-${index}`,
      ts: OBSERVED_AT,
    })),
    { now: new Date(OBSERVED_AT), halfLifeDays: 45 },
  );
  if (!WRITES.has(passId)) {
    await new ImplicitOutcomeStore(root).append(
      [
        {
          schema: "reviewgate.implicit_outcome.v1",
          signature: "initial-outcome",
          reviewer_key: "codex:quality",
          category: "quality",
          demote_reason: "low_confidence",
          run_id: "seed-state",
          iter: 1,
          created_at: OBSERVED_AT,
        },
      ],
      100,
    );
  } else {
    // A production read of the genuinely absent write-only store is itself the initial input.
    expect(await new ImplicitOutcomeStore(root).load()).toEqual([]);
  }
  return root;
}

async function buildEnvelope(input: {
  sourceRepoRoot: string;
  stateRoot: string;
  stateSha256: string;
  passId: (typeof STATEFUL)[number];
  scenario: number;
  turn: number;
}): Promise<{ envelope: PolicyReplayEnvelopeInput; cassette: string }> {
  const runId = `${input.passId}-${input.scenario}-turn-${input.turn}`;
  const rawText = `recorded response ${runId}`;
  const rawHash = sha256(rawText);
  const promptSha256 = sha256(`prompt ${runId}`);
  const call = {
    call_id: policyReplayCallId({
      runId,
      iter: 1,
      kind: "reviewer",
      provider: "openrouter",
      method: "review",
      key: "openrouter-quality",
      promptSha256,
      ordinal: 0,
      slot: 0,
      attempt: 1,
      occurrence: 0,
    }),
    kind: "reviewer" as const,
    provider: "openrouter" as const,
    method: "review" as const,
    key: "openrouter-quality",
    prompt_sha256: promptSha256,
    ordinal: 0,
    slot: 0,
    attempt: 1,
    occurrence: 0,
    response_sha256: rawHash,
  };
  const fpStore = new FpLedgerStore(input.stateRoot);
  const fpSnapshot = await fpStore.snapshot();
  const fpActive = await fpStore.activeSnapshot(new Date(OBSERVED_AT));
  const fpClusters = new Map(
    computeFpClusters(fpSnapshot.entries, OBSERVED_AT)
      .filter((cluster) => cluster.stage === "active" || cluster.stage === "sticky")
      .map((cluster) => [cluster.key, { key: cluster.key, member_ids: cluster.member_ids }]),
  );
  const repUnreliable = await new ReputationStore(input.stateRoot).unreliableReviewers(
    { enabled: true, minSamples: 6, trustFloor: 0.45, halfLifeDays: 45 },
    new Date(OBSERVED_AT),
  );
  const state = await new StateStore(input.stateRoot).load();
  const rejectedRegions = mergeRegions(state.cycle_rejected_dispositions);
  const runtime = PolicyTraceRecorder.start({ runId, iter: 1, ablated: new Set() });
  const rawFinding = finding(input.passId, input.scenario, input.turn);
  const factChecked = validateFindingFacts([rawFinding], input.sourceRepoRoot, new Set(), runtime);
  const selfScreened = demoteSelfRefuting(factChecked, true, runtime);
  const hypothetical = demoteHypotheticalCriticals(selfScreened, true, runtime);
  const grounded = groundFindings(hypothetical, "", runtime);
  runtime.markInactive("judgment.grounding-llm", "configured-off");
  const policyInactive = {
    "judgment.critic": "configured-off" as const,
    "scope.diff": "configured-off" as const,
    "scope.delta": "stage-precondition-miss" as const,
    "scope.session": "stage-precondition-miss" as const,
  };
  const aggregateInput = {
    findings: grounded,
    reviewersTotal: 1,
    changedRanges: new Map<string, [number, number][]>(),
    scopeToDiff: false,
    outOfDiffBlocking: [] as Finding["category"][],
    confidenceFloor: 0,
    demoteCorrectness: true,
    corroborateCritical: true,
    demoteTestSecurity: true,
    capDocsSeverity: true,
    critic: new Map(),
    fpActive,
    fpActiveClusters: fpClusters,
    repUnreliable,
    protectedReviewers: new Set<string>(),
    foreignFiles: new Set<string>(),
    cycleRejected: new Set(state.cycle_rejected_signatures),
    claimedFixed: new Map(Object.entries(state.claimed_fixed_signatures)),
    deltaScope: new Set<string>(),
    rejectedRegions,
    policyRuntime: runtime,
    policyInactive,
  };
  const result = aggregate(aggregateInput);
  const policyTrace = runtime.finalize({
    rawResponseSha256: [rawHash],
    verdict: result.verdict,
    finalFindings: result.dedupedFindings,
  });
  if (policyTrace === null) throw new Error("fixture trace failed");
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: input.sourceRepoRoot,
    encoding: "utf8",
  }).trim();
  return {
    envelope: {
      schema: "reviewgate.policy-replay-envelope.v1",
      catalog_version: POLICY_CATALOG_VERSION,
      run_id: runId,
      iter: 1,
      source_commit: sourceCommit,
      exact_diff: "",
      pre_policy_findings: [rawFinding],
      grounding: { corpus: "", verdicts: [], llm_status: "not-run" },
      aggregate: {
        findings: grounded,
        reviewers_total: 1,
        changed_ranges: [],
        scope_to_diff: false,
        out_of_diff_blocking: [],
        confidence_floor: 0,
        demote_correctness: true,
        corroborate_critical: true,
        demote_test_security: true,
        cap_docs_severity: true,
        critic: [],
        fp_active: [...fpActive]
          .map(([signature, value]) => ({ signature, id: value.id }))
          .sort((a, b) => (a.signature < b.signature ? -1 : 1)),
        fp_active_clusters: [...fpClusters]
          .map(([key, value]) => ({ key, member_ids: [...value.member_ids].sort() }))
          .sort((a, b) => (a.key < b.key ? -1 : 1)),
        rep_unreliable: [...repUnreliable].sort(),
        protected_reviewers: [],
        foreign_files: [],
        cycle_rejected: [...state.cycle_rejected_signatures].sort(),
        claimed_fixed: [],
        delta_scope: [],
        rejected_regions: rejectedRegions,
        policy_inactive: Object.entries(policyInactive)
          .map(([pass_id, reason_code]) => ({ pass_id: pass_id as never, reason_code }))
          .sort((a, b) => (a.pass_id < b.pass_id ? -1 : 1)),
      },
      policy_final_findings: result.dedupedFindings,
      pre_policy: { self_refutation_enabled: true, hypothetical_enabled: true },
      state_sha256: input.stateSha256,
      raw_response_sha256: [rawHash],
      response_calls: [call],
      history: {
        fp_ledger: { enabled: true, active_at: OBSERVED_AT, clusters_at: OBSERVED_AT },
        reputation: {
          enabled: true,
          observed_at: OBSERVED_AT,
          min_samples: 6,
          trust_floor: 0.45,
          half_life_days: 45,
        },
        cycle_state: { source: "state.json", region_rejected_enabled: true },
        implicit_outcomes: { enabled: true, created_at: OBSERVED_AT, cap: 100 },
      },
      policy_trace: policyTrace,
      lossless: true,
    },
    cassette: `${JSON.stringify({
      schema: "reviewgate.cassette.entry.v1",
      provider: "openrouter",
      method: "review",
      key: call.key,
      promptSha256,
      policyReplayCall: {
        callId: call.call_id,
        runId,
        iter: 1,
        kind: call.kind,
        ordinal: 0,
        slot: 0,
        attempt: 1,
        occurrence: 0,
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
    })}\n`,
  };
}

function rigResult(input: {
  manifest: RigManifest;
  manifestSha256: string;
  script: RigTurnScript;
  findings: Finding[][];
  stateSha256: string[];
  scriptSha256: string;
  seedLanded: boolean[];
}): RigResult {
  const turns = input.manifest.turns.map((turn, index) => ({
    index: turn.index,
    seededId: input.script.turns[index]?.seeded?.id ?? null,
    iterations: 1,
    findingsTotal: input.findings[index]?.length ?? 0,
    blockingTotal: input.findings[index]?.filter((item) => item.severity !== "INFO").length ?? 0,
    rejectedAsFp: 0,
    fpBurden: input.findings[index]?.length ? 0 : null,
    caught: false,
    escaped: false,
    seedLanded: input.seedLanded[index] ?? null,
    costUsd: 0,
    durationMs: 1,
    agentExitCode: 0,
    wallMs: 1,
    suppressed: { critic: 0, reputation: 0, fp_ledger: 0, lore: 0 },
    findings: input.findings[index] ?? [],
    policyReplay: {
      status: "complete" as const,
      traces: (turn.policyReplay?.traces ?? []).map((trace) => ({
        ...trace,
        runId: `${input.script.id}-turn-${turn.index}`,
        iter: 1,
        stateSha256: input.stateSha256[index] ?? "",
        lossless: true,
      })),
      reason: null,
    },
  }));
  return RigResultSchema.parse({
    schema: "reviewgate.rig.result.v1",
    runId: input.manifest.runId,
    provenance: {
      reviewgate_version: "0.1.0-test",
      harvested_at: OBSERVED_AT,
      run_id: input.manifest.runId,
      script_id: input.script.id,
      script_path: `${input.script.id}.json`,
      manifest_path: "manifest.json",
      turn_count: { harvested: 2, seeded: 2, clean: 0, script_total: 2 },
      panel: [{ provider: "openrouter", model: "fixture", persona: "quality" }],
      host_os: "test",
    },
    turns,
    metrics: {
      iterations: {
        median: 1,
        spread: summarizeSpread([1, 1]),
      },
      fpBurdenSlope: { slope: null, n: 2 },
      recall: makeMetric(0, 2),
      escapeRate: makeMetric(0, 2),
      cost: {
        totalUsd: 0,
        totalDurationMs: 2,
        perTurnUsd: summarizeSpread([0, 0]),
      },
      suppression: { critic: 0, reputation: 0, fp_ledger: 0, lore: 0 },
    },
    policyReplay: {
      authoritative: true,
      catalogVersion: POLICY_CATALOG_VERSION,
      sourceCommit: input.manifest.policyReplay?.sourceCommit ?? null,
      passIds: [...POLICY_PASS_IDS],
      reason: null,
      artifactBinding: {
        manifestRef: "manifest.json",
        manifestSha256: input.manifestSha256,
        scriptId: input.script.id,
        scriptSha256: input.scriptSha256,
        initialStateRef: input.manifest.policyReplay?.initialStateRef,
        initialStateSha256: input.manifest.policyReplay?.initialStateSha256,
        initialStateDigest: input.manifest.policyReplay?.initialStateDigest,
        cassetteRef: "cassette.jsonl",
        cassetteSha256: input.manifest.policyReplay?.cassetteSha256,
        turns: input.manifest.turns.map((turn) => ({
          index: turn.index,
          traces: turn.policyReplay?.traces ?? [],
        })),
      },
    },
    warnings: [],
  });
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "rg-policy-rig-evidence-"));
  execFileSync("git", ["init", "-q", "."], { cwd: root });
  execFileSync("git", ["config", "user.email", "rig@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "rig"], { cwd: root });
  mkdirSync(join(root, "src"));
  writeFileSync(
    join(root, "src", "x.ts"),
    `${Array.from({ length: 60 }, (_, index) => `export const x${index + 1} = ${index + 1};`).join(
      "\n",
    )}\n`,
  );
  execFileSync("git", ["add", "src/x.ts"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "source"], { cwd: root });
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const scenarios: Array<{
    id: string;
    pass_id: (typeof STATEFUL)[number];
    manifest: { ref: string; sha256: string };
    result: { ref: string; sha256: string };
    script: { ref: string; sha256: string };
    initial_state: { ref: string; sha256: string };
    expected_opportunity_turns: 2;
  }> = [];
  for (const passId of STATEFUL) {
    for (let scenario = 1; scenario <= 3; scenario += 1) {
      const stateSource = await stateFixture(passId);
      const output = mkdtempSync(join(tmpdir(), "rg-policy-rig-output-"));
      const sinkDir = join(output, "policy-replay");
      mkdirSync(sinkDir, { mode: 0o700 });
      const traces: Array<{ ref: string; sha256: string }> = [];
      const finalFindings: Finding[][] = [];
      const states: ReturnType<typeof createPolicyStateSnapshot>[] = [];
      const cassette: string[] = [];
      for (let turn = 1; turn <= 2; turn += 1) {
        const state = createPolicyStateSnapshot({
          sourceRepoRoot: stateSource,
          outputRoot: output,
        });
        states.push(state);
        const built = await buildEnvelope({
          sourceRepoRoot: root,
          stateRoot: stateSource,
          stateSha256: state.stateSha256,
          passId,
          scenario,
          turn,
        });
        const stored = capturePolicyReplayEnvelope({
          sinkDir,
          measuredRepoRoot: root,
          envelope: built.envelope,
        });
        if (stored.status !== "complete") throw new Error(`capture failed: ${stored.reason}`);
        traces.push({ ref: stored.ref, sha256: stored.sha256 });
        finalFindings.push(stored.envelope.policy_final_findings);
        cassette.push(built.cassette);
        if (turn === 1 && WRITES.has(passId)) {
          // The next captured snapshot contains the real baseline outcome. Persistent replay must
          // retain the baseline branch's write and the counterfactual branch's absence ownership.
          const implicitHistory = stored.envelope.history.implicit_outcomes;
          if (!implicitHistory.enabled) throw new Error("fixture disabled implicit outcomes");
          await new ImplicitOutcomeStore(stateSource).append(
            deriveImplicitOutcomes(stored.envelope.policy_final_findings, [], {
              runId: stored.envelope.run_id,
              iter: stored.envelope.iter,
              nowIso: implicitHistory.created_at,
            }),
            implicitHistory.cap,
          );
        }
      }
      const initialState = states[0];
      if (initialState === undefined) throw new Error("fixture omitted initial state");
      const cassetteBytes = cassette.join("");
      writeFileSync(join(output, "cassette.jsonl"), cassetteBytes, { mode: 0o600 });
      const scriptId = `${passId}-${scenario}`;
      const id = `${scriptId}-2026-08-11T12-00-00-000Z`;
      const script: RigTurnScript = {
        schema: "reviewgate.rig.turn-script.v1",
        id: scriptId,
        turns: [1, 2].map((turn) => ({
          index: turn,
          prompt: `create ${passId} opportunity ${turn}`,
          seeded: {
            id: `${scriptId}-seed-${turn}`,
            tags: [passId, "seeded defect"],
            severity: "warn" as const,
            landedPattern: `task-7-landed-${scriptId}-${turn}`,
          },
        })),
      };
      const scriptBytes = Buffer.from(JSON.stringify(script), "utf8");
      const scriptSha256 = sha256(scriptBytes);
      const seedLanded = script.turns.map((turn) => {
        const snapshotDir = join(output, "turns", String(turn.index));
        mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
        writeFileSync(
          join(snapshotDir, "diff.patch"),
          `diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1,2 @@\n+task-7-landed-${scriptId}-${turn.index}\n`,
          { mode: 0o600 },
        );
        const warnings: string[] = [];
        const landed = checkSeedLanded(snapshotDir, turn.index, turn.seeded, warnings);
        if (landed !== true || warnings.length > 0) {
          throw new Error(`fixture seed landing was not verified: ${warnings.join("; ")}`);
        }
        return landed;
      });
      const manifest: RigManifest = {
        schema: "reviewgate.rig.manifest.v1",
        runId: id,
        scriptId,
        scriptSha256,
        outDir: output,
        policyReplay: {
          catalogVersion: POLICY_CATALOG_VERSION,
          sourceCommit,
          initialStateRef: initialState.ref,
          initialStateSha256: initialState.sha256,
          initialStateDigest: initialState.stateSha256,
          cassetteRef: "cassette.jsonl",
          cassetteSha256: sha256(cassetteBytes),
          captureDir: "policy-replay",
        },
        turns: traces.map((trace, index) => ({
          index: index + 1,
          snapshotDir: join(output, "turns", String(index + 1)),
          agentExitCode: 0,
          wallMs: 1,
          policyReplay: { status: "complete", traces: [trace] },
        })),
      };
      const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
      writeFileSync(join(output, "manifest.json"), manifestBytes, { mode: 0o600 });
      const result = rigResult({
        manifest,
        manifestSha256: sha256(manifestBytes),
        script,
        findings: finalFindings,
        stateSha256: states.map((state) => state.stateSha256),
        scriptSha256,
        seedLanded,
      });
      writeFileSync(join(output, "result.json"), JSON.stringify(result), { mode: 0o600 });
      writeFileSync(join(output, "script.json"), scriptBytes, { mode: 0o600 });
      const artifactDir = join(root, "artifacts", id);
      cpSync(output, artifactDir, { recursive: true });
      const ref = (name: string) => relative(root, join(artifactDir, name)).replaceAll("\\", "/");
      scenarios.push({
        id,
        pass_id: passId,
        manifest: { ref: ref("manifest.json"), sha256: sha256(manifestBytes) },
        result: {
          ref: ref("result.json"),
          sha256: sha256(readFileSync(join(artifactDir, "result.json"))),
        },
        script: {
          ref: ref("script.json"),
          sha256: sha256(readFileSync(join(artifactDir, "script.json"))),
        },
        initial_state: {
          ref: ref(initialState.ref),
          sha256: initialState.sha256,
        },
        expected_opportunity_turns: 2,
      });
    }
  }
  const manifest = { schema: "reviewgate.policy-rig-scenarios.v1" as const, scenarios };
  const manifestRef = "artifacts/policy-rig-scenarios.json";
  const manifestBytes = Buffer.from(canonicalJson(manifest), "utf8");
  writeFileSync(join(root, manifestRef), manifestBytes, { mode: 0o600 });
  return {
    root,
    manifest,
    preregistration: {
      stateful: {
        manifest_ref: manifestRef,
        manifest_sha256: sha256(manifestBytes),
        min_sequences_per_pass: 3,
        min_opportunity_turns: 2,
      },
    } as unknown as PolicyMeasurementPreregistration,
  };
}

type EvidenceFixture = Awaited<ReturnType<typeof fixture>>;
let sharedFixture: Promise<EvidenceFixture> | undefined;

function getFixture(): Promise<EvidenceFixture> {
  sharedFixture ??= fixture();
  return sharedFixture;
}

function rewriteScenarioManifest(input: EvidenceFixture): void {
  const bytes = Buffer.from(canonicalJson(input.manifest), "utf8");
  writeFileSync(join(input.root, input.preregistration.stateful.manifest_ref), bytes, {
    mode: 0o600,
  });
  input.preregistration.stateful.manifest_sha256 = sha256(bytes);
}

describe("policy Rig evidence", () => {
  test("rejects unknown seed landing before treating script tags as truth", () => {
    const seeded = { tags: ["defect"] };
    expect(() => policyRigSeedTags(seeded, null)).toThrow(/landing/i);
    expect(() => policyRigSeedTags(seeded, undefined)).toThrow(/landing/i);
    expect(policyRigSeedTags(seeded, true)).toEqual(["defect"]);
    expect(policyRigSeedTags(null, null)).toBeNull();
  });

  test("keeps all four history interaction passes in catalog order", () => {
    expect(POLICY_RIG_HISTORY_GROUP).toEqual([...HISTORY]);
  });

  test("collects three independent real-store sequences per stateful pass and the 4/4 history group", async () => {
    const input = await getFixture();
    const evidence = await collectPolicyRigEvidence({
      preregistration: input.preregistration,
      manifest: input.manifest,
      sourceRepoRoot: input.root,
    });

    expect(evidence.sequences).toHaveLength(15);
    expect(evidence.source_commit).toMatch(/^[0-9a-f]{40}$/);
    expect(evidence.artifact_inventory_sha256).toBe(sha256(canonicalJson(evidence.artifacts)));
    const declaredRefs = [
      input.preregistration.stateful.manifest_ref,
      ...input.manifest.scenarios.flatMap((scenario) => [
        scenario.manifest.ref,
        scenario.result.ref,
        scenario.script.ref,
        scenario.initial_state.ref,
      ]),
    ].sort();
    expect(evidence.artifacts).toHaveLength(217);
    expect(
      evidence.artifacts
        .filter((artifact) => declaredRefs.includes(artifact.ref))
        .map((row) => row.ref),
    ).toEqual(declaredRefs);
    expect(evidence.artifacts.filter((artifact) => artifact.kind === "cassette")).toHaveLength(15);
    expect(evidence.artifacts.filter((artifact) => artifact.kind === "trace")).toHaveLength(30);
    expect(evidence.artifacts.filter((artifact) => artifact.kind === "state")).toHaveLength(126);
    expect(evidence.artifacts.map((row) => row.ref)).toEqual(
      [...evidence.artifacts.map((row) => row.ref)].sort(),
    );
    expect(evidence.artifacts.some((row) => row.kind === "cassette")).toBe(true);
    expect(evidence.artifacts.some((row) => row.kind === "trace")).toBe(true);
    expect(evidence.artifacts.some((row) => row.kind === "state")).toBe(true);
    for (const passId of STATEFUL) {
      const sequences = evidence.sequences.filter((sequence) => sequence.pass_id === passId);
      expect(sequences, passId).toHaveLength(3);
      expect(
        sequences.map((sequence) => sequence.opportunity_turns),
        passId,
      ).toEqual([2, 2, 2]);
      expect(
        sequences.every((sequence) => sequence.turns.every((turn) => turn.opportunity.observed)),
        passId,
      ).toBe(true);
      expect(
        sequences.every((sequence) =>
          sequence.turns.every(
            (turn) =>
              turn.baseline.state.history_reads >= 5 &&
              turn.counterfactual.state.history_reads >= 5,
          ),
        ),
        passId,
      ).toBe(true);
      if (WRITES.has(passId)) {
        expect(
          sequences.every(
            (sequence) =>
              sequence.turns[1]?.baseline.state.digest !==
              sequence.turns[1]?.counterfactual.state.digest,
          ),
          passId,
        ).toBe(true);
      } else {
        expect(
          sequences.every(
            (sequence) =>
              sequence.turns[1]?.baseline.state.digest ===
                sequence.turns[1]?.counterfactual.state.digest &&
              sequence.turns.every(
                (turn) =>
                  turn.baseline.state.history_writes === 0 &&
                  turn.counterfactual.state.history_writes === 0,
              ),
          ),
          passId,
        ).toBe(true);
      }
      if (HISTORY.includes(passId as never)) {
        expect(
          sequences.every((sequence) =>
            sequence.history_interaction?.pass_ids.every(
              (member, index) => member === HISTORY[index],
            ),
          ),
          passId,
        ).toBe(true);
      } else {
        expect(sequences.every((sequence) => sequence.history_interaction === null)).toBe(true);
      }
    }
  }, 120_000);

  test("rejects swapped or tampered result, script, and bound Rig artifacts", async () => {
    const input = await getFixture();
    const first = input.manifest.scenarios[0];
    const second = input.manifest.scenarios[1];
    if (first === undefined || second === undefined) throw new Error("fixture scenarios missing");
    const originalResult = structuredClone(first.result);
    const originalScript = structuredClone(first.script);
    const assertRejected = async (name: string) => {
      await expect(
        collectPolicyRigEvidence({
          preregistration: input.preregistration,
          manifest: input.manifest,
          sourceRepoRoot: input.root,
        }),
        name,
      ).rejects.toThrow();
    };

    first.result = structuredClone(second.result);
    rewriteScenarioManifest(input);
    await assertRejected("swapped result binding");
    first.result = originalResult;
    rewriteScenarioManifest(input);

    first.script = structuredClone(second.script);
    rewriteScenarioManifest(input);
    await assertRejected("swapped script binding");
    first.script = originalScript;
    rewriteScenarioManifest(input);

    const originalId = first.id;
    first.id = "different-scenario-identity";
    rewriteScenarioManifest(input);
    await assertRejected("scenario identity mismatch");
    first.id = originalId;
    rewriteScenarioManifest(input);

    const artifactRoot = dirname(join(input.root, first.manifest.ref));
    const cassettePath = join(artifactRoot, "cassette.jsonl");
    const cassetteBytes = readFileSync(cassettePath);
    writeFileSync(cassettePath, "tampered\n", { mode: 0o600 });
    await assertRejected("tampered cassette");
    writeFileSync(cassettePath, cassetteBytes, { mode: 0o600 });

    const manifestPath = join(input.root, first.manifest.ref);
    const resultPath = join(input.root, first.result.ref);
    const manifestBytes = readFileSync(manifestPath);
    const resultBytes = readFileSync(resultPath);
    const rigManifest = JSON.parse(manifestBytes.toString("utf8"));
    const result = JSON.parse(resultBytes.toString("utf8"));
    rigManifest.turns[0].policyReplay = { status: "missing", traces: [] };
    const changedManifest = Buffer.from(JSON.stringify(rigManifest), "utf8");
    writeFileSync(manifestPath, changedManifest, { mode: 0o600 });
    result.turns[0].policyReplay = { status: "missing", traces: [], reason: "missing fixture" };
    result.policyReplay.artifactBinding.turns[0].traces = [];
    result.policyReplay.artifactBinding.manifestSha256 = sha256(changedManifest);
    const changedResult = Buffer.from(JSON.stringify(result), "utf8");
    writeFileSync(resultPath, changedResult, { mode: 0o600 });
    first.manifest.sha256 = sha256(changedManifest);
    first.result.sha256 = sha256(changedResult);
    rewriteScenarioManifest(input);
    await assertRejected("missing trace");
    writeFileSync(manifestPath, manifestBytes, { mode: 0o600 });
    writeFileSync(resultPath, resultBytes, { mode: 0o600 });
    first.manifest.sha256 = sha256(manifestBytes);
    first.result.sha256 = sha256(resultBytes);
    rewriteScenarioManifest(input);
  }, 120_000);

  test("does not turn ran-with-zero-opportunity into an opportunity carrier", async () => {
    const input = await getFixture();
    const first = input.manifest.scenarios[0];
    if (first === undefined) throw new Error("fixture scenario missing");
    const manifestPath = join(input.root, first.manifest.ref);
    const rigManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const traceRef = rigManifest.turns[0].policyReplay.traces[0].ref;
    const tracePath = join(dirname(manifestPath), "policy-replay", traceRef);
    const envelope = JSON.parse(readFileSync(tracePath, "utf8"));
    const pass = envelope.policy_trace.passes.find(
      (row: { pass_id: string }) => row.pass_id === first.pass_id,
    );
    pass.considered = 0;
    pass.opportunities = 0;
    pass.would_apply = 0;
    pass.applied = 0;
    pass.protected = 0;
    pass.blocking_removed = 0;
    pass.blocking_preserved = 0;
    pass.dropped = 0;
    envelope.policy_trace.evaluations = envelope.policy_trace.evaluations.filter(
      (row: { pass_id: string }) => row.pass_id !== first.pass_id,
    );
    expect(policyRigOpportunity(envelope.policy_trace, [first.pass_id])).toEqual({
      summary: 0,
      evaluations: 0,
      stages: 0,
      observed: false,
    });
  }, 60_000);
});
