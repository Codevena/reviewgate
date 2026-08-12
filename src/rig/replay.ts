// src/rig/replay.ts
// Exact new runs replay captured policy inputs through production pass functions in isolated
// checkouts. Legacy runs retain the older deterministic harvest/heuristic self-check, explicitly
// non-authoritative for policy ablation rather than pretending missing opportunities were zero.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { canonicalJson } from "../audit/canonical.ts";
import { type AggregateInput, aggregate } from "../core/aggregator.ts";
import { validateFindingFacts } from "../core/fact-check.ts";
import { computeFpClusters } from "../core/fp-ledger/clusters.ts";
import { learnFromDecisions } from "../core/fp-ledger/learn.ts";
import { FpLedgerStore } from "../core/fp-ledger/store.ts";
import { applyGroundingJudgeVerdicts, groundFindings } from "../core/grounding.ts";
import { demoteHypotheticalCriticals } from "../core/hypothetical-demote.ts";
import {
  ImplicitOutcomeStore,
  deriveImplicitOutcomes,
} from "../core/learnings/implicit-outcomes.ts";
import type { PolicyPassId } from "../core/policy/catalog.ts";
import { POLICY_PASS_IDS } from "../core/policy/catalog.ts";
import { PolicyTraceRecorder } from "../core/policy/trace.ts";
import { mergeRegions } from "../core/region-memory.ts";
import { learnReputationFromDecisions } from "../core/reputation/learn.ts";
import { ReputationStore } from "../core/reputation/store.ts";
import { demoteSelfRefuting } from "../core/self-refutation.ts";
import { StateStore } from "../core/state-store.ts";
import { parseDeletedPaths } from "../diff/hunks.ts";
import { CassetteEntrySchema } from "../schemas/cassette.ts";
import type { Finding } from "../schemas/finding.ts";
import type { PolicyReplayEnvelope } from "../schemas/policy-replay.ts";
import type { PolicyTrace } from "../schemas/policy-trace.ts";
import { type RigManifest, RigManifestSchema } from "../schemas/rig-manifest.ts";
import type { RigResult } from "../schemas/rig-result.ts";
import { compareCodeUnits } from "../utils/compare.ts";
import { implicitOutcomesPath, knownFpPath, reputationJsonPath } from "../utils/paths.ts";
import { type RigAblation, SUPPRESSION_LAYERS, ablate, seededTagsFromScript } from "./ablate.ts";
import { harvest } from "./harvest.ts";
import {
  type ReplayBranches,
  RigAuthorityError,
  advanceReplayBranches,
  cleanupReplayBranches,
  createReplayBranches,
  digestPolicyState,
  recordReplayBranchStateDecision,
  validateRigPolicyReplayArtifacts,
} from "./policy-replay-state.ts";

export interface CassetteIntegrity {
  entries: number;
  malformedLines: number;
  /** Recorded review/complete calls per reviewer key, in FIFO order of first appearance. */
  byKey: Record<string, number>;
  /** Recorded REVIEW calls that carried at least one finding. Not an integrity signal —
   *  a reviewer legitimately returns none — but it separates "40 calls recorded" from
   *  "40 calls recorded and every one of them was empty", which look identical in a count. */
  reviewsWithFindings: number;
}

export interface ReplayReport {
  deterministic: boolean;
  /** Human-readable differences; empty when deterministic. */
  differences: string[];
  cassette: CassetteIntegrity | null;
  turns: number;
  policy?: {
    authoritative: boolean;
    envelopes: number;
    passIds: PolicyPassId[];
  };
}

export interface PolicyReplayPair {
  baseline: PolicyTrace;
  counterfactual: PolicyTrace;
  /** Final production findings, retained as structured data for truth matching. */
  findings: { baseline: Finding[]; counterfactual: Finding[] };
  state: {
    baseline: PolicyReplayBranchStateEvidence;
    counterfactual: PolicyReplayBranchStateEvidence;
  };
}

export interface PolicyReplayBranchStateEvidence {
  digest: string;
  implicit_outcomes: number;
  history_reads: number;
  history_writes: number;
}

export interface PolicyReplaySequenceItem {
  envelope: PolicyReplayEnvelope;
  stateSnapshotRoot: string;
}

export interface RigPolicyAblationRow {
  passId: PolicyPassId;
  authoritative: boolean;
  reason: string | null;
  envelopes: number;
  opportunities: number;
  applied: number;
  wouldApplyWithoutMutation: number;
  baselineBlocking: number;
  counterfactualBlocking: number;
}

/**
 * Hard offline ceiling around the synchronous production-policy replay.
 *
 * Replay has no adapter parameter, but this second boundary converts an accidental network or
 * Bun subprocess call added inside a policy pass into the typed authority failure promised by the
 * CLI. The originals are restored even when the attempted call throws.
 */
export function runWithReplayProviderCeiling<T>(operation: () => T): T {
  const bunRuntime = Bun as unknown as { spawn: (...args: unknown[]) => unknown };
  const originalFetch = globalThis.fetch;
  const originalSpawn = bunRuntime.spawn;
  const reject = (capability: string): never => {
    throw new RigAuthorityError(
      "live-provider-call",
      `authoritative policy replay attempted ${capability}`,
    );
  };
  globalThis.fetch = (() => reject("a network call")) as unknown as typeof fetch;
  bunRuntime.spawn = () => reject("a provider subprocess call");
  const restore = (): void => {
    globalThis.fetch = originalFetch;
    bunRuntime.spawn = originalSpawn;
  };
  try {
    const result = operation();
    if (result instanceof Promise) {
      return result.finally(restore) as T;
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function historyMismatch(label: string): never {
  throw new RigAuthorityError(
    "state-digest-mismatch",
    `branch-local production history does not match captured ${label}`,
  );
}

async function assertBranchHistoryInputs(
  envelope: PolicyReplayEnvelope,
  checkoutRoot: string,
): Promise<number> {
  let reads = 0;
  if (envelope.history.fp_ledger.enabled) {
    const store = new FpLedgerStore(checkoutRoot);
    const full = await store.snapshot();
    reads += 1;
    const active = await store.activeSnapshot(new Date(envelope.history.fp_ledger.active_at));
    reads += 1;
    const actualActive = [...active]
      .map(([signature, value]) => ({ signature, id: value.id }))
      .sort((left, right) => compareCodeUnits(left.signature, right.signature));
    const actualClusters = computeFpClusters(full.entries, envelope.history.fp_ledger.clusters_at)
      .filter((cluster) => cluster.stage === "active" || cluster.stage === "sticky")
      .map((cluster) => ({
        key: cluster.key,
        member_ids: [...cluster.member_ids].sort(compareCodeUnits),
      }))
      .sort((left, right) => compareCodeUnits(left.key, right.key));
    if (canonicalJson(actualActive) !== canonicalJson(envelope.aggregate.fp_active)) {
      historyMismatch("fp-ledger active signatures");
    }
    if (canonicalJson(actualClusters) !== canonicalJson(envelope.aggregate.fp_active_clusters)) {
      historyMismatch("fp-ledger clusters");
    }
  } else if (
    envelope.aggregate.fp_active.length > 0 ||
    envelope.aggregate.fp_active_clusters.length > 0
  ) {
    historyMismatch("disabled fp-ledger inputs");
  }

  if (envelope.history.reputation.enabled) {
    const config = envelope.history.reputation;
    const unreliable = await new ReputationStore(checkoutRoot).unreliableReviewers(
      {
        enabled: true,
        minSamples: config.min_samples,
        trustFloor: config.trust_floor,
        halfLifeDays: config.half_life_days,
      },
      new Date(config.observed_at),
    );
    reads += 1;
    const actual = [...unreliable].sort(compareCodeUnits);
    if (canonicalJson(actual) !== canonicalJson(envelope.aggregate.rep_unreliable)) {
      historyMismatch("reviewer reputation");
    }
  } else if (envelope.aggregate.rep_unreliable.length > 0) {
    historyMismatch("disabled reputation inputs");
  }

  const state = await new StateStore(checkoutRoot).load();
  reads += 1;
  const cycleRejected = [...state.cycle_rejected_signatures].sort(compareCodeUnits);
  const claimedFixed = Object.entries(state.claimed_fixed_signatures)
    .map(([signature, iter]) => ({ signature, iter }))
    .sort((left, right) => compareCodeUnits(left.signature, right.signature));
  const rejectedRegions = envelope.history.cycle_state.region_rejected_enabled
    ? mergeRegions(state.cycle_rejected_dispositions)
        .map((region) => ({
          ...region,
          categories: [...region.categories].sort(compareCodeUnits),
        }))
        .sort(
          (left, right) =>
            compareCodeUnits(left.file, right.file) ||
            left.start_line - right.start_line ||
            left.end_line - right.end_line,
        )
    : [];
  if (canonicalJson(cycleRejected) !== canonicalJson(envelope.aggregate.cycle_rejected)) {
    historyMismatch("cycle-rejected signatures");
  }
  if (canonicalJson(claimedFixed) !== canonicalJson(envelope.aggregate.claimed_fixed)) {
    historyMismatch("claimed-fixed signatures");
  }
  if (canonicalJson(rejectedRegions) !== canonicalJson(envelope.aggregate.rejected_regions)) {
    historyMismatch("cycle region memory");
  }
  if (envelope.history.implicit_outcomes.enabled) {
    // The production store is write-only for policy decisions. Reading it here establishes that
    // the branch-local persisted input is real without inventing a causal policy dependency.
    await new ImplicitOutcomeStore(checkoutRoot).load();
    reads += 1;
  }
  return reads;
}

async function applyCapturedHumanLearning(
  envelope: PolicyReplayEnvelope,
  branch: ReplayBranches["baseline"],
): Promise<number> {
  const checkoutRoot = branch.checkoutRoot;
  const state = await new StateStore(checkoutRoot).load();
  if (state.iteration < 1) return 0;
  let writes = 0;
  if (envelope.history.fp_ledger.enabled) {
    const path = knownFpPath(checkoutRoot);
    const before = readOptionalStateFile(path);
    const store = new FpLedgerStore(checkoutRoot);
    await learnFromDecisions({
      repoRoot: checkoutRoot,
      prevIter: state.iteration,
      sessionId: state.session_id,
      cycleSeq: state.reputation_cycle_seq,
      store,
      nowIso: envelope.history.fp_ledger.active_at,
    });
    await store.decayPass(envelope.history.fp_ledger.active_at);
    if (!sameOptionalBytes(before, readOptionalStateFile(path))) {
      recordReplayBranchStateDecision(branch, path);
    }
    writes += 1;
  }
  if (envelope.history.reputation.enabled) {
    const path = reputationJsonPath(checkoutRoot);
    const before = readOptionalStateFile(path);
    await learnReputationFromDecisions({
      repoRoot: checkoutRoot,
      iter: state.iteration,
      sessionId: state.session_id,
      cycleSeq: state.reputation_cycle_seq,
      store: new ReputationStore(checkoutRoot),
      nowIso: envelope.history.reputation.observed_at,
      halfLifeDays: envelope.history.reputation.half_life_days,
    });
    if (!sameOptionalBytes(before, readOptionalStateFile(path))) {
      recordReplayBranchStateDecision(branch, path);
    }
    writes += 1;
  }
  return writes;
}

function readOptionalStateFile(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function sameOptionalBytes(left: Buffer | null, right: Buffer | null): boolean {
  return left === null ? right === null : right !== null && left.equals(right);
}

function aggregateInputFromEnvelope(
  envelope: PolicyReplayEnvelope,
  findings: PolicyReplayEnvelope["aggregate"]["findings"],
  runtime: PolicyTraceRecorder,
): AggregateInput {
  const aggregate = envelope.aggregate;
  const policyInactive = Object.fromEntries(
    aggregate.policy_inactive.map((entry) => [entry.pass_id, entry.reason_code]),
  ) as NonNullable<AggregateInput["policyInactive"]>;
  return {
    findings,
    reviewersTotal: aggregate.reviewers_total,
    changedRanges: new Map(
      aggregate.changed_ranges.map((entry) => [
        entry.file,
        entry.ranges.map((range) => [range.start, range.end] as [number, number]),
      ]),
    ),
    scopeToDiff: aggregate.scope_to_diff,
    outOfDiffBlocking: [...aggregate.out_of_diff_blocking],
    confidenceFloor: aggregate.confidence_floor,
    demoteCorrectness: aggregate.demote_correctness,
    corroborateCritical: aggregate.corroborate_critical,
    demoteTestSecurity: aggregate.demote_test_security,
    capDocsSeverity: aggregate.cap_docs_severity,
    critic: new Map(
      aggregate.critic.map(({ signature, verdict, reason }) => [
        signature,
        { verdict, ...(reason === undefined ? {} : { reason }) },
      ]),
    ),
    fpActive: new Map(aggregate.fp_active.map(({ signature, id }) => [signature, { id }])),
    fpActiveClusters: new Map(
      aggregate.fp_active_clusters.map(({ key, member_ids }) => [
        key,
        { key, member_ids: [...member_ids] },
      ]),
    ),
    repUnreliable: new Set(aggregate.rep_unreliable),
    protectedReviewers: new Set(aggregate.protected_reviewers),
    foreignFiles: new Set(aggregate.foreign_files),
    cycleRejected: new Set(aggregate.cycle_rejected),
    claimedFixed: new Map(aggregate.claimed_fixed.map(({ signature, iter }) => [signature, iter])),
    deltaScope: new Set(aggregate.delta_scope),
    rejectedRegions: structuredClone(aggregate.rejected_regions),
    policyRuntime: runtime,
    policyInactive,
  };
}

interface ReplayPolicyExecution {
  trace: PolicyTrace;
  dedupedFindings: PolicyReplayEnvelope["policy_final_findings"];
  criticDropped: PolicyReplayEnvelope["policy_final_findings"];
}

function normalizeAblatedPassIds(passIds: readonly PolicyPassId[]): PolicyPassId[] {
  const requested = new Set<string>(passIds);
  if (requested.size === 0) {
    throw new RigAuthorityError(
      "invalid-trace",
      "policy replay profile requires at least one pass",
    );
  }
  for (const passId of requested) {
    if (!POLICY_PASS_IDS.includes(passId as PolicyPassId)) {
      throw new RigAuthorityError("invalid-trace", `unknown policy replay pass ${passId}`);
    }
  }
  return POLICY_PASS_IDS.filter((passId) => requested.has(passId));
}

function replayEnvelopeProductionPath(input: {
  envelope: PolicyReplayEnvelope;
  checkoutRoot: string;
  ablated: ReadonlySet<PolicyPassId>;
  verifyOriginal: boolean;
}): ReplayPolicyExecution {
  const { envelope } = input;
  const runtime = PolicyTraceRecorder.start({
    runId: envelope.run_id,
    iter: envelope.iter,
    ablated: input.ablated,
  });
  const factChecked = validateFindingFacts(
    structuredClone(envelope.pre_policy_findings),
    input.checkoutRoot,
    parseDeletedPaths(envelope.exact_diff),
    runtime,
  );
  if (!envelope.pre_policy.self_refutation_enabled) {
    runtime.markInactive("evidence.self-refutation", "configured-off");
  }
  const selfScreened = demoteSelfRefuting(
    factChecked,
    envelope.pre_policy.self_refutation_enabled,
    runtime,
  );
  if (!envelope.pre_policy.hypothetical_enabled) {
    runtime.markInactive("judgment.hypothetical", "configured-off");
  }
  const hypothetical = demoteHypotheticalCriticals(
    selfScreened,
    envelope.pre_policy.hypothetical_enabled,
    runtime,
  );
  let grounded = groundFindings(hypothetical, envelope.grounding.corpus, runtime);
  const groundingSummary = envelope.policy_trace.passes.find(
    (pass) => pass.pass_id === "judgment.grounding-llm",
  );
  if (groundingSummary?.status === "not-run") {
    const reason = groundingSummary.reason_code;
    if (reason !== "configured-off" && reason !== "stage-precondition-miss") {
      throw new Error("captured grounding inactivity reason is invalid");
    }
    runtime.markInactive("judgment.grounding-llm", reason);
  } else {
    grounded = applyGroundingJudgeVerdicts(
      grounded,
      new Map(
        envelope.grounding.verdicts.map(({ signature, grounded: isGrounded, reason }) => [
          signature,
          { grounded: isGrounded, ...(reason === undefined ? {} : { reason }) },
        ]),
      ),
      runtime,
    );
  }
  if (
    input.verifyOriginal &&
    canonicalJson(grounded) !== canonicalJson(envelope.aggregate.findings)
  ) {
    throw new Error("captured aggregate findings do not match production pre-policy replay");
  }
  const result = aggregate(aggregateInputFromEnvelope(envelope, grounded, runtime));
  if (
    input.verifyOriginal &&
    canonicalJson(result.dedupedFindings) !== canonicalJson(envelope.policy_final_findings)
  ) {
    throw new Error("captured policy output does not match production aggregate replay");
  }
  const trace = runtime.finalize({
    rawResponseSha256: [...envelope.raw_response_sha256],
    verdict: result.verdict,
    finalFindings: result.dedupedFindings,
  });
  if (trace === null) throw new Error("production replay trace instrumentation failed");
  if (input.verifyOriginal) {
    const original = envelope.policy_trace;
    const expectedPolicySignatures = original.final.finding_signatures.slice(
      0,
      trace.final.finding_signatures.length,
    );
    const expectedPolicySeverities = original.final.finding_severities.slice(
      0,
      trace.final.finding_severities.length,
    );
    const additiveSeverities = original.final.finding_severities.slice(
      trace.final.finding_severities.length,
    );
    const expectedPolicyCounts = {
      critical: original.final.counts.critical,
      warn: original.final.counts.warn,
      info: original.final.counts.info - additiveSeverities.length,
    };
    const equal =
      canonicalJson(trace.raw_response_sha256) === canonicalJson(original.raw_response_sha256) &&
      canonicalJson(trace.ablated) === canonicalJson(original.ablated) &&
      canonicalJson(trace.passes) === canonicalJson(original.passes) &&
      canonicalJson(trace.evaluations) === canonicalJson(original.evaluations) &&
      canonicalJson(trace.stages) === canonicalJson(original.stages) &&
      trace.final.verdict === original.final.verdict &&
      additiveSeverities.every((finding) => finding.severity === "INFO") &&
      canonicalJson(trace.final.counts) === canonicalJson(expectedPolicyCounts) &&
      canonicalJson(trace.final.finding_signatures) === canonicalJson(expectedPolicySignatures) &&
      canonicalJson(trace.final.finding_severities) === canonicalJson(expectedPolicySeverities);
    if (!equal) throw new Error("production baseline replay does not reproduce its policy trace");
  }
  return {
    trace,
    dedupedFindings: result.dedupedFindings,
    criticDropped: result.criticDropped,
  };
}

async function persistBranchPolicyOutcomes(input: {
  envelope: PolicyReplayEnvelope;
  branch: ReplayBranches["baseline"];
  execution: ReplayPolicyExecution;
}): Promise<number> {
  if (!input.envelope.history.implicit_outcomes.enabled) return 0;
  const outcomes = deriveImplicitOutcomes(
    input.execution.dedupedFindings,
    input.execution.criticDropped,
    {
      runId: input.envelope.run_id,
      iter: input.envelope.iter,
      nowIso: input.envelope.history.implicit_outcomes.created_at,
    },
  );
  await new ImplicitOutcomeStore(input.branch.checkoutRoot).append(
    outcomes,
    input.envelope.history.implicit_outcomes.cap,
  );
  recordReplayBranchStateDecision(input.branch, implicitOutcomesPath(input.branch.checkoutRoot));
  return outcomes.length;
}

async function branchStateEvidence(input: {
  checkoutRoot: string;
  historyReads: number;
  historyWrites: number;
}): Promise<PolicyReplayBranchStateEvidence> {
  return {
    digest: digestPolicyState(join(input.checkoutRoot, ".reviewgate")),
    implicit_outcomes: (await new ImplicitOutcomeStore(input.checkoutRoot).load()).length,
    history_reads: input.historyReads,
    history_writes: input.historyWrites,
  };
}

async function replayPolicyEnvelopeInBranches(input: {
  envelope: PolicyReplayEnvelope;
  ablatedPassIds: readonly PolicyPassId[];
  branches: ReplayBranches;
  humanLearningWrites?: { baseline: number; counterfactual: number };
}): Promise<PolicyReplayPair> {
  return runWithReplayProviderCeiling(async () => {
    const ablatedPassIds = normalizeAblatedPassIds(input.ablatedPassIds);
    const humanLearningWrites = input.humanLearningWrites ?? { baseline: 0, counterfactual: 0 };
    const baselineReads = await assertBranchHistoryInputs(
      input.envelope,
      input.branches.baseline.checkoutRoot,
    );
    const counterfactualReads = await assertBranchHistoryInputs(
      input.envelope,
      input.branches.counterfactual.checkoutRoot,
    );
    const baselineExecution = replayEnvelopeProductionPath({
      envelope: input.envelope,
      checkoutRoot: input.branches.baseline.checkoutRoot,
      ablated: new Set(),
      verifyOriginal: true,
    });
    const counterfactualExecution = replayEnvelopeProductionPath({
      envelope: input.envelope,
      checkoutRoot: input.branches.counterfactual.checkoutRoot,
      ablated: new Set(ablatedPassIds),
      verifyOriginal: false,
    });
    if (
      canonicalJson(baselineExecution.trace.raw_response_sha256) !==
      canonicalJson(counterfactualExecution.trace.raw_response_sha256)
    ) {
      throw new Error("baseline and counterfactual ordered response hashes differ");
    }
    const baselineOutcomeWrites = await persistBranchPolicyOutcomes({
      envelope: input.envelope,
      branch: input.branches.baseline,
      execution: baselineExecution,
    });
    const counterfactualOutcomeWrites = await persistBranchPolicyOutcomes({
      envelope: input.envelope,
      branch: input.branches.counterfactual,
      execution: counterfactualExecution,
    });
    return {
      baseline: baselineExecution.trace,
      counterfactual: counterfactualExecution.trace,
      findings: {
        baseline: structuredClone(baselineExecution.dedupedFindings),
        counterfactual: structuredClone(counterfactualExecution.dedupedFindings),
      },
      state: {
        baseline: await branchStateEvidence({
          checkoutRoot: input.branches.baseline.checkoutRoot,
          historyReads: baselineReads,
          historyWrites: humanLearningWrites.baseline + baselineOutcomeWrites,
        }),
        counterfactual: await branchStateEvidence({
          checkoutRoot: input.branches.counterfactual.checkoutRoot,
          historyReads: counterfactualReads,
          historyWrites: humanLearningWrites.counterfactual + counterfactualOutcomeWrites,
        }),
      },
    };
  });
}

/** One exact baseline/counterfactual pair. No adapter/provider capability enters this API. */
export async function replayPolicyEnvelopePair(input: {
  sourceRepoRoot: string;
  envelope: PolicyReplayEnvelope;
  stateSnapshotRoot: string;
  passId: PolicyPassId;
}): Promise<PolicyReplayPair> {
  const pairs = await replayPolicyProfileSequence({
    sourceRepoRoot: input.sourceRepoRoot,
    items: [{ envelope: input.envelope, stateSnapshotRoot: input.stateSnapshotRoot }],
    ablatedPassIds: [input.passId],
  });
  const pair = pairs[0];
  if (pair === undefined) throw new RigAuthorityError("invalid-trace", "replay produced no pair");
  return pair;
}

/**
 * Replay an ordered multi-turn sequence in one persistent branch pair. Production Store APIs own
 * every branch-local read/write; replay neither exposes a mutation callback nor models learning.
 */
export async function replayPolicyEnvelopeSequence(input: {
  sourceRepoRoot: string;
  items: PolicyReplaySequenceItem[];
  passId: PolicyPassId;
}): Promise<PolicyReplayPair[]> {
  return replayPolicyProfileSequence({
    sourceRepoRoot: input.sourceRepoRoot,
    items: input.items,
    ablatedPassIds: [input.passId],
  });
}

/**
 * Replay an ordered multi-turn profile in one branch pair. Both branches start from the exact
 * captured snapshot; later captured snapshots contribute only exogenous changes via
 * `advanceReplayBranches`, never branch-owned writes from the other side.
 */
export async function replayPolicyProfileSequence(input: {
  sourceRepoRoot: string;
  items: PolicyReplaySequenceItem[];
  ablatedPassIds: readonly PolicyPassId[];
}): Promise<PolicyReplayPair[]> {
  const ablatedPassIds = normalizeAblatedPassIds(input.ablatedPassIds);
  const first = input.items[0];
  if (first === undefined) {
    throw new RigAuthorityError("missing-trace", "policy replay sequence is empty");
  }
  if (input.items.some((item) => item.envelope.source_commit !== first.envelope.source_commit)) {
    throw new RigAuthorityError(
      "source-commit-mismatch",
      "policy replay sequence crosses source commits",
    );
  }
  const branches = createReplayBranches({
    sourceRepoRoot: input.sourceRepoRoot,
    sourceCommit: first.envelope.source_commit,
    stateSnapshotRoot: first.stateSnapshotRoot,
    expectedStateSha256: first.envelope.state_sha256,
    exactDiff: first.envelope.exact_diff,
  });
  const pairs: PolicyReplayPair[] = [];
  try {
    for (const [index, item] of input.items.entries()) {
      const previous = input.items[index - 1];
      if (previous !== undefined) {
        advanceReplayBranches({
          branches,
          sourceRepoRoot: input.sourceRepoRoot,
          sourceCommit: item.envelope.source_commit,
          previousExactDiff: previous.envelope.exact_diff,
          nextExactDiff: item.envelope.exact_diff,
          previousStateSnapshotRoot: previous.stateSnapshotRoot,
          previousStateSha256: previous.envelope.state_sha256,
          nextStateSnapshotRoot: item.stateSnapshotRoot,
          nextStateSha256: item.envelope.state_sha256,
        });
      }
      const humanLearningWrites =
        previous === undefined
          ? { baseline: 0, counterfactual: 0 }
          : {
              baseline: await applyCapturedHumanLearning(item.envelope, branches.baseline),
              counterfactual: await applyCapturedHumanLearning(
                item.envelope,
                branches.counterfactual,
              ),
            };
      const pair = await replayPolicyEnvelopeInBranches({
        envelope: item.envelope,
        ablatedPassIds,
        branches,
        humanLearningWrites,
      });
      pairs.push(pair);
    }
    return pairs;
  } finally {
    cleanupReplayBranches(branches);
  }
}

export async function replayPolicyAblations(input: {
  manifestPath: string;
  sourceRepoRoot: string;
  passId?: PolicyPassId;
  authority?: { result: RigResult; scriptId: string; scriptSha256: string };
}): Promise<RigPolicyAblationRow[]> {
  const manifestBytes = readFileSync(input.manifestPath);
  const manifest = RigManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")) as unknown);
  if (input.authority !== undefined) {
    assertRigResultManifestBinding({
      result: input.authority.result,
      manifest,
      manifestPath: input.manifestPath,
      manifestBytes,
      scriptId: input.authority.scriptId,
      scriptSha256: input.authority.scriptSha256,
    });
  }
  const validated = validateRigPolicyReplayArtifacts({
    manifest,
    manifestPath: input.manifestPath,
  });
  if (validated === null) {
    throw new RigAuthorityError(
      "missing-trace",
      "legacy four-layer analysis has no exact policy replay envelopes",
    );
  }
  const envelopes = [...validated.turns.values()].flat();
  const items = envelopes.map(({ envelope, stateRoot }) => ({
    envelope,
    stateSnapshotRoot: stateRoot,
  }));
  const rows: RigPolicyAblationRow[] = [];
  const requestedPasses = input.passId === undefined ? POLICY_PASS_IDS : [input.passId];
  for (const passId of requestedPasses) {
    let opportunities = 0;
    let applied = 0;
    let wouldApplyWithoutMutation = 0;
    let baselineBlocking = 0;
    let counterfactualBlocking = 0;
    let ran = 0;
    let pairs: PolicyReplayPair[];
    try {
      pairs = await replayPolicyEnvelopeSequence({
        sourceRepoRoot: input.sourceRepoRoot,
        items,
        passId,
      });
    } catch (error) {
      if (error instanceof RigAuthorityError) throw error;
      throw new RigAuthorityError(
        /alias/i.test(String(error)) ? "source-state-alias" : "invalid-trace",
        error instanceof Error ? error.message : String(error),
      );
    }
    for (const pair of pairs) {
      const baselineRow = pair.baseline.passes.find((row) => row.pass_id === passId);
      const counterfactualRow = pair.counterfactual.passes.find((row) => row.pass_id === passId);
      if (baselineRow === undefined || counterfactualRow === undefined) {
        throw new RigAuthorityError("invalid-trace", `missing catalog row ${passId}`);
      }
      if (baselineRow.status === "ran" && counterfactualRow.status === "ran") {
        ran += 1;
        opportunities += baselineRow.opportunities;
        applied += baselineRow.applied;
        wouldApplyWithoutMutation += counterfactualRow.would_apply;
      }
      baselineBlocking += pair.baseline.final.counts.critical + pair.baseline.final.counts.warn;
      counterfactualBlocking +=
        pair.counterfactual.final.counts.critical + pair.counterfactual.final.counts.warn;
    }
    rows.push({
      passId,
      authoritative: ran > 0,
      reason: ran > 0 ? null : "pass was inactive for every captured envelope",
      envelopes: envelopes.length,
      opportunities,
      applied,
      wouldApplyWithoutMutation,
      baselineBlocking,
      counterfactualBlocking,
    });
  }
  return rows;
}

function authorityMismatch(message: string): never {
  throw new RigAuthorityError("result-manifest-mismatch", message);
}

/** Bind the harvested result and selected script to the exact manifest before any replay. */
export function assertRigResultManifestBinding(input: {
  result: RigResult;
  manifest: RigManifest;
  manifestPath: string;
  manifestBytes: Buffer;
  scriptId: string;
  scriptSha256: string;
}): void {
  const statement = input.result.policyReplay;
  const binding = statement?.artifactBinding;
  const metadata = input.manifest.policyReplay;
  if (statement?.authoritative !== true || binding === undefined || metadata === undefined) {
    authorityMismatch("authoritative result is missing its content-addressed manifest binding");
  }
  if (
    binding.manifestRef !== basename(input.manifestPath) ||
    binding.manifestSha256 !== createHash("sha256").update(input.manifestBytes).digest("hex")
  ) {
    authorityMismatch("selected manifest does not match the harvested manifest content address");
  }
  if (
    input.result.runId !== input.manifest.runId ||
    input.result.provenance.run_id !== input.manifest.runId
  ) {
    authorityMismatch("result and manifest run ids differ");
  }
  if (
    input.result.provenance.script_id !== input.manifest.scriptId ||
    binding.scriptId !== input.manifest.scriptId ||
    input.scriptId !== input.manifest.scriptId ||
    input.scriptSha256 !== input.manifest.scriptSha256 ||
    input.manifest.scriptSha256 === undefined ||
    binding.scriptSha256 === undefined ||
    binding.scriptSha256 !== input.manifest.scriptSha256
  ) {
    authorityMismatch("selected script does not match the harvested manifest script identity");
  }
  if (
    statement.catalogVersion !== metadata.catalogVersion ||
    statement.sourceCommit !== metadata.sourceCommit ||
    binding.initialStateRef !== metadata.initialStateRef ||
    binding.initialStateSha256 !== metadata.initialStateSha256 ||
    binding.initialStateDigest !== metadata.initialStateDigest ||
    binding.cassetteRef !== metadata.cassetteRef ||
    binding.cassetteSha256 !== metadata.cassetteSha256
  ) {
    authorityMismatch("result and manifest source, state, catalog, or cassette identities differ");
  }
  const manifestInventory = input.manifest.turns.map((turn) => ({
    index: turn.index,
    traces: turn.policyReplay?.traces ?? [],
  }));
  const resultInventory = input.result.turns.map((turn) => ({
    index: turn.index,
    traces: turn.policyReplay?.traces.map(({ ref, sha256 }) => ({ ref, sha256 })) ?? [],
  }));
  if (
    canonicalJson(binding.turns) !== canonicalJson(manifestInventory) ||
    canonicalJson(binding.turns) !== canonicalJson(resultInventory)
  ) {
    authorityMismatch("result and manifest turn/trace inventories differ");
  }
}

export function renderPolicyAblationRows(rows: RigPolicyAblationRow[]): string {
  const lines = ["Reviewgate rig — exact policy ablation (closed catalog)", ""];
  for (const row of rows) {
    const delta = row.counterfactualBlocking - row.baselineBlocking;
    lines.push(
      `  ${row.passId.padEnd(30)} opportunities ${String(row.opportunities).padStart(4)}  applied ${String(row.applied).padStart(4)}  blocking Δ ${delta >= 0 ? "+" : ""}${delta}  ${row.authoritative ? "exact" : "inactive/non-authoritative"}`,
    );
  }
  lines.push(
    "",
    "Lore is excluded: it is additive and verdict-neutral. Legacy critic/reputation/fp-ledger/lore",
    "rows remain diagnostic only and are never interpreted as zero policy opportunities.",
  );
  return `${lines.join("\n")}\n`;
}

/**
 * Fields that legitimately differ between two harvests of the same run. Everything else
 * differing is a defect. Kept as an explicit list rather than a "strip timestamps" regex so
 * that a NEW volatile field has to be added here consciously — a regex would silently
 * absorb a genuinely nondeterministic value that happens to look like a date.
 */
function stripVolatile(result: RigResult): unknown {
  const { provenance, ...rest } = result;
  const { harvested_at, ...provRest } = provenance;
  void harvested_at;
  return { ...rest, provenance: provRest };
}

/**
 * An ablation embeds two full RigResults (`lower`/`upper`), so it inherits their volatile
 * `harvested_at`. Comparing two ablations without stripping it reports NON-DETERMINISTIC
 * unconditionally — a check that always fails is exactly as worthless as one that always
 * passes, and this one did fail that way on first contact with the real pilot.
 */
function stripAblationVolatile(a: RigAblation): unknown {
  return { ...a, lower: stripVolatile(a.lower), upper: stripVolatile(a.upper) };
}

/** Stable-key JSON so key ORDER cannot masquerade as a value difference (or hide one). */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort());
    }
    return v;
  });
}

export function checkCassette(cassettePath: string): CassetteIntegrity {
  const raw = readFileSync(cassettePath, "utf8");
  const byKey: Record<string, number> = {};
  let entries = 0;
  let malformedLines = 0;
  let reviewsWithFindings = 0;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let parsed: unknown;
    try {
      parsed = CassetteEntrySchema.parse(JSON.parse(t));
    } catch {
      malformedLines++;
      continue;
    }
    const e = parsed as { key: string; result?: unknown };
    entries++;
    byKey[e.key] = (byKey[e.key] ?? 0) + 1;
    // A malformed/empty body cannot reach here: the schema's result union has no member
    // that accepts `{}`, so such a line is counted as malformed above.
    const findings = (e.result as { findings?: unknown[] } | undefined)?.findings;
    if (Array.isArray(findings) && findings.length > 0) reviewsWithFindings++;
  }
  return { entries, malformedLines, byKey, reviewsWithFindings };
}

/**
 * Harvest the run twice and re-aggregate every suppression layer twice, then compare.
 *
 * Two harvests rather than one compared against a stored result.json: the stored file may
 * have been produced by a different binary, so a mismatch there would confuse "the harvester
 * changed" with "the harvester is nondeterministic". This asks only the second question.
 */
export function checkDeterminism(manifestPath: string, scriptPath: string): ReplayReport {
  const first = harvest(manifestPath, scriptPath);
  const second = harvest(manifestPath, scriptPath);
  const differences: string[] = [];

  if (canonical(stripVolatile(first)) !== canonical(stripVolatile(second))) {
    differences.push(
      "harvest(): two harvests of the same run produced different RigResults. The metrics are " +
        "not reproducible from the recorded artifacts, so no refactor can be shown to be " +
        "behaviour-neutral against them.",
    );
  }

  const seededTags = seededTagsFromScript(scriptPath);
  for (const layer of SUPPRESSION_LAYERS) {
    const a = stripAblationVolatile(ablate(first, layer, seededTags));
    const b = stripAblationVolatile(ablate(second, layer, seededTags));
    if (canonical(a) !== canonical(b)) {
      differences.push(
        `ablate(--layer ${layer}): re-aggregating the same findings twice produced different output. The counterfactual is a pure function of (result, layer) by contract; it is not.`,
      );
    }
  }

  return {
    deterministic: differences.length === 0,
    differences,
    cassette: null,
    turns: first.turns.length,
  };
}

export function renderReplayReport(r: ReplayReport): string {
  const lines: string[] = ["Reviewgate rig — replay self-check", ""];
  lines.push(`  turns harvested        : ${r.turns}`);
  lines.push(
    `  harvest + ablate       : ${r.deterministic ? "DETERMINISTIC (2 runs identical)" : "NON-DETERMINISTIC"}`,
  );
  if (r.cassette) {
    const c = r.cassette;
    const keys = Object.entries(c.byKey)
      .map(([k, n]) => `${k}×${n}`)
      .join(", ");
    lines.push(`  cassette entries       : ${c.entries} (${keys})`);
    lines.push(`  reviews carrying findings: ${c.reviewsWithFindings}`);
    if (c.malformedLines > 0) {
      lines.push(`  ⚠ malformed lines      : ${c.malformedLines} — the recording is incomplete`);
    }
  }
  if (r.policy) {
    lines.push(
      `  exact policy replay     : ${r.policy.authoritative ? `AUTHORITATIVE (${r.policy.envelopes} envelope(s), ${r.policy.passIds.length} catalog passes)` : "LEGACY / NON-AUTHORITATIVE"}`,
    );
  }
  if (!r.deterministic) {
    lines.push("", "Differences:");
    for (const d of r.differences) lines.push(`  · ${d}`);
  }
  lines.push(
    "",
    "New exact runs replay policy locally from validated envelopes and never invoke a provider.",
    "Legacy runs only re-derive the old harvest/heuristic analysis and are non-authoritative.",
  );
  return lines.join("\n");
}

export async function replay(input: {
  manifestPath: string;
  scriptPath: string;
  cassettePath?: string | undefined;
  sourceRepoRoot?: string | undefined;
}): Promise<ReplayReport> {
  const report = checkDeterminism(input.manifestPath, input.scriptPath);
  if (input.cassettePath !== undefined) {
    if (!existsSync(input.cassettePath)) {
      throw new Error(
        `rig replay: no cassette at ${input.cassettePath}. A run recorded without one cannot be re-examined; omit --cassette to check determinism only.`,
      );
    }
    report.cassette = checkCassette(input.cassettePath);
  }
  const manifest = RigManifestSchema.parse(
    JSON.parse(readFileSync(input.manifestPath, "utf8")) as unknown,
  );
  const policy = validateRigPolicyReplayArtifacts({ manifest, manifestPath: input.manifestPath });
  if (policy !== null) {
    if (input.sourceRepoRoot === undefined) {
      throw new RigAuthorityError(
        "source-state-alias",
        "exact policy replay requires the measured source repository root",
      );
    }
    let envelopeCount = 0;
    try {
      const items = [...policy.turns.values()].flat().map(({ envelope, stateRoot }) => ({
        envelope,
        stateSnapshotRoot: stateRoot,
      }));
      await replayPolicyEnvelopeSequence({
        sourceRepoRoot: input.sourceRepoRoot,
        items,
        passId: POLICY_PASS_IDS[0],
      });
      envelopeCount = items.length;
    } catch (error) {
      if (error instanceof RigAuthorityError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new RigAuthorityError(
        /alias/i.test(message) ? "source-state-alias" : "invalid-trace",
        message,
      );
    }
    report.policy = {
      authoritative: true,
      envelopes: envelopeCount,
      passIds: [...POLICY_PASS_IDS],
    };
  } else {
    report.policy = { authoritative: false, envelopes: 0, passIds: [] };
  }
  return report;
}
