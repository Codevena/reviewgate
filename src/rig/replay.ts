// src/rig/replay.ts
// Exact new runs replay captured policy inputs through production pass functions in isolated
// checkouts. Legacy runs retain the older deterministic harvest/heuristic self-check, explicitly
// non-authoritative for policy ablation rather than pretending missing opportunities were zero.
import { existsSync, readFileSync } from "node:fs";
import { canonicalJson } from "../audit/canonical.ts";
import { type AggregateInput, aggregate } from "../core/aggregator.ts";
import { validateFindingFacts } from "../core/fact-check.ts";
import { applyGroundingJudgeVerdicts, groundFindings } from "../core/grounding.ts";
import { demoteHypotheticalCriticals } from "../core/hypothetical-demote.ts";
import type { PolicyPassId } from "../core/policy/catalog.ts";
import { POLICY_PASS_IDS } from "../core/policy/catalog.ts";
import { PolicyTraceRecorder } from "../core/policy/trace.ts";
import { demoteSelfRefuting } from "../core/self-refutation.ts";
import { parseDeletedPaths } from "../diff/hunks.ts";
import { CassetteEntrySchema } from "../schemas/cassette.ts";
import type { PolicyReplayEnvelope } from "../schemas/policy-replay.ts";
import type { PolicyTrace } from "../schemas/policy-trace.ts";
import { RigManifestSchema } from "../schemas/rig-manifest.ts";
import type { RigResult } from "../schemas/rig-result.ts";
import { type RigAblation, SUPPRESSION_LAYERS, ablate, seededTagsFromScript } from "./ablate.ts";
import { harvest } from "./harvest.ts";
import {
  type ReplayBranches,
  RigAuthorityError,
  advanceReplayBranches,
  cleanupReplayBranches,
  createReplayBranches,
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
}

export interface PolicyReplaySequenceItem {
  envelope: PolicyReplayEnvelope;
  stateSnapshotRoot: string;
}

export interface PolicyReplaySequenceStep {
  index: number;
  item: PolicyReplaySequenceItem;
  branches: ReplayBranches;
  pair: PolicyReplayPair;
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
  try {
    return operation();
  } finally {
    globalThis.fetch = originalFetch;
    bunRuntime.spawn = originalSpawn;
  }
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

function replayEnvelopeProductionPath(input: {
  envelope: PolicyReplayEnvelope;
  checkoutRoot: string;
  ablated: ReadonlySet<PolicyPassId>;
  verifyOriginal: boolean;
}): PolicyTrace {
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
  if (canonicalJson(grounded) !== canonicalJson(envelope.aggregate.findings)) {
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
  return trace;
}

function replayPolicyEnvelopeInBranches(input: {
  envelope: PolicyReplayEnvelope;
  passId: PolicyPassId;
  branches: ReplayBranches;
}): PolicyReplayPair {
  return runWithReplayProviderCeiling(() => {
    const baseline = replayEnvelopeProductionPath({
      envelope: input.envelope,
      checkoutRoot: input.branches.baseline.checkoutRoot,
      ablated: new Set(),
      verifyOriginal: true,
    });
    const counterfactual = replayEnvelopeProductionPath({
      envelope: input.envelope,
      checkoutRoot: input.branches.counterfactual.checkoutRoot,
      ablated: new Set([input.passId]),
      verifyOriginal: false,
    });
    if (
      canonicalJson(baseline.raw_response_sha256) !==
      canonicalJson(counterfactual.raw_response_sha256)
    ) {
      throw new Error("baseline and counterfactual ordered response hashes differ");
    }
    return { baseline, counterfactual };
  });
}

/** One exact baseline/counterfactual pair. No adapter/provider capability enters this API. */
export function replayPolicyEnvelopePair(input: {
  sourceRepoRoot: string;
  envelope: PolicyReplayEnvelope;
  stateSnapshotRoot: string;
  passId: PolicyPassId;
}): PolicyReplayPair {
  const branches = createReplayBranches({
    sourceRepoRoot: input.sourceRepoRoot,
    sourceCommit: input.envelope.source_commit,
    stateSnapshotRoot: input.stateSnapshotRoot,
    expectedStateSha256: input.envelope.state_sha256,
    exactDiff: input.envelope.exact_diff,
  });
  try {
    return replayPolicyEnvelopeInBranches({
      envelope: input.envelope,
      passId: input.passId,
      branches,
    });
  } finally {
    cleanupReplayBranches(branches);
  }
}

/**
 * Replay an ordered multi-turn sequence in one persistent branch pair. The optional callback is
 * the branch-local boundary used by existing production Store APIs; replay itself never invents a
 * store transition or interprets a learning schema.
 */
export async function replayPolicyEnvelopeSequence(input: {
  sourceRepoRoot: string;
  items: PolicyReplaySequenceItem[];
  passId: PolicyPassId;
  afterEnvelope?: (step: PolicyReplaySequenceStep) => void | Promise<void>;
}): Promise<PolicyReplayPair[]> {
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
      const pair = replayPolicyEnvelopeInBranches({
        envelope: item.envelope,
        passId: input.passId,
        branches,
      });
      pairs.push(pair);
      await input.afterEnvelope?.({ index, item, branches, pair });
    }
    return pairs;
  } finally {
    cleanupReplayBranches(branches);
  }
}

export async function replayPolicyAblations(input: {
  manifestPath: string;
  sourceRepoRoot: string;
}): Promise<RigPolicyAblationRow[]> {
  const manifest = RigManifestSchema.parse(
    JSON.parse(readFileSync(input.manifestPath, "utf8")) as unknown,
  );
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
  for (const passId of POLICY_PASS_IDS) {
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
