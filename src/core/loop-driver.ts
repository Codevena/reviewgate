// src/core/loop-driver.ts
import { existsSync, readFileSync, renameSync, rmSync, unlinkSync } from "node:fs";
import type { AuditLogger } from "../audit/logger.ts";
import { POST_ABORT_SETTLE_MS_DEFAULT } from "../config/budgets.ts";
import type { ReviewgateConfig } from "../config/define-config.ts";
import type { RunSummary } from "../schemas/audit-event.ts";
import { type DecisionEntry, DecisionEntrySchema } from "../schemas/decision.ts";
import { type Finding, FindingSchema } from "../schemas/finding.ts";
import {
  type EscalationReason,
  type ReviewgateState,
  ReviewgateStateSchema,
} from "../schemas/state.ts";
import { maybeWriteWeeklySnapshot } from "../stats/snapshot.ts";
import {
  decisionsDir,
  decisionsPath,
  dirtyFlagPath,
  pendingJsonPath,
  pendingMdPath,
} from "../utils/paths.ts";
import type { Adjudication } from "./adjudications.ts";
import { ProposalStore } from "./brain/proposal-store.ts";
import { buildDecisionOutcome } from "./decision-outcome.ts";
import { learnFromDecisions } from "./fp-ledger/learn.ts";
import { computeRejectRate } from "./fp-ledger/reject-rate.ts";
import { FpLedgerStore } from "./fp-ledger/store.ts";
import { locationKey, recurringBlockingLocations } from "./location-recurrence.ts";
import type { IterationResult, IterationRunner } from "./orchestrator.ts";
import { QuotaCooldownStore } from "./quota-cooldown.ts";
import { ReportWriter } from "./report-writer.ts";
import { learnReputationFromDecisions } from "./reputation/learn.ts";
import { ReputationStore } from "./reputation/store.ts";
import { recurringBlockingSignatures } from "./signature-recurrence.ts";
import type { StateStore } from "./state-store.ts";

// Minimum decisions this cycle before the reject-rate circuit-breaker can fire,
// so a single (or couple of) reviewer_was_wrong rejection never escalates.
const MIN_DECISIONS_FOR_REJECT_RATE = 4;

// Consecutive incomplete (timed-out) runs before escalating to the human, so a
// permanently-hanging provider can't loop the block→re-run forever.
const MAX_CONSECUTIVE_INCOMPLETE_RUNS = 2;

// POST_ABORT_SETTLE_MS_DEFAULT (the cap for awaiting the run to settle after the
// self-deadline aborts it — see its definition in config/budgets.ts) lives with
// SETUP_BUDGET_MS_DEFAULT so the doctor can derive its fail-open margin from both.

// Escalation reasons where the REVIEWER (or a transient provider outage) is the
// problem, not the agent's code. Blocking there punishes correct agent behavior
// (e.g. consistently rejecting a noisy reviewer's findings) and holds the dev
// hostage. For these the gate still writes ESCALATION.md + audit (the human is
// informed) but ALLOWS the stop with a loud warning instead of blocking.
const ALLOW_STOP_ESCALATIONS: ReadonlySet<EscalationReason> = new Set<EscalationReason>([
  "reviewer-fp-streak",
  // A persistent transient-infra outage (every reviewer down for >N turns) is a
  // provider problem, not the agent's code — blocking would deadlock an automated
  // loop (it can't wait out the outage). We still write ESCALATION.md + audit (the
  // human is informed) but ALLOW the stop with a loud warning instead of block-looping.
  "infra-unavailable",
]);

// Human-readable deadline duration for messages: "300ms" / "45s" / "14min"
// (a sub-second deadline must not round down to a confusing "0s").
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  return `${Math.round(ms / 60_000)}min`;
}

export interface LoopInput {
  repoRoot: string;
  config: ReviewgateConfig;
  state: StateStore;
  audit: AuditLogger;
  orchestrator: IterationRunner;
  stopHookActive: boolean;
  // Current HEAD sha. When it differs from the last reviewed sha, a commit
  // landed and the gate re-arms (fresh budget for the next batch).
  headSha?: string;
  // Post-abort settle cap (ms). Defaults to POST_ABORT_SETTLE_MS_DEFAULT; tests
  // inject a tiny value to exercise the hung-run fail-closed path quickly (M-A0.3).
  postAbortSettleMs?: number;
}

export type LoopDecision =
  | { kind: "allow_stop"; reason: string }
  | { kind: "block"; reason: string };

interface DirtyFlag {
  diff_hash: string;
  ts: string;
  base_sha?: string; // pre-batch HEAD; the gate diffs against it (commit-per-task)
}

function readDirtyFlag(repoRoot: string): DirtyFlag | null {
  const p = dirtyFlagPath(repoRoot);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as DirtyFlag;
  } catch {
    return null;
  }
}

// The finding IDs (e.g. "F-001") that the previous iteration reported. These
// live in pending.json — NOT in signature_history, which stores sha256
// signatures used for stuck-loop detection. Claude's decisions file is keyed
// by finding_id, so the decisions-gate must compare against these IDs.
function previousFindingIds(repoRoot: string): string[] {
  const p = pendingJsonPath(repoRoot);
  if (!existsSync(p)) return [];
  try {
    const report = JSON.parse(readFileSync(p, "utf8")) as {
      findings?: Array<{ id?: string; severity?: string }>;
    };
    if (!Array.isArray(report.findings)) return [];
    // Only CRITICAL/WARN findings are blocking and therefore require a decision.
    // INFO (incl. M5 scope_demoted / fp_ledger_match.suppressed advisories) never
    // blocks the verdict, so demanding a decision for it would defeat the
    // demote-to-INFO mechanism — the agent would have to re-reject every advisory.
    return report.findings
      .filter((f) => f.severity === "CRITICAL" || f.severity === "WARN")
      .map((f) => f.id)
      .filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

// The LAST (most recent) valid decision per finding_id from decisions/<prevIter>.jsonl
// that satisfies `match`, joined to the finding's FULL signature set (representative +
// every clustered member) via the prior pending.json. LAST-wins because the append-only
// decisions file may carry a superseding disposition for a finding within an iteration;
// the fold reflects the agent's MOST RECENT intent (distinct from evaluateDecisions, which
// only asks "did the agent decide at all"). rep+member key space keeps the §4.3 tie-break
// sound (aggregate() matches recurrences on rep-OR-member). Never throws — [] on any gap.
function priorIterationDecisionSignatures(
  repoRoot: string,
  prevIter: number,
  match: (d: DecisionEntry) => boolean,
): string[] {
  if (prevIter < 1) return [];
  const dp = decisionsPath(repoRoot, prevIter);
  const pp = pendingJsonPath(repoRoot);
  if (!existsSync(dp) || !existsSync(pp)) return [];
  let sigsById: Map<string, string[]>;
  try {
    const report = JSON.parse(readFileSync(pp, "utf8")) as {
      findings?: Array<{
        id?: string;
        signature?: string;
        members?: Array<{ signature?: string }>;
      }>;
    };
    sigsById = new Map(
      (report.findings ?? [])
        .filter(
          (f): f is { id: string; signature: string; members?: Array<{ signature?: string }> } =>
            !!f.id && !!f.signature,
        )
        .map((f) => [
          f.id,
          [
            f.signature,
            ...(f.members ?? [])
              .map((m) => m.signature)
              .filter((s): s is string => typeof s === "string" && s.length > 0),
          ],
        ]),
    );
  } catch {
    return [];
  }
  // Last-valid-decision-per-id: a later valid line for the same finding_id overwrites an
  // earlier one, so a superseding disposition (e.g. fixed -> deferred) is honored.
  // Guard the read too (not just JSON.parse): an existing-but-unreadable file, or one
  // deleted/replaced between existsSync and here (TOCTOU), must honor the never-throws
  // contract — return [] rather than propagate into LoopDriver.run.
  let lines: string[];
  try {
    lines = readFileSync(dp, "utf8").split("\n");
  } catch {
    return [];
  }
  const lastById = new Map<string, DecisionEntry>();
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const res = DecisionEntrySchema.safeParse(parsed);
    if (!res.success) continue;
    lastById.set(res.data.finding_id, res.data);
  }
  const out = new Set<string>();
  for (const [findingId, d] of lastById) {
    if (!match(d)) continue;
    const sigs = sigsById.get(findingId);
    if (sigs) for (const s of sigs) out.add(s);
  }
  return [...out];
}

// Signatures the agent rejected as reviewer_was_wrong in `prevIter` (2b per-cycle
// suppression). See priorIterationDecisionSignatures.
function priorIterationRejectedSignatures(repoRoot: string, prevIter: number): string[] {
  return priorIterationDecisionSignatures(
    repoRoot,
    prevIter,
    (d) => d.verdict === "rejected" && d.reviewer_was_wrong === true,
  );
}

// Signatures the agent marked accepted/action:"fixed" in `prevIter` (§4.3). See
// priorIterationDecisionSignatures.
function priorIterationClaimedFixedSignatures(repoRoot: string, prevIter: number): string[] {
  return priorIterationDecisionSignatures(
    repoRoot,
    prevIter,
    (d) => d.verdict === "accepted" && d.action === "fixed",
  );
}

// S1 cross-iteration memory: the prior iteration's adjudications (finding location +
// disposition + agent reason), joining pending.json findings (id → file/lines) with the LAST
// decision per id in decisions/<prevIter>.jsonl. Fed to the next iteration's reviewer prompt
// so it does not re-litigate settled regions. Never throws → [] (same contract as the sibling
// readers; a malformed/partial artifact must never break LoopDriver.run).
export function priorAdjudications(repoRoot: string, prevIter: number): Adjudication[] {
  if (prevIter < 1) return [];
  const dp = decisionsPath(repoRoot, prevIter);
  const pp = pendingJsonPath(repoRoot);
  if (!existsSync(dp) || !existsSync(pp)) return [];
  let locById: Map<string, { file: string; lineStart: number; lineEnd: number }>;
  try {
    const report = JSON.parse(readFileSync(pp, "utf8")) as {
      findings?: Array<{ id?: string; file?: string; line_start?: number; line_end?: number }>;
    };
    locById = new Map(
      (report.findings ?? [])
        .filter(
          (f): f is { id: string; file: string; line_start: number; line_end: number } =>
            !!f.id &&
            typeof f.file === "string" &&
            typeof f.line_start === "number" &&
            typeof f.line_end === "number",
        )
        .map((f) => [f.id, { file: f.file, lineStart: f.line_start, lineEnd: f.line_end }]),
    );
  } catch {
    return [];
  }
  let lines: string[];
  try {
    lines = readFileSync(dp, "utf8").split("\n");
  } catch {
    return [];
  }
  const lastById = new Map<string, DecisionEntry>();
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const res = DecisionEntrySchema.safeParse(parsed);
    if (!res.success) continue;
    lastById.set(res.data.finding_id, res.data);
  }
  const out: Adjudication[] = [];
  for (const [findingId, d] of lastById) {
    const loc = locById.get(findingId);
    if (!loc) continue;
    out.push(
      d.verdict === "rejected"
        ? { ...loc, disposition: "rejected", reason: d.reason }
        : { ...loc, disposition: "addressed" },
    );
  }
  return out;
}

// N4: the last-wins DecisionEntry per finding id from decisions/<iter>.jsonl. The
// escalation report is rendered from the prior iteration's pending.json (a PRECONDITION
// snapshot, written before the agent's decisions), so joining these decisions lets the
// report show each finding's CURRENT disposition instead of a stale "all open" view.
// Never throws → empty map (same best-effort contract as the sibling readers).
function lastDecisionsById(repoRoot: string, iter: number): Map<string, DecisionEntry> {
  const out = new Map<string, DecisionEntry>();
  if (iter < 1) return out;
  const dp = decisionsPath(repoRoot, iter);
  if (!existsSync(dp)) return out;
  let lines: string[];
  try {
    lines = readFileSync(dp, "utf8").split("\n");
  } catch {
    return out;
  }
  for (const line of lines) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const res = DecisionEntrySchema.safeParse(parsed);
    if (!res.success) continue;
    out.set(res.data.finding_id, res.data); // last line for an id wins
  }
  return out;
}

// Precision telemetry: emit one durable `decision.applied` audit event per finalized
// decision of `iter`, joining decisions/<iter>.jsonl (last-wins) against the current
// pending.json findings for severity + providers. Decisions whose finding_id is not in
// the current pending.json are skipped (can't attribute). Best-effort by contract: the
// SOLE caller wraps it so a failure never affects the verdict. Exactly-once across stops
// is the caller's responsibility (decisions_emitted_through_iter watermark).
export async function emitDecisionOutcomes(
  repoRoot: string,
  iter: number,
  sessionId: string,
  audit: Pick<AuditLogger, "append">,
): Promise<void> {
  const decisions = lastDecisionsById(repoRoot, iter);
  if (decisions.size === 0) return;
  const findingsById = new Map(readPendingReport(repoRoot).findings.map((f) => [f.id, f]));
  for (const [id, d] of decisions) {
    const f = findingsById.get(id);
    if (f === undefined) continue;
    await audit.append({
      event: "decision.applied",
      run_id: sessionId,
      iter,
      trigger: "stop-hook",
      decision_outcome: buildDecisionOutcome(d, f),
    });
  }
}

// The last iteration's findings + severity counts, read from pending.json. The
// gate escalates as a PRECONDITION (before running a new iteration), so pending.json
// still reflects the prior iteration — used to populate the escalation report so it
// is useful standalone instead of showing an empty findings section + zero counts.
function readPendingReport(repoRoot: string): {
  findings: Finding[];
  counts: { critical: number; warn: number; info: number };
} {
  const empty = { findings: [] as Finding[], counts: { critical: 0, warn: 0, info: 0 } };
  const p = pendingJsonPath(repoRoot);
  if (!existsSync(p)) return empty;
  try {
    const r = JSON.parse(readFileSync(p, "utf8")) as {
      findings?: Finding[];
      counts?: { critical?: number; warn?: number; info?: number };
    };
    // Validate each finding — pending.json could hold partial/stub entries
    // (older format, hand-written tests); only fully-valid Findings reach the
    // report renderer so a malformed one can't crash escalation.
    const findings = (Array.isArray(r.findings) ? r.findings : [])
      .map((f) => FindingSchema.safeParse(f))
      .filter((res): res is { success: true; data: Finding } => res.success)
      .map((res) => res.data);
    return {
      findings,
      counts: {
        critical: r.counts?.critical ?? 0,
        warn: r.counts?.warn ?? 0,
        info: r.counts?.info ?? 0,
      },
    };
  } catch {
    return empty;
  }
}

// On a re-arm (clean PASS, or a commit recovering an escalated gate) the current
// review cycle is closed. The iteration counter resets to 0 and the NEXT cycle
// climbs through the same decisions/<iter>.jsonl filenames again. Since the
// decisions-gate matches by finding_id only, a stale "F-001 fixed" line left over
// from this cycle would otherwise satisfy a colliding F-001 in the next cycle
// without the agent addressing it. Wipe the directory so each cycle starts clean,
// exactly as the SessionStart reset does.
function clearDecisions(repoRoot: string): void {
  try {
    rmSync(decisionsDir(repoRoot), { recursive: true, force: true });
  } catch {
    /* noop */
  }
}

export interface DecisionsGate {
  addressed: boolean;
  missing: string[]; // required ids with no valid decision line
  invalid: string[]; // human-readable per-line reasons a present line was rejected
}

// Evaluate the decisions file against the required finding ids. Beyond the
// boolean gate, it captures WHY a present-but-invalid line did not count
// (bad JSON, too-short reason, missing `action`, wrong verdict literal) so the
// block message can tell the agent exactly what to fix — otherwise a formatting
// mistake is dropped silently and the agent re-reads an identical generic block,
// sees its line IS in the file, and loops without understanding the failure (F-088).
export function evaluateDecisions(
  repoRoot: string,
  iter: number,
  requiredIds: string[],
): DecisionsGate {
  const p = decisionsPath(repoRoot, iter);
  const seen = new Set<string>();
  const invalid: string[] = [];
  // Finding ids that appeared on a present-but-invalid line. Tracked explicitly
  // (NOT parsed back out of the human-readable `invalid` strings) so a future
  // wording change to a reason can never silently mis-attribute an id.
  const invalidIds = new Set<string>();
  // Guard the read: an existing-but-unreadable file (or one replaced between
  // existsSync and here) leaves `seen` empty → every required id reads as missing →
  // the gate fails CLOSED (blocks), the safe direction, rather than throwing into
  // LoopDriver.run.
  let lines: string[] = [];
  if (existsSync(p)) {
    try {
      lines = readFileSync(p, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
    } catch {
      lines = [];
    }
  }
  // N2: finding severity/category, loaded lazily ONLY when an acknowledged-low-value
  // line needs validating (a CRITICAL or security/correctness finding can't be
  // acknowledged away). Read from the same pending.json the required ids came from.
  let findingMeta: Map<
    string,
    { severity: string; highStakes: boolean; deterministic: boolean }
  > | null = null;
  const metaOf = (
    id: string,
  ): { severity: string; highStakes: boolean; deterministic: boolean } | undefined => {
    if (!findingMeta) {
      findingMeta = new Map(
        readPendingReport(repoRoot).findings.map((f) => [
          f.id,
          {
            severity: f.severity,
            // Look past the representative category to the MERGED members (a
            // wording-similarity merge can park a security/correctness concern as a
            // member under a quality representative) — mirrors the aggregator's
            // touchesSecurityOrCorrectness so the off-ramp can't acknowledge it away.
            highStakes:
              f.category === "security" ||
              f.category === "correctness" ||
              (f.members ?? []).some(
                (m) => m.category === "security" || m.category === "correctness",
              ),
            deterministic: f.deterministic === true,
          },
        ]),
      );
    }
    return findingMeta.get(id);
  };
  for (const l of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(l);
    } catch {
      invalid.push("a line is not valid JSON");
      continue; // not JSON → treated as missing decision (fail-closed)
    }
    // Only a fully valid DecisionEntry counts. A bare {finding_id} stub or a
    // rejection with a too-short reason must NOT satisfy the gate — otherwise
    // the gate is trivially bypassable with malformed lines.
    const res = DecisionEntrySchema.safeParse(parsed);
    if (res.success) {
      // A deterministic check failure (tsc/build/test) is ground truth — you cannot
      // "reject" a compiler. A rejected decision does NOT satisfy the gate; it must be
      // FIXED (the check re-runs and clears on its own) or the check removed from config.
      if (res.data.verdict === "rejected" && metaOf(res.data.finding_id)?.deterministic) {
        invalidIds.add(res.data.finding_id);
        invalid.push(
          `${res.data.finding_id}: verdict — a deterministic check failure can't be rejected; fix the build/test (it re-runs and clears automatically) or remove the check from reviewgate.config.ts`,
        );
        continue;
      }
      // N2: an "acknowledged-low-value" disposition is valid ONLY for an INFO/WARN
      // finding that is not security/correctness. On a CRITICAL or security/correctness
      // finding (or one missing from pending — fail-safe) it does NOT satisfy the gate:
      // the agent cannot acknowledge a real bug away, so the finding stays required.
      if (res.data.verdict === "accepted" && res.data.action === "acknowledged-low-value") {
        const meta = metaOf(res.data.finding_id);
        const cannotAcknowledge = !meta || meta.severity === "CRITICAL" || meta.highStakes;
        if (cannotAcknowledge) {
          invalidIds.add(res.data.finding_id);
          invalid.push(
            `${res.data.finding_id}: action — "acknowledged-low-value" is only allowed for an INFO/WARN non-security/correctness finding; fix it or reject it (reviewer_was_wrong) instead`,
          );
          continue;
        }
      }
      seen.add(res.data.finding_id);
      continue;
    }
    const rawId =
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { finding_id?: unknown }).finding_id === "string"
        ? (parsed as { finding_id: string }).finding_id
        : null;
    if (rawId) invalidIds.add(rawId);
    const issue = res.error.issues[0];
    const where = issue?.path.length ? issue.path.join(".") : "entry";
    invalid.push(
      `${rawId ?? "(missing finding_id)"}: ${where} — ${issue?.message ?? "invalid decision"}`,
    );
  }
  // Only report a required id as missing when no VALID line addressed it, and it
  // wasn't already flagged as invalid above (so the agent sees one reason per id).
  const missing = requiredIds.filter((id) => !seen.has(id) && !invalidIds.has(id));
  return { addressed: requiredIds.every((id) => seen.has(id)), missing, invalid };
}

// A compact panel breakdown for the block message — severity counts + which
// reviewer flagged how many — so the agent/human sees the shape of the review at a
// glance without opening pending.md. Per-reviewer counts attribute each merged
// finding to its representative provider (cross-provider confirmations collapse to
// one), so they may sum to ≤ the total; the severity counts are authoritative.
function formatPanelSummary(summary: RunSummary): string {
  const { critical, warn, info } = summary.counts;
  const sev =
    [
      critical > 0 ? `${critical} CRITICAL` : null,
      warn > 0 ? `${warn} WARN` : null,
      info > 0 ? `${info} INFO` : null,
    ]
      .filter((x): x is string => x !== null)
      .join(" · ") || "0 findings";
  const perReviewer = summary.providers
    .filter((p) => p.runs > 0)
    .map((p) => `${p.provider} ${p.findings}${p.errors > 0 ? " ⚠" : ""}`)
    .join(" · ");
  return perReviewer ? `${sev}  ·  reviewers: ${perReviewer}` : sev;
}

// Surface degraded reviewer coverage in the Stop-hook reason so an agent doesn't
// take a PASS at face value when some reviewers didn't actually complete (e.g.
// a single claude-code reviewer timed out and the verdict comes from 0 ok runs
// rendered as PASS via softer paths). Returns null when coverage is full.
function formatCoverageNote(summary: RunSummary): string | null {
  const total = summary.providers.length;
  if (total === 0) return null;
  const degraded = summary.providers.filter((p) => p.runs === 0 || p.errors > 0).length;
  if (degraded === 0) return null;
  const word = degraded === 1 ? "reviewer" : "reviewers";
  return `reduced coverage: ${degraded} of ${total} ${word} did not complete`;
}

// #3-timing (field report 2026-06-17): a passing verdict ends the turn silently, and the
// agent/user can then commit + push (→ Coolify auto-deploy) BEFORE a deeper review runs. The
// gate has no authority over a later push, but it CAN label a SHALLOW pass as provisional at
// the allow_stop boundary — the moment the agent decides "clean → confirm → push". A pass is
// "preliminary" when no real panel ran (triage-skip / cache / checks-only) OR fewer reviewers
// completed OK than the config asks for. NOT preliminary: a full-coverage panel pass, incl. a
// SUPPORTED single-reviewer config (depth is ok-vs-configured, never absolute count). The
// label is honest about uncertainty — it says "a fuller review MAY surface more", never a
// guarantee (it cannot detect a full panel that simply got lucky on one run). Render-only:
// it never changes the verdict or blocks; push-gating belongs in a pre-push/CI hook.
function preliminaryReason(summary: RunSummary, configuredReviewers: number): string | null {
  if (summary.source === "skipped") return "triage-skipped — no reviewer panel ran";
  if (summary.source === "cache") return "served from cache — no fresh panel ran";
  if (summary.source === "checks") return "deterministic checks only — no reviewer panel ran";
  const okReviewers = summary.providers.filter((p) => p.runs > p.errors).length;
  if (configuredReviewers > 0 && okReviewers < configuredReviewers) {
    return `reviewed by ${okReviewers} of ${configuredReviewers} configured reviewers`;
  }
  return null;
}

// On a verdict===ERROR result, surface WHICH reviewer(s) didn't complete and
// how long they ran, so an agent doesn't misdiagnose (real shoal case: a 300s
// claude-code timeout was read as "subprocess failing to start" because the
// message said only "reviewer error"). RunSummary stores counts not per-run
// statuses, so we use provider name + accumulated duration_ms — together a
// strong signal (≈timeoutMs → timeout; ≈0s → instant error; see pending.md
// for the exact status_detail).
function formatErrorBreakdown(summary: RunSummary): string {
  if (summary.providers.length === 0) {
    return "no reviewer ran (check provider availability/config)";
  }
  const errored = summary.providers.filter((p) => p.errors > 0);
  if (errored.length === 0) {
    return `0 of ${summary.providers.length} reviewer(s) completed`;
  }
  const each = errored
    .map((p) => `${p.provider} errored after ${(p.duration_ms / 1000).toFixed(1)}s`)
    .join(" · ");
  const word = summary.providers.length === 1 ? "reviewer" : "reviewers";
  return `${each} · 0 of ${summary.providers.length} ${word} ok`;
}

export class LoopDriver {
  constructor(private readonly i: LoopInput) {}

  // The dirty.flag as read ONCE at run start — the batch this gate run actually
  // reviewed. Used by unlinkDirtyFlagIfUnchanged for compare-and-delete (F-005).
  private capturedFlag: DirtyFlag | null = null;

  // Compare-and-delete for dirty.flag (F-005/F-016). The PostToolUse trigger is
  // async and NOT serialized by the gate lock, so during the multi-minute panel a
  // parallel session's edit (or a laggard async trigger) can atomically REWRITE
  // the flag with a batch this review never saw. Unconditionally unlinking would
  // silently drop that batch: the other session's next stop sees no flag + an
  // unchanged HEAD (stopHasNothingToReview) → allow_stop → unreviewed code ships.
  // handleTrigger stamps a fresh `ts` + `diff_hash` on every rewrite, so we only
  // delete when the on-disk flag still matches what this run captured at start;
  // a newer flag is restored so the next stop reviews it. The compare is done on
  // a PRIVATE copy taken off the public path via atomic rename FIRST (the flock
  // reclaimIfDead pattern), so there is no read→unlink window in which a newer
  // flag could be destroyed. The residual races are both benign over-review:
  // restoring a mid-review flag may clobber an even-newer one written during the
  // reap (older ts/base only WIDENS the next review's scope), and a trigger that
  // fires while the path is briefly empty re-captures a fresh base for the
  // post-review batch. An unparseable private copy is deleted (old behavior —
  // nothing newer to preserve).
  private unlinkDirtyFlagIfUnchanged(): void {
    const flagPath = dirtyFlagPath(this.i.repoRoot);
    const reapPath = `${flagPath}.reap.${process.pid}`;
    try {
      renameSync(flagPath, reapPath);
    } catch {
      return; // no flag on the public path — nothing to delete
    }
    let reaped: DirtyFlag | null = null;
    try {
      reaped = JSON.parse(readFileSync(reapPath, "utf8")) as DirtyFlag;
    } catch {
      /* unparseable → treated as nothing-newer; deleted below */
    }
    const captured = this.capturedFlag;
    if (
      reaped !== null &&
      captured !== null &&
      (reaped.ts !== captured.ts || reaped.diff_hash !== captured.diff_hash)
    ) {
      // Rewritten mid-review → put it back; the next stop reviews the newer batch.
      try {
        renameSync(reapPath, flagPath);
      } catch {
        /* restore failed (path vanished?) — the private copy below is best effort */
      }
      return;
    }
    try {
      unlinkSync(reapPath);
    } catch {
      /* noop */
    }
  }

  async run(): Promise<LoopDecision> {
    // NOTE: we deliberately do NOT short-circuit on stop_hook_active here. Real
    // Claude Code marks every stop inside a hook-forced continuation as
    // stop_hook_active=true, so a blanket short-circuit would skip the
    // re-review of the agent's fix and let it stop with an unverified diff. The
    // FAIL→fix→re-review→PASS loop must run in-chain. Termination is guaranteed
    // without it: review rounds advance `iteration` toward the iter-cap
    // escalation, and the decisions-gate (which does NOT advance the counter) is
    // bounded below by escalating once a forced continuation leaves findings
    // unaddressed.
    const flag = readDirtyFlag(this.i.repoRoot);
    this.capturedFlag = flag;
    let state = await this.i.state.load();

    // No dirty.flag since last PASS → nothing to review.
    if (!flag) {
      return {
        kind: "allow_stop",
        reason: "🟢 Reviewgate · GATE OPEN — No code changes since last review.",
      };
    }

    // Re-arm on commit, but ONLY to recover an escalated gate. If HEAD moved
    // while the gate was ESCALATED, the human has taken over and committed; reset
    // the budget so the next batch is gated again instead of staying gated-off.
    // We deliberately do NOT re-arm on a HEAD move while mid-FAIL (not escalated):
    // committing must never bypass the pending-decisions gate, or an agent could
    // land unaddressed findings by committing them. On first sight (null baseline,
    // e.g. a state.json from before this field existed) we only RECORD the sha so
    // a later commit is detectable. A clean PASS re-arms separately (see below).
    const headSha = this.i.headSha ?? null;
    if (headSha !== null && state.last_reviewed_head_sha !== headSha) {
      const headMovedWhileEscalated = state.last_reviewed_head_sha !== null && state.escalated;
      await this.i.state.update((cur) =>
        ReviewgateStateSchema.parse({
          ...cur,
          ...(headMovedWhileEscalated
            ? {
                iteration: 0,
                cost_usd_so_far: 0,
                signature_history: [],
                location_history: [],
                iteration_stats: [],
                fp_rejects_history: [],
                escalated: false,
                escalation_reason: null,
                escalation_announced: false,
                // Reset the timeout streak too — otherwise a commit that recovers
                // a review-timeout escalation leaves incomplete_runs at the cap, so
                // the first timeout in the fresh cycle re-escalates immediately
                // instead of honoring the consecutive-incomplete threshold.
                incomplete_runs: 0,
                // Fresh cycle → drop the cross-iteration confirmed-FP accumulator.
                cumulative_fp_rejects: 0,
                fp_counted_through_iter: 0,
                decisions_emitted_through_iter: 0,
                cycle_rejected_signatures: [],
                claimed_fixed_signatures: {},
                // Bump the reputation cycle sequence so the new cycle's event-ids
                // don't collide with the escalated cycle's events.
                reputation_cycle_seq: cur.reputation_cycle_seq + 1,
              }
            : {}),
          last_reviewed_head_sha: headSha,
        }),
      );
      // The commit closed the escalated cycle → wipe its decisions too, so a
      // stale finding_id can't satisfy the next cycle's gate (see clearDecisions).
      // Also drop the F2 per-run proposal pool: a recovered cycle's accumulated
      // proposals belong to that cycle and must not bleed into the next one.
      if (headMovedWhileEscalated) {
        clearDecisions(this.i.repoRoot);
        new ProposalStore(this.i.repoRoot, state.session_id).clear();
      }
      state = await this.i.state.load();
    }

    // Post-escalation NEW edits: each escalation announce UNLINKS the dirty.flag,
    // so a flag present here while still escalated+announced means the agent edited
    // MORE code AFTER being told the gate gave up. That new diff was never reviewed;
    // the escalation was about the PRIOR change-set. Re-arm into a fresh cycle and
    // review the new work instead of waving the stop through on un-reviewed code
    // (F-002). (A commit-while-escalated is handled above; this is the no-commit,
    // keep-editing case.) Termination still holds — the fresh cycle is itself
    // bounded by maxIterations/cost-cap.
    if (state.escalated && state.escalation_announced) {
      await this.i.state.update((cur) =>
        ReviewgateStateSchema.parse({
          ...cur,
          iteration: 0,
          cost_usd_so_far: 0,
          signature_history: [],
          location_history: [],
          iteration_stats: [],
          fp_rejects_history: [],
          escalated: false,
          escalation_reason: null,
          escalation_announced: false,
          incomplete_runs: 0,
          cumulative_fp_rejects: 0,
          fp_counted_through_iter: 0,
          decisions_emitted_through_iter: 0,
          cycle_rejected_signatures: [],
          claimed_fixed_signatures: {},
          reputation_cycle_seq: cur.reputation_cycle_seq + 1,
        }),
      );
      clearDecisions(this.i.repoRoot);
      new ProposalStore(this.i.repoRoot, state.session_id).clear();
      state = await this.i.state.load();
    }

    // Fold the prior iteration's decisions into the learn loops (FP-ledger +
    // reputation) BEFORE the cost-cap / max-iterations / stuck-signatures
    // escalation preconditions below: each of them early-returns via
    // escalateAndDecide WITHOUT reaching the iteration>0 block further down, and
    // the loss would be permanent — the post-escalation re-arm (above, next dirty
    // turn) resets iteration to 0 and clearDecisions() the file before any later
    // absorb could read it. The stuck-signatures case is the most likely real hit:
    // identical finding sets two iters in a row typically coincide with the agent
    // having just written rejections (incl. reviewer_was_wrong) for the final
    // round. absorbPriorDecisions is idempotent per (session, cycle, iter) and a
    // no-op at iteration < 1, so the single hoisted call here is safe; it remains
    // the ONLY call site (a second call later in this run would double-count).
    await this.absorbPriorDecisions(state);

    // Escalation precondition: cost cap reached (apikey/openrouter mode only;
    // OAuth mode cost is 0 so this never fires there).
    if (
      this.i.config.loop.costCapUsd > 0 &&
      state.cost_usd_so_far >= this.i.config.loop.costCapUsd
    ) {
      return this.escalateAndDecide(
        state,
        "cost-cap",
        `Cost $${state.cost_usd_so_far.toFixed(2)} reached the cap of $${this.i.config.loop.costCapUsd.toFixed(2)}.`,
      );
    }

    // Escalation precondition: iteration cap reached. But a CONVERGING loop —
    // where each round's REAL finding count (total − confirmed reviewer FPs) is
    // strictly DECREASING (healthy spec/code refinement, e.g. 5 → 3 → 1 → 0) — is
    // genuinely making progress, not stuck, so it is allowed to continue past
    // maxIterations up to a hard backstop (2× the cap). Only a NON-progressing loop
    // (real findings flat or rising) escalates at the cap. Total finding count is NOT
    // used: the panel can add fresh FPs faster than real findings are fixed, masking
    // real progress. The hard backstop + cost-cap + stuck-signature detection remain
    // as upper bounds so this can never run away.
    // N1: the per-diff soft cap. A small low-risk diff (triage set
    // max_iterations_override) escalates/stops after fewer rounds; it can only LOWER
    // the config cap, never raise it. The hard cap (2×) + stuck/cost/fp breakers
    // below still bound everything.
    const maxIter =
      state.max_iterations_override != null
        ? Math.min(this.i.config.loop.maxIterations, state.max_iterations_override)
        : this.i.config.loop.maxIterations;
    if (state.iteration >= maxIter) {
      const hist = state.signature_history;
      const fpHist = state.fp_rejects_history;
      const n = hist.length;
      // The latest iteration's FP-rejects are not folded into fpHist yet (the fold
      // runs after this check), so compute them fresh from the current pending +
      // decisions. Absolute indices (n-1, n-2) — never relative .at() across two
      // arrays of possibly different length.
      const latestWrong =
        n > 0
          ? computeRejectRate(this.i.repoRoot, state.iteration, previousFindingIds(this.i.repoRoot))
              .wrongRejects
          : 0;
      const realAt = (k: number, wrongOverride?: number) =>
        Math.max(0, (hist[k]?.length ?? 0) - (wrongOverride ?? fpHist[k] ?? 0));
      // Only iterations that actually REVIEWED contribute to convergence. An ERROR
      // iteration (reviewer timeout/quota/error) appends a 0-length signature row;
      // reading it as "0 real findings" would make a transient mid-cycle error look
      // like a non-progressing round and prematurely abort a genuinely-converging
      // cycle (F-001). Skip empty rows; compare the last two REVIEWED rounds. The
      // latest-iteration FP-reject override only applies if the genuine last
      // iteration (index n-1) was itself reviewed (else its fpHist is already folded).
      const reviewedIdx = hist.reduce<number[]>((acc, h, k) => {
        if (h.length > 0) acc.push(k);
        return acc;
      }, []);
      const m = reviewedIdx.length;
      const lastIdx = m > 0 ? (reviewedIdx[m - 1] as number) : -1;
      const prevIdx = m >= 2 ? (reviewedIdx[m - 2] as number) : -1;
      const lastReal =
        lastIdx >= 0
          ? realAt(lastIdx, lastIdx === n - 1 ? latestWrong : undefined)
          : Number.POSITIVE_INFINITY;
      const prevReal = prevIdx >= 0 ? realAt(prevIdx) : Number.POSITIVE_INFINITY;
      const fpStreakOn = this.i.config.loop.fpStreakThreshold > 0;
      // N3: convergence is NOT raw count alone. When the agent switches approach
      // (e.g. flex → fixed layout) each round surfaces DIFFERENT findings, so the count
      // can rise even as the code converges — "reviewer attention not converging" is not
      // "code not converging". Read three signals over the last two REVIEWED rounds; ANY
      // is progress:
      //   (1) fewer real (non-FP) findings than the prior round — the original signal;
      //   (2) severity improving — the worst tier shrinks (CRITICALs, then WARNs): the
      //       code is getting safer even if a nitpick count rose;
      //   (3) approach churn — the set of PERSISTENT (recurring) findings is smaller than
      //       the prior round's real count: prior issues were CLEARED (not re-litigated)
      //       even though fresh findings appeared.
      // The genuine-stall case (same findings recur, flat severity) is none of these →
      // still escalates. All paths remain bounded by the hard cap + stuck/cost/fp breakers.
      const lastStats = lastIdx >= 0 ? state.iteration_stats[lastIdx] : undefined;
      const prevStats = prevIdx >= 0 ? state.iteration_stats[prevIdx] : undefined;
      const severityImproving =
        !!lastStats &&
        !!prevStats &&
        (lastStats.critical < prevStats.critical ||
          (lastStats.critical === prevStats.critical && lastStats.warn < prevStats.warn));
      const prevSet = new Set(prevIdx >= 0 ? (hist[prevIdx] ?? []) : []);
      let recurring = 0;
      for (const s of lastIdx >= 0 ? (hist[lastIdx] ?? []) : []) {
        if (prevSet.has(s)) recurring += 1;
      }
      // Non-convergence fix: approach-churn (different signatures than last round) is only
      // genuine PROGRESS if the latest reviewed round surfaced a finding on a region NOT seen in
      // any prior reviewed round. If every region was already raised earlier this cycle, the
      // "fresh signatures" are the SAME lines re-litigated (a treadmill), not approach-switching —
      // so it must NOT earn churn credit (else the loop runs to the hard cap on a settled region).
      const latestRegions = lastIdx >= 0 ? (state.location_history[lastIdx] ?? []) : [];
      const priorRegionSet = new Set<string>();
      for (let k = 0; k < lastIdx; k++) {
        for (const r of state.location_history[k] ?? []) priorRegionSet.add(r);
      }
      const hasNewLocation =
        state.location_history.length === 0 || latestRegions.some((r) => !priorRegionSet.has(r));
      const churnProgressing =
        Number.isFinite(prevReal) && prevReal > 0 && recurring < prevReal && hasNewLocation;
      const progressing =
        m >= 2 &&
        (lastReal < prevReal ||
          (lastReal === 0 && fpStreakOn) ||
          severityImproving ||
          churnProgressing);
      const hardCap = maxIter * 2;
      if (state.iteration >= hardCap) {
        return this.escalateAndDecide(
          state,
          "max-iterations",
          `Reached the hard cap of ${hardCap} iterations.`,
        );
      }
      if (!progressing) {
        // Diagnostic reason (N3): a genuine stall, not approach-churn — the same issues
        // keep recurring and severity is not dropping. Lets the human read the right story.
        return this.escalateAndDecide(
          state,
          "max-iterations",
          `Reached ${state.iteration} iterations without convergence — ${recurring} of the prior round's findings recurred and severity did not improve (real findings not decreasing).`,
          true,
        );
      }
      // Converging (real findings strictly fewer than the previous round) and below
      // the hard cap → fall through and review another round toward a clean pass.
    }

    // Stuck-loop: the SAME non-empty signature set repeated for `stuckThreshold`
    // consecutive iterations (config.loop.stuckThreshold; default 2 = the original
    // "two iters in a row"). Now actually wired to config — previously the window
    // was hardcoded to 2 and stuckThreshold was dead. Configurable so a repo can
    // raise it above the FP-ledger's active-promotion horizon: a repeated
    // cross-provider FP needs ≥3 rejects (→ 3 iterations) to reach `active` and be
    // auto-demoted, so with the default 2 the gate escalates before the ledger can
    // suppress it. Clamp to ≥2 (a 1-iter "streak" isn't a stuck loop). An empty
    // signature set (a clean iteration) never counts as stuck.
    const stuckN = Math.max(2, this.i.config.loop.stuckThreshold);
    const hist = state.signature_history;
    const windowKey = hist[hist.length - 1]?.join(",");
    if (
      hist.length >= stuckN &&
      windowKey !== undefined &&
      windowKey !== "" &&
      hist.slice(-stuckN).every((s) => s.join(",") === windowKey)
    ) {
      return this.escalateAndDecide(
        state,
        "stuck-signatures",
        `Findings unchanged across ${stuckN} iterations.`,
        true,
      );
    }

    // #5: per-signature recurrence — break the treadmill where ONE blocking finding
    // recurs amid a churning set (the whole-set stuck check above misses it). Fail-safe:
    // escalate (surface to the human), never suppress.
    const sigRecurCfg = this.i.config.loop.maxSignatureRecurrence;
    if (sigRecurCfg > 0) {
      // Clamp strictly above the (clamped) whole-set stuck threshold so a total stall
      // always escalates faster via stuck-signatures and a low mis-config can't make
      // per-signature the eager dominant trigger.
      const stuckClamp = Math.max(2, this.i.config.loop.stuckThreshold);
      const sigRecurThreshold = Math.max(sigRecurCfg, stuckClamp + 1);
      // Off-ramp grace: exclude signatures the agent rejected (reviewer_was_wrong) in
      // the just-completed iteration — pending.json still lists them as CRITICAL/WARN,
      // but cycleRejected will demote them on the NEXT panel run; escalating here would
      // preempt the off-ramp. (A persistently-rejected-yet-blocking finding is surfaced
      // by reviewer-fp-streak instead.)
      const justRejected = new Set(
        priorIterationRejectedSignatures(this.i.repoRoot, state.iteration),
      );
      const blocking = new Set(
        readPendingReport(this.i.repoRoot)
          .findings.filter((f) => f.severity === "CRITICAL" || f.severity === "WARN")
          .map((f) => f.signature)
          .filter((s) => !justRejected.has(s)),
      );
      const recurring = recurringBlockingSignatures(
        state.signature_history,
        blocking,
        sigRecurThreshold,
      );
      if (recurring.length > 0) {
        return this.escalateAndDecide(
          state,
          "signature-recurrence",
          `${recurring.length} blocking finding(s) recurred across ${sigRecurThreshold} consecutive reviews without resolving (e.g. \`${recurring[0]}\`). To converge: fix each definitively, or — if it is a false positive — reject it (reviewer_was_wrong) so it is suppressed on recurrence. Further edits spawn fresh reviews and prolong the loop.`,
          true,
        );
      }
    }

    // Non-convergence: per-LOCATION recurrence — the signature-keyed sibling above misses a
    // reviewer re-litigating the SAME file:line region under a DIFFERENT signature each round
    // (the field "remove the ?." → "add the ?. back" → … treadmill). Checked AFTER
    // signature-recurrence and clamped strictly above stuckThreshold so the whole-set / per-
    // signature stalls still win when applicable; a pure location-treadmill reaches here precisely
    // because the signature-keyed checks returned []. Fail-safe: escalate (surface to the human,
    // block-once), NEVER suppress the finding. No off-ramp exclusion — a region re-raised under a
    // fresh signature is exactly what the signature off-ramp (cycleRejected) cannot suppress.
    const locRecurCfg = this.i.config.loop.maxLocationRecurrence;
    if (locRecurCfg > 0) {
      const stuckClampLoc = Math.max(2, this.i.config.loop.stuckThreshold);
      const locRecurThreshold = Math.max(locRecurCfg, stuckClampLoc + 1);
      const blockingRegions = new Set(
        readPendingReport(this.i.repoRoot)
          .findings.filter((f) => f.severity === "CRITICAL" || f.severity === "WARN")
          .map((f) => locationKey(f.file, f.line_start)),
      );
      const recurringLoc = recurringBlockingLocations(
        state.location_history,
        blockingRegions,
        locRecurThreshold,
      );
      if (recurringLoc.length > 0) {
        return this.escalateAndDecide(
          state,
          "location-recurrence",
          `A code region was re-raised as a blocking finding across ${locRecurThreshold} consecutive reviews under a CHANGING signature each round (e.g. \`${recurringLoc[0]}\`) — a contradiction/treadmill the signature-keyed guards miss. To converge: fix the region definitively, reject it (reviewer_was_wrong) if the reviewer keeps re-litigating a settled line, or add a \`phases.review.houseRules\` entry. Surfaced to you — do NOT keep re-editing.`,
          true,
        );
      }
    }

    // If a prior iter exists, both the decisions-gate and the reject-rate
    // circuit-breaker need the prior iteration's blocking finding ids — read
    // pending.json ONCE and share it.
    if (state.iteration > 0) {
      const requiredIds = previousFindingIds(this.i.repoRoot);

      // (absorbPriorDecisions was hoisted ABOVE the cost-cap / max-iterations /
      // stuck-signatures preconditions — see the call before them in run(). It
      // already consumed this iteration's decisions, so do NOT call it again
      // here: a second call in the same run would double-count.)

      // Per-cycle suppression (2b) + claimed-fixed tracking (§4.3): fold the PRIOR
      // iteration's reviewer_was_wrong rejections AND accepted/action:"fixed"
      // dispositions into their respective cycle-scoped maps in a SINGLE state.update
      // so the two folds can't tear state. The new panel demotes rejected
      // recurrences and re-flags claimed-fixed recurrences. Both reset on re-arm.
      const priorRejected = priorIterationRejectedSignatures(this.i.repoRoot, state.iteration);
      const priorClaimedFixed = priorIterationClaimedFixedSignatures(
        this.i.repoRoot,
        state.iteration,
      );
      const mergedRejected = [...new Set([...state.cycle_rejected_signatures, ...priorRejected])];
      const mergedClaimedFixed: Record<string, number> = { ...state.claimed_fixed_signatures };
      const claimedIter = state.iteration; // the iteration whose decisions we just folded
      // Reconcile THIS iteration's contribution before re-adding: the decisions-gate
      // re-blocks across multiple stops of one iteration, so an early partial-file fold
      // may have recorded a claim the agent later (same iteration) superseded to a
      // non-fixed disposition. The persisted map is add-only, so drop every entry
      // recorded AT this iteration, then re-add from the current last-wins set below.
      // Entries from EARLIER iterations (value < claimedIter) are locked and preserved
      // (a fix genuinely claimed in iter1 is not erased by an iter3 supersede).
      for (const sig of Object.keys(mergedClaimedFixed)) {
        if (mergedClaimedFixed[sig] === claimedIter) delete mergedClaimedFixed[sig];
      }
      for (const sig of priorClaimedFixed) {
        const existing = mergedClaimedFixed[sig];
        // Keep the EARLIEST iteration the fix was claimed (idempotent re-stops + a
        // re-flagged-then-re-fixed signature must not advance its recorded iter).
        if (existing === undefined || claimedIter < existing) mergedClaimedFixed[sig] = claimedIter;
      }
      const rejectedChanged = mergedRejected.length !== state.cycle_rejected_signatures.length;
      const claimedChanged =
        Object.keys(mergedClaimedFixed).length !==
          Object.keys(state.claimed_fixed_signatures).length ||
        Object.entries(mergedClaimedFixed).some(
          ([k, v]) => state.claimed_fixed_signatures[k] !== v,
        );
      if (rejectedChanged || claimedChanged) {
        await this.i.state.update((cur) => ({
          ...cur,
          cycle_rejected_signatures: mergedRejected,
          claimed_fixed_signatures: mergedClaimedFixed,
        }));
        state = {
          ...state,
          cycle_rejected_signatures: mergedRejected,
          claimed_fixed_signatures: mergedClaimedFixed,
        };
      }

      // Decisions-gate: every required finding must have a decision.
      const gate = evaluateDecisions(this.i.repoRoot, state.iteration, requiredIds);
      if (requiredIds.length > 0 && !gate.addressed) {
        // Surface WHICH lines were invalid (and why) and which ids are still
        // missing, so a formatting mistake (too-short reason, missing action) is
        // never silently dropped into an opaque re-block (F-088).
        const detail = [
          gate.missing.length > 0 ? `Missing decisions for: ${gate.missing.join(", ")}` : null,
          gate.invalid.length > 0 ? `Rejected (fix & re-write): ${gate.invalid.join("; ")}` : null,
        ]
          .filter((x): x is string => x !== null)
          .join(" · ");
        // The decisions-gate does not advance `iteration`, so re-blocking on a
        // hook-forced continuation would loop forever (the iter-cap escalation
        // can never catch it). When stop_hook_active is set, the agent has
        // already been told to address these findings in a prior block and has
        // ended another turn without doing so — escalate to the human instead
        // of nagging indefinitely. On a fresh user-initiated stop, just block.
        if (this.i.stopHookActive) {
          return this.escalateAndDecide(
            state,
            "decisions-unaddressed",
            `Findings from iteration ${state.iteration} were never addressed in .reviewgate/decisions/${state.iteration}.jsonl after a forced re-prompt.${detail ? ` ${detail}` : ""}`,
          );
        }
        return {
          kind: "block",
          reason: `🔴 Reviewgate · GATE CLOSED — iteration ${state.iteration} · findings not yet addressed in .reviewgate/decisions/${state.iteration}.jsonl. For each finding ID, append a line with verdict=accepted (action:"fixed") OR verdict=rejected (reason:"…" ≥20 chars, reviewer_was_wrong:true).${detail ? ` ${detail}` : ""}`,
        };
      }

      // Precision metric (telemetry only): emit one decision.applied audit event per
      // finalized decision of this iteration, ONCE. Advance the per-cycle watermark
      // in state BEFORE appending → at-most-once: a crash loses at most this iter's
      // events, never double-counts (so stats counts events without dedup). Fully
      // best-effort: a failure here must never change the verdict or block the gate.
      if (state.iteration > state.decisions_emitted_through_iter) {
        try {
          await this.i.state.update((cur) => ({
            ...cur,
            decisions_emitted_through_iter: Math.max(
              cur.decisions_emitted_through_iter,
              state.iteration,
            ),
          }));
          state = await this.i.state.load();
          await emitDecisionOutcomes(
            this.i.repoRoot,
            state.iteration,
            state.session_id,
            this.i.audit,
          );
        } catch {
          /* best-effort precision telemetry */
        }
      }

      // (absorbPriorDecisions runs before the escalation preconditions at the top
      // of run(), so it covered the decisions-unaddressed early-return too.)

      // Confirmed-FP signal for the PRIOR iteration. computeRejectRate dedups by
      // finding_id + restricts to the real `requiredIds`, so the agent (which authors
      // the decisions files) cannot pad duplicate/fabricated lines to manufacture an
      // escape-hatch — it can only move the numbers by rejecting REAL findings.
      const rr = computeRejectRate(this.i.repoRoot, state.iteration, requiredIds);

      // (a) Single-iteration burst: a high confirmed-FP RATE within ONE iteration →
      // stop nagging and surface to the human. Runs AFTER the decisions-gate so an
      // unaddressed-findings block always takes precedence. Guarded by a min sample.
      if (
        this.i.config.loop.rejectRateEscalation > 0 &&
        rr.total >= MIN_DECISIONS_FOR_REJECT_RATE &&
        rr.rate >= this.i.config.loop.rejectRateEscalation
      ) {
        return this.escalateAndDecide(
          state,
          "reject-rate-high",
          `${rr.wrongRejects}/${rr.total} decisions this cycle were confirmed reviewer false positives (rate ${(rr.rate * 100).toFixed(0)}% ≥ ${(this.i.config.loop.rejectRateEscalation * 100).toFixed(0)}%).`,
        );
      }

      // (b) Cross-iteration slow drip: a reviewer that hallucinates a FRESH confirmed-FP
      // each iteration evades (a) (1 FP/iter never reaches the sample floor), the
      // signature-keyed FP-ledger + stuck-detection (mutating signature), AND the
      // iter-cap (noisy convergence). Accumulate confirmed FPs ACROSS the cycle —
      // folded in ONCE per iteration (fp_counted_through_iter guard → idempotent on a
      // re-stop) — and escalate at fpStreakThreshold so a faulty reviewer surfaces to
      // the human instead of nagging to the hard cap. Same fabrication-proofing as (a)
      // (each increment is the real-id-anchored computeRejectRate of one iteration).
      const fpThreshold = this.i.config.loop.fpStreakThreshold;
      if (state.iteration > state.fp_counted_through_iter) {
        const cumulativeFp = state.cumulative_fp_rejects + rr.wrongRejects;
        await this.i.state.update((cur) => {
          // Absolute-index write: fp_rejects_history[k] ↔ signature_history[k].
          // Pad historical gaps with 0 (self-heals a back-compat upgrade where
          // signature_history is populated but fp_rejects_history loaded as []).
          const idx = cur.signature_history.length - 1; // latest completed iteration
          const fph = cur.fp_rejects_history.slice();
          while (fph.length < idx) fph.push(0);
          if (idx >= 0) fph[idx] = rr.wrongRejects;
          return ReviewgateStateSchema.parse({
            ...cur,
            cumulative_fp_rejects: cur.cumulative_fp_rejects + rr.wrongRejects,
            fp_counted_through_iter: Math.max(cur.fp_counted_through_iter, state.iteration),
            fp_rejects_history: fph,
          });
        });
        state = await this.i.state.load();
        if (fpThreshold > 0 && cumulativeFp >= fpThreshold) {
          return this.escalateAndDecide(
            state,
            "reviewer-fp-streak",
            `${cumulativeFp} confirmed reviewer false positives accumulated across ${state.iteration} iterations (threshold ${fpThreshold}) — a reviewer appears to be producing persistent false positives. See .reviewgate/pending.md for the rejected findings and their provider; consider disabling or replacing that reviewer in reviewgate.config.ts.`,
          );
        }
      }

      // (Reputation + FP-ledger learning was hoisted UP to absorbPriorDecisions
      // above, so it fires even when the reject-rate / fp-streak escalation
      // checks early-return. Don't add a learn call back here — it'd
      // double-process the same iter's decisions.)
    }

    // Run a new iteration — but bounded by a self-imposed deadline strictly
    // below the Stop-hook timeout. If the review can't finish in time we abort
    // the in-flight reviewers and FAIL CLOSED (block "did not complete"), rather
    // than letting Claude Code kill the hook (non-blocking → fail-open, turn
    // ends un-reviewed). The abort signal lets runIteration stop writing
    // pending/state so it can't clobber the incomplete decision after the race.
    const nextIter = state.iteration + 1;
    // S1: the just-completed iteration's adjudications (state.iteration is the prior iter;
    // [] when state.iteration < 1). Injected into the next panel's prompt so it does not
    // re-litigate settled regions.
    const priorAdjs = priorAdjudications(this.i.repoRoot, state.iteration);
    const runTimeoutMs = this.i.config.loop.runTimeoutMs;
    let result: IterationResult;
    if (runTimeoutMs > 0) {
      const ac = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const runP = this.i.orchestrator.runIteration({
        runId: state.session_id,
        iter: nextIter,
        signal: ac.signal,
        cycleRejectedSignatures: state.cycle_rejected_signatures,
        claimedFixedSignatures: state.claimed_fixed_signatures,
        priorAdjudications: priorAdjs,
      });
      let raced: "timeout" | { ok: true; r: IterationResult };
      try {
        const deadline = new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), runTimeoutMs);
        });
        // try/finally so the deadline timer is ALWAYS cleared — even if runP
        // rejects before the timeout. A leaked timer keeps the Stop-hook process
        // alive until it fires (up to runTimeoutMs), reintroducing the very
        // hang→silent-kill→fail-open this feature exists to prevent.
        raced = await Promise.race([runP.then((r) => ({ ok: true as const, r })), deadline]);
      } finally {
        if (timer) clearTimeout(timer);
      }
      if (raced === "timeout") {
        // Deadline hit. Abort the panel, then await the run to settle: this
        // distinguishes a review that DID complete from one that did not.
        //  - Panel still running → its reviewers are SIGKILLed and writeReport's
        //    abort guard throws → runP REJECTS → genuinely incomplete (fail closed).
        //  - Verdict already written → only bounded post-verdict bookkeeping
        //    (curator/cache) overran; it finishes and runP RESOLVES → honor the
        //    real verdict instead of asking for a needless re-run.
        // The post-verdict gravy is timeout-bounded (curatorTimeoutMs), and
        // runTimeoutMs sits below the Stop-hook timeout with margin to absorb it.
        ac.abort();
        // Bound the post-abort settle: if runP never settles (a reviewer that
        // ignores the abort / unbounded gravy), do NOT await it forever — that
        // would hang past the OS Stop-hook kill = silent fail-open (M-A0.3).
        // Race the settle against a cap; if the cap wins, treat as incomplete.
        const settleCap = this.i.postAbortSettleMs ?? POST_ABORT_SETTLE_MS_DEFAULT;
        let settleTimer: ReturnType<typeof setTimeout> | undefined;
        const settledRun = await Promise.race([
          runP.then(
            (r) => ({ ok: true as const, r }),
            () => null,
          ),
          new Promise<null>((resolve) => {
            settleTimer = setTimeout(() => resolve(null), settleCap);
          }),
        ]).finally(() => {
          if (settleTimer) clearTimeout(settleTimer);
        });
        if (!settledRun) {
          return await this.handleIncompleteRun(state, runTimeoutMs);
        }
        result = settledRun.r;
      } else {
        result = raced.r;
      }
    } else {
      result = await this.i.orchestrator.runIteration({
        runId: state.session_id,
        iter: nextIter,
        cycleRejectedSignatures: state.cycle_rejected_signatures,
        claimedFixedSignatures: state.claimed_fixed_signatures,
        priorAdjudications: priorAdjs,
      });
    }

    // Best-effort stats emission: record the iteration's RunSummary as a
    // run.complete audit event. Wrapped in .catch so a logging failure can never
    // affect the verdict. Emitted on the iteration path only (not on the early
    // allow/escalation branches, which never run an iteration).
    await this.i.audit
      .append({
        event: "run.complete",
        run_id: state.session_id,
        iter: nextIter,
        trigger: "stop-hook",
        run_summary: result.summary,
      })
      .catch(() => {});

    // Transient quota outage: every reviewer was quota-capped (distinct from a
    // misconfig/crash ERROR). Defer instead of hard-blocking — don't advance the
    // iteration (no real review happened, so this must not march toward the
    // max-iterations escalation) and KEEP the dirty flag so the next turn
    // re-reviews once quota resets. Handled BEFORE the normal state update.
    if (result.verdict === "ERROR" && result.allReviewersQuotaLocked) {
      return await this.handleAllQuotaLocked(state);
    }

    // Broader transient infra outage: reviewers WERE attempted but every one failed
    // (mixed quota/timeout/error — the strict all-quota test above didn't catch it).
    // Bound-defer rather than hard-block + burn an iteration, so an automated agent
    // loop (which can't synchronously wait) isn't deadlocked. Escalates to the human
    // after infraDeferMaxConsecutive consecutive defers. A misconfig ERROR where
    // NOTHING was attempted (allReviewersInfraFailed=false) still hard-blocks below.
    if (result.verdict === "ERROR" && result.allReviewersInfraFailed) {
      return await this.handleInfraUnavailable(state, result);
    }

    // A clean PASS means this change-set converged → re-arm the budget so the
    // next batch starts fresh (and any prior escalation is cleared). A FAIL/ERROR
    // advances the counter toward the iter-cap escalation. Either way, record the
    // HEAD sha so a later commit can be detected and re-armed on.
    //
    // SOFT-PASS (WARN findings, none reaching the hard-FAIL bar) is governed by
    // loop.softPassPolicy: "allow"/"ask-once" keep it passing (re-arm); "block"
    // demotes it to a FAIL-like blocking outcome (advance the counter, require a
    // decision per WARN). PASS always passes regardless of policy.
    const softPolicy = this.i.config.loop.softPassPolicy;
    const softPassBlocks = result.verdict === "SOFT-PASS" && softPolicy === "block";
    const passed = (result.verdict === "PASS" || result.verdict === "SOFT-PASS") && !softPassBlocks;
    await this.i.state.update((cur) =>
      ReviewgateStateSchema.parse({
        ...cur,
        iteration: passed ? 0 : nextIter,
        cost_usd_so_far: passed ? 0 : cur.cost_usd_so_far + result.costUsd,
        signature_history: passed ? [] : [...cur.signature_history, result.signaturesThisIter],
        // Non-convergence: location regions index-aligned with signature_history (same append +
        // reset points), so a region re-litigated under a churning signature is detectable.
        location_history: passed ? [] : [...cur.location_history, result.locationsThisIter ?? []],
        // Length-aligned with signature_history: one entry per non-passing iteration
        // so the escalation report can show this iteration's real severity split.
        iteration_stats: passed
          ? []
          : [
              ...cur.iteration_stats,
              {
                critical: result.summary.counts.critical,
                warn: result.summary.counts.warn,
                info: result.summary.counts.info,
                cost_usd: result.costUsd,
                verdict: result.verdict,
              },
            ],
        escalated: passed ? false : cur.escalated,
        escalation_reason: passed ? null : cur.escalation_reason,
        escalation_announced: passed ? false : cur.escalation_announced,
        // Re-arm resets the cross-iteration FP accumulator; a non-pass preserves it
        // (the streak builds across the cycle's iterations).
        cumulative_fp_rejects: passed ? 0 : cur.cumulative_fp_rejects,
        fp_counted_through_iter: passed ? 0 : cur.fp_counted_through_iter,
        decisions_emitted_through_iter: passed ? 0 : cur.decisions_emitted_through_iter,
        fp_rejects_history: passed ? [] : cur.fp_rejects_history,
        // N1: persist THIS diff's per-diff soft cap so the next iteration's escalation
        // precondition can min() it with the config cap. Reset on a clean pass (re-arm).
        // On a non-pass take the just-run iteration's override DIRECTLY — including an
        // explicit null ("no override", e.g. the diff grew large/sensitive). It must NOT
        // fall back to the prior value, or a stale small-diff cap would wrongly cap a now-
        // large diff (codex DoD WARN). `?? null` only guards a (theoretical) undefined.
        max_iterations_override: passed ? null : (result.maxIterationsOverride ?? null),
        // Per-cycle suppression set (2b): cleared on re-arm so a fresh cycle
        // starts with no suppressed signatures; preserved across a cycle's FAILs.
        cycle_rejected_signatures: passed ? [] : cur.cycle_rejected_signatures,
        // §4.3: claimed-fixed map is cycle-scoped — cleared on re-arm, preserved across a cycle's FAILs.
        claimed_fixed_signatures: passed ? {} : cur.claimed_fixed_signatures,
        // The review actually completed (any verdict) → the incomplete-run
        // streak is broken; reset so a later timeout starts counting fresh.
        incomplete_runs: 0,
        // Any outcome that reaches the NORMAL state update (PASS/SOFT-PASS/FAIL, or a
        // misconfig ERROR) breaks the transient-infra-outage streak — the bounded
        // infra-defer returns early above and never gets here, so reaching this point
        // means the outage is over. Reset so a later outage counts fresh.
        consecutive_infra_defers: 0,
        consecutive_quota_defers: 0,
        last_reviewed_head_sha: headSha ?? cur.last_reviewed_head_sha,
        last_stop_ts: new Date().toISOString(),
        // On a clean pass (re-arm), bump the cycle sequence so the next cycle's
        // reputation event-ids can't collide with this cycle's (F-001 renumbers).
        // On a FAIL, keep the current seq — still the same cycle.
        reputation_cycle_seq: passed ? cur.reputation_cycle_seq + 1 : cur.reputation_cycle_seq,
      }),
    );

    let decision: LoopDecision;
    if (passed) {
      // Compare-and-delete: only consume the flag this run actually reviewed; a
      // flag rewritten mid-panel (concurrent session / laggard async trigger)
      // survives so the next stop reviews the newer batch (F-005/F-016).
      this.unlinkDirtyFlagIfUnchanged();
      // Cycle closed → wipe this cycle's decisions so stale finding_ids cannot
      // satisfy the next cycle's gate (see clearDecisions). Also drop the F2
      // per-run proposal pool — the curator already saw the final state of it
      // by the time this iteration produced a PASS, so it's done.
      clearDecisions(this.i.repoRoot);
      new ProposalStore(this.i.repoRoot, state.session_id).clear();
      await this.i.audit.append({
        event: "gate.decision",
        run_id: state.session_id,
        iter: nextIter,
        trigger: "stop-hook",
      });
      // Opt-in: block ONCE on a passing verdict so the agent is told the review
      // passed (on allow_stop the hook can't reach the agent at all). The dirty
      // flag is already deleted above, so the agent's re-stop hits the "no
      // changes" branch and allows the stop — no loop. Default off (silent pass)
      // to keep the happy path lean.
      //
      // softPassPolicy="ask-once" forces the same one-time block specifically for
      // SOFT-PASS, so the WARNs are surfaced before the gate opens; the re-stop is
      // clean (dirty flag deleted above) and allows. Reuses the acknowledge path.
      const forceSoftAck = result.verdict === "SOFT-PASS" && softPolicy === "ask-once";
      const coverage = formatCoverageNote(result.summary);
      const coverageSuffix = coverage ? ` · ⚠ ${coverage}` : "";
      // #3-timing: label a shallow/degraded pass as PRELIMINARY at the allow_stop boundary
      // (where the agent decides "clean → confirm → push"). Render-only — never blocks.
      const preliminary = preliminaryReason(
        result.summary,
        this.i.config.phases.review.reviewers?.length ?? 0,
      );
      const preliminarySuffix = preliminary
        ? ` · ⚠ PRELIMINARY (${preliminary}) — a fuller review may surface more findings; treat as NOT deploy-ready and avoid pushing/deploying on this pass alone.`
        : "";
      const isSoft = result.verdict === "SOFT-PASS";
      const warnCount = result.summary.counts.warn;
      // A non-failing CRITICAL can reach SOFT-PASS (F-006); it must be visible in
      // the open-gate message, not masked behind a WARN-only count.
      const criticalCount = result.summary.counts.critical;
      const softCounts = `${criticalCount > 0 ? `${criticalCount} CRITICAL · ` : ""}${warnCount} WARN`;
      decision =
        this.i.config.loop.acknowledgePass || forceSoftAck
          ? {
              kind: "block",
              reason: forceSoftAck
                ? `🟡 Reviewgate · GATE OPEN — ⚠️ SOFT-PASS (iteration ${nextIter}): ${formatPanelSummary(result.summary)}${coverageSuffix}. These are non-blocking warnings — review them in .reviewgate/pending.md, then end your turn again to accept and pass through.`
                : coverage
                  ? `🟢 Reviewgate · GATE OPEN — ✅ ${result.verdict} (iteration ${nextIter}) · ⚠ ${coverage}${preliminarySuffix}. Verdict is based on the reviewer(s) that did complete; treat as advisory if full coverage matters for this slice. End your turn again to pass through.`
                  : `🟢 Reviewgate · GATE OPEN — ✅ ${result.verdict} (iteration ${nextIter})${preliminarySuffix}. Review is clean, no findings to address. No action needed: simply end your turn again to pass through (you may briefly confirm the pass to the user first).`,
            }
          : {
              kind: "allow_stop",
              reason: isSoft
                ? `🟡 Reviewgate · GATE OPEN — SOFT-PASS (iteration ${nextIter}): ${softCounts}${coverageSuffix}${preliminarySuffix}. Non-blocking — see .reviewgate/pending.md.`
                : `🟢 Reviewgate · GATE OPEN — ${result.verdict} (iteration ${nextIter})${coverageSuffix}${preliminarySuffix}. Clear to finish.`,
            };
    } else if (result.verdict === "ERROR") {
      // The reviewer could not run (error/timeout/quota, or sandbox unavailable).
      // Block — Reviewgate must never pass a turn it could not actually review —
      // but with a reason that points at the reviewer, not at fixing findings.
      // Repeated errors increment the iteration and eventually hit the iter-cap
      // escalation, so this cannot loop forever.
      decision = {
        kind: "block",
        // Surface any cooled-down providers + their reset times (quota OR the short
        // timeout cooldown) so a stuck panel tells the dev WHICH provider and WHEN it
        // recovers — not a bare "run reviewgate doctor" (both field reports' ask).
        reason: `🔴 Reviewgate · GATE CLOSED — reviewer error (iteration ${nextIter}): ${formatErrorBreakdown(result.summary)}. See .reviewgate/pending.md for per-reviewer status detail.${this.quotaDegradationNote(new Date()) ?? " Run `reviewgate doctor` if this persists."}`,
      };
    } else {
      decision = {
        kind: "block",
        reason: `🔴 Reviewgate · GATE CLOSED — iteration ${nextIter}/${this.i.config.loop.maxIterations}\n   ${formatPanelSummary(result.summary)}\n   → record a decision per CRITICAL/WARN finding in .reviewgate/decisions/${nextIter}.jsonl  (details: .reviewgate/pending.md)`,
      };
    }

    // Last trailing side-effect: opt-in weekly snapshot. State, dirty-flag, and
    // gate.decision are already committed, so an interruption here cannot desync
    // audit vs gate state. Fully isolated (own try/catch) — never affects the verdict.
    try {
      await maybeWriteWeeklySnapshot(this.i.repoRoot, this.i.config);
    } catch {
      /* best-effort: a snapshot failure must never affect the gate */
    }

    return decision;
  }

  // A gate run hit loop.runTimeoutMs and was aborted before producing a verdict.
  // Fold the PRIOR iteration's decisions into the learn loops (FP-ledger +
  // reputation) so the signal survives even when this gate run escalates
  // before reaching a new iteration. Pre-this-fix, `learnFromDecisions` lived
  // inside `orchestrator.runIteration` and `learnReputationFromDecisions` ran
  // mid-LoopDriver AFTER the reject-rate / fp-streak escalation checks — so
  // a `reviewer-fp-streak` escalation (shoal 2026-05-29: opencode-security
  // produced 3 FPs in iter 1, agent rejected all 3 with reviewer_was_wrong,
  // gate escalated) left the decisions on disk but never consumed them.
  // The reviewer-fp-streak escalation is *driven by* exactly the signal we
  // want to learn from; losing it is the worst-case miss.
  //
  // Idempotent on re-stop: both learn calls are no-ops when `state.iteration`
  // is 0 (no prior decisions) or the decisions file is missing. Calling
  // twice on the same iter would double-count rejects in the FP-ledger — but
  // this is the only call site (the orchestrator's prior call was removed in
  // the same commit), so no duplication is possible across one cycle.
  private async absorbPriorDecisions(state: ReviewgateState): Promise<void> {
    if (state.iteration < 1) return;
    const nowIso = new Date().toISOString();
    const fpCfg = this.i.config.phases.fpLedger;
    if (fpCfg?.enabled) {
      const fpStore = new FpLedgerStore(this.i.repoRoot);
      await learnFromDecisions({
        repoRoot: this.i.repoRoot,
        prevIter: state.iteration,
        sessionId: state.session_id,
        cycleSeq: state.reputation_cycle_seq,
        store: fpStore,
        nowIso,
      })
        // Decay AFTER learning so freshly-touched entries (last_seen = now) are
        // never reaped; mirrors the brain curator's per-run decayPass.
        .then(() => fpStore.decayPass(nowIso))
        .catch(() => undefined);
    }
    if (this.i.config.phases.reputation?.enabled) {
      await learnReputationFromDecisions({
        repoRoot: this.i.repoRoot,
        iter: state.iteration,
        sessionId: state.session_id,
        cycleSeq: state.reputation_cycle_seq,
        store: new ReputationStore(this.i.repoRoot),
        nowIso,
        halfLifeDays: this.i.config.phases.reputation.halfLifeDays,
      }).catch(() => undefined);
    }
  }

  // All reviewers were quota-capped (transient outage). DEFER rather than block:
  // blocking would hold the dev hostage for hours during a pure quota outage, and
  // the change WAS not reviewed (so we can't pass it either). Keep the dirty flag
  // (untouched here) so the next turn re-reviews once quota resets, and do NOT
  // advance the iteration (skip the normal state update entirely) so a string of
  // quota-locked turns can't march to the max-iterations escalation. Distinct
  // from a misconfig ERROR, which still hard-blocks on the ERROR branch above.
  private async handleAllQuotaLocked(state: ReviewgateState): Promise<LoopDecision> {
    await this.i.state.update((cur) =>
      ReviewgateStateSchema.parse({
        ...cur,
        // The review DID complete (verdict ERROR, all-quota) → the consecutive
        // incomplete-run streak is broken (schema contract: "Reset to 0 whenever
        // a review actually completes"). Without this, timeout → quota-defer →
        // timeout would escalate "2 consecutive runs" across a completed run.
        incomplete_runs: 0,
        last_stop_ts: new Date().toISOString(),
      }),
    );
    const note = this.quotaDegradationNote(new Date()) ?? "";
    return {
      kind: "allow_stop",
      reason: `🟠 Reviewgate · GATE DEFERRED (iteration ${state.iteration}) — every reviewer is quota-capped right now, so this turn could not be reviewed. NOT blocking (transient outage, not your code); the change stays flagged and is re-reviewed automatically on your next turn once quota resets.${note}`,
    };
  }

  // No reviewer could complete a review (every attempt failed quota/timeout/error,
  // but NOT the pure-all-quota case handled above). DEFER a bounded number of turns
  // rather than hard-block: an automated agent loop can't synchronously wait out a
  // transient provider outage, so a hard block is a near-deadlock (both 2026-06-05
  // field reports). Guardrails that keep this fail-closed and NOT a silent bypass:
  //   • it never emits PASS — it is a visibly-distinct 🟠 DEFERRED allow_stop;
  //   • the dirty flag is KEPT (untouched here) → the change is re-reviewed next turn;
  //   • the iteration is NOT advanced (no real review → no march to max-iterations);
  //   • every defer is audit-logged;
  //   • after infraDeferMaxConsecutive consecutive defers it ESCALATES to the human —
  //     a persistent outage / misconfig must never silently defer forever.
  // infraDeferMaxConsecutive=0 disables the defer entirely (hard-block — prior behavior).
  private async handleInfraUnavailable(
    state: ReviewgateState,
    result: IterationResult,
  ): Promise<LoopDecision> {
    const cap = this.i.config.loop.infraDeferMaxConsecutive;
    const next = state.consecutive_infra_defers + 1;
    const breakdown = formatErrorBreakdown(result.summary);
    await this.i.audit
      .append({
        event: "gate.decision",
        run_id: state.session_id,
        iter: state.iteration,
        trigger: "stop-hook",
        run_summary: result.summary,
      })
      .catch(() => {});
    // Defer disabled (cap 0) → hard-block immediately, like a misconfig ERROR.
    if (cap <= 0) {
      return {
        kind: "block",
        reason: `🔴 Reviewgate · GATE CLOSED — no reviewer could complete a review (iteration ${state.iteration}): ${breakdown}. See .reviewgate/pending.md for per-reviewer status detail.${this.quotaDegradationNote(new Date()) ?? " Run `reviewgate doctor` if this persists."}`,
      };
    }
    // Exhausted the bounded defer → surface to the human (reset the counter so a
    // post-escalation recovery starts fresh).
    if (next > cap) {
      await this.i.state.update((cur) =>
        ReviewgateStateSchema.parse({ ...cur, consecutive_infra_defers: 0 }),
      );
      const fresh = await this.i.state.load();
      return this.escalateAndDecide(
        fresh,
        "infra-unavailable",
        `No reviewer could complete a review for ${cap + 1} consecutive turns (transient infra outage, not a code problem): ${breakdown}.`,
      );
    }
    // Bounded defer: count it, keep the dirty flag, do NOT advance the iteration.
    await this.i.state.update((cur) =>
      ReviewgateStateSchema.parse({
        ...cur,
        consecutive_infra_defers: next,
        // The review DID complete (verdict ERROR, all-infra-failed) → break the
        // consecutive incomplete-run streak (schema contract; see
        // handleAllQuotaLocked). A defer must not bridge two non-consecutive
        // timeouts into a premature review-timeout escalation.
        incomplete_runs: 0,
        last_stop_ts: new Date().toISOString(),
      }),
    );
    return {
      kind: "allow_stop",
      reason: `🟠 Reviewgate · GATE DEFERRED (iteration ${state.iteration}) — no reviewer could complete this turn (${breakdown}); transient infra outage, NOT your code. The change stays flagged and is re-reviewed next turn. Will escalate to the human if this persists (defer ${next}/${cap}).${this.quotaDegradationNote(new Date()) ?? ""}`,
    };
  }

  // Fail CLOSED: count the consecutive incomplete, keep the dirty.flag (so the
  // re-run re-reviews the SAME diff), and block so the turn cannot end
  // un-reviewed. After MAX_CONSECUTIVE_INCOMPLETE_RUNS in a row, escalate to the
  // human — a provider that never finishes must not loop block→re-run forever.
  private async handleIncompleteRun(
    state: ReviewgateState,
    runTimeoutMs: number,
  ): Promise<LoopDecision> {
    const incomplete = state.incomplete_runs + 1;
    await this.i.state.update((cur) =>
      ReviewgateStateSchema.parse({
        ...cur,
        incomplete_runs: incomplete,
        last_stop_ts: new Date().toISOString(),
      }),
    );
    // The aborted run produced no valid verdict. Remove any pending report so the
    // gate's "incomplete — re-run" decision can't contradict a stale/late-written
    // "completed" report left on disk (e.g. the deadline firing during the
    // post-verdict curator/cache work that runs AFTER writeReport).
    for (const p of [pendingMdPath(this.i.repoRoot), pendingJsonPath(this.i.repoRoot)]) {
      try {
        unlinkSync(p);
      } catch {
        /* not present → nothing to clear */
      }
    }
    const dur = formatDuration(runTimeoutMs);
    if (incomplete >= MAX_CONSECUTIVE_INCOMPLETE_RUNS) {
      const fresh = await this.i.state.load();
      return this.escalateAndDecide(
        fresh,
        "review-timeout",
        `The review did not complete within ${dur} for ${incomplete} consecutive runs.`,
      );
    }
    return {
      kind: "block",
      reason: `🔴 Reviewgate · GATE CLOSED — the review did not complete within ${dur} and was aborted (it would otherwise be killed by the Stop-hook timeout, ending your turn UN-reviewed). End your turn again to re-run the review. If it keeps timing out, raise the Stop-hook \`timeout\` in .claude/settings.json AND \`loop.runTimeoutMs\`, or check \`reviewgate doctor\` for a slow/hanging provider.`,
    };
  }

  // Diagnostic: if a CONFIGURED reviewer is currently quota-capped, the panel that
  // produced this escalation was degraded. Returns a note for ESCALATION.md +
  // the Stop reason, or null when no reviewer slot is capped. (Quota only — error/
  // timeout degradation is surfaced on the ERROR path via formatCoverageNote.)
  private quotaDegradationNote(now: Date): string | null {
    const reviewers = this.i.config.phases.review.reviewers ?? [];
    const providers = [...new Set(reviewers.map((r) => r.provider))];
    const store = new QuotaCooldownStore(this.i.repoRoot);
    const capped = providers
      .map((p) => ({ p: p as string, until: store.activeUntil(p, now) }))
      .filter((x): x is { p: string; until: string } => x.until !== null);
    if (capped.length === 0) return null;
    const list = capped.map((x) => `${x.p} (capped until ${x.until})`).join(", ");
    return `\n\n⚠ Quota-degraded panel: ${list} could not review this cycle. A capped reviewer cannot corroborate or refute the others' findings — if its failover did not cover the slot, this escalation rests on a degraded panel. Consider waiting for the quota reset, then re-run \`reviewgate reset\` before treating these findings as final.`;
  }

  // Escalate, then decide whether to BLOCK (to surface it to the agent) or
  // allow the stop. The gate blocks ONCE per escalation so the agent learns it
  // has stopped gating — an allow_stop alone is silent and indistinguishable
  // from "clean". After announcing, it allows; the dirty flag is consumed so the
  // re-stop terminates. Re-arm (commit or PASS) clears escalation_announced.
  private async escalateAndDecide(
    state: ReviewgateState,
    reasonCode: EscalationReason,
    summary: string,
    deferableOnQuota = false,
  ): Promise<LoopDecision> {
    const now = new Date();
    const note = this.quotaDegradationNote(now); // string | null — reused below
    // #10: don't give up (max-iterations / stuck-signatures) while the reviewer
    // panel is degraded by a quota cap / timeout backoff. DEFER (allow_stop, keep
    // the dirty flag, do NOT advance the iteration) for a bounded number of turns,
    // then escalate anyway (fail-closed). Mirrors the infra-defer pattern; the
    // runaway/budget/protocol escalations pass deferableOnQuota=false and skip this.
    const quotaDeferCap = this.i.config.loop.quotaDeferMaxConsecutive;
    if (
      deferableOnQuota &&
      note !== null &&
      quotaDeferCap > 0 &&
      state.consecutive_quota_defers < quotaDeferCap
    ) {
      const next = state.consecutive_quota_defers + 1;
      await this.i.state.update((cur) =>
        ReviewgateStateSchema.parse({
          ...cur,
          consecutive_quota_defers: next,
          last_stop_ts: now.toISOString(),
        }),
      );
      await this.i.audit
        .append({
          event: "gate.decision",
          run_id: state.session_id,
          iter: state.iteration,
          trigger: "stop-hook",
        })
        .catch(() => {});
      // EARLY RETURN — before this.escalate(...) and unlinkDirtyFlagIfUnchanged():
      // the dirty flag is KEPT (next turn re-checks the cooldown), `iteration` is
      // not advanced, and no escalation state (escalated/announced/reason) is set.
      return {
        kind: "allow_stop",
        reason: `🟠 Reviewgate · GATE DEFERRED (iteration ${state.iteration}) — a reviewer is in cooldown, so the panel is incomplete; NOT escalating on a degraded panel yet. Will escalate once the cooldown clears, or after ${quotaDeferCap - next} more degraded turn(s) (defer ${next}/${quotaDeferCap}).${note}`,
      };
    }
    const fullSummary = note ? summary + note : summary;
    const suffix = note ? " · ⚠ degraded panel (quota) — see ESCALATION.md" : "";
    const firstAnnounce = !state.escalation_announced;
    // Only write ESCALATION.md + the audit entry + state on the first announce.
    // Re-stops (with a fresh dirty flag) would otherwise churn the file and spam
    // the audit log without changing the already-escalated state.
    if (firstAnnounce) {
      // N1: the report header shows the EFFECTIVE cap (config min'd with this diff's
      // override), so a small-diff escalation reads "2/2", not "2/3" (codex DoD INFO).
      const effMaxIter =
        state.max_iterations_override != null
          ? Math.min(this.i.config.loop.maxIterations, state.max_iterations_override)
          : this.i.config.loop.maxIterations;
      await this.escalate(
        state.session_id,
        state.iteration,
        effMaxIter,
        reasonCode,
        fullSummary,
        state.signature_history,
        state.iteration_stats,
      );
      await this.i.state.update((cur) => ({
        ...cur,
        escalation_announced: true,
        consecutive_quota_defers: 0,
      }));
    }
    // Compare-and-delete (F-005): a flag rewritten mid-review carries a captured
    // base for the NEW batch; deleting it would make a later trigger re-capture
    // base as the CURRENT HEAD, silently dropping unreviewed mid-batch commits.
    this.unlinkDirtyFlagIfUnchanged();
    // Some escalations mean "the REVIEWER is the problem, not the agent's code"
    // (reviewer-fp-streak: the agent kept correctly rejecting a noisy reviewer's
    // findings). Blocking there punishes correct behavior and holds the dev
    // hostage. For those we still write ESCALATION.md + audit (the human IS
    // informed) but ALLOW the stop with a loud warning instead of blocking.
    if (firstAnnounce && !ALLOW_STOP_ESCALATIONS.has(reasonCode)) {
      return {
        kind: "block",
        reason: `🟠 Reviewgate · GATE ESCALATED (${reasonCode}) — the gate gave up after repeated rounds without a clean pass and is no longer reviewing your changes. Read .reviewgate/ESCALATION.md, surface it to the human, and run \`reviewgate reset\` (or restart the session) to re-arm. End your turn again to proceed.${suffix}`,
      };
    }
    if (firstAnnounce) {
      // Reason-aware copy: infra-unavailable is a transient PROVIDER OUTAGE (all
      // reviewers down for N turns), NOT an unreliable reviewer — telling the dev to
      // "disable/replace that reviewer" would be wrong. reviewer-fp-streak IS about a
      // reviewer that kept being wrong.
      return {
        kind: "allow_stop",
        reason:
          reasonCode === "infra-unavailable"
            ? `🟠 Reviewgate · GATE ESCALATED (${reasonCode}) — no reviewer could complete a review for several consecutive turns (transient provider outage, NOT your code); NOT blocking your turn. This change went UN-reviewed and the gate is now un-armed. Read .reviewgate/ESCALATION.md; once a provider recovers, re-review it by running \`reviewgate reset\` (any further edit/commit also re-arms the gate).${suffix}`
            : `🟠 Reviewgate · GATE ESCALATED (${reasonCode}) — the reviewer panel is being treated as UNRELIABLE here, not your code; NOT blocking your turn. Read .reviewgate/ESCALATION.md and consider disabling/replacing that reviewer in reviewgate.config.ts.${suffix}`,
      };
    }
    return {
      kind: "allow_stop",
      reason: `🟠 Reviewgate · GATE ESCALATED (${reasonCode}) — not gating. See .reviewgate/ESCALATION.md.${suffix}`,
    };
  }

  private async escalate(
    runId: string,
    iter: number,
    maxIterEff: number,
    reasonCode: EscalationReason,
    summary: string,
    history: string[][],
    stats: ReviewgateState["iteration_stats"],
  ): Promise<void> {
    const w = new ReportWriter(this.i.repoRoot);
    const pending = readPendingReport(this.i.repoRoot);
    // N4: annotate each pending finding with its CURRENT disposition from this
    // iteration's decisions, so the report reflects the post-decision state rather
    // than the pre-decision opening snapshot. Absent decision → still "open".
    const decisions = lastDecisionsById(this.i.repoRoot, iter);
    const findingStatus: Record<
      string,
      { state: "addressed" | "rejected" | "open"; reason?: string }
    > = {};
    for (const f of pending.findings) {
      const d = decisions.get(f.id);
      if (!d) findingStatus[f.id] = { state: "open" };
      else if (d.verdict === "accepted") findingStatus[f.id] = { state: "addressed" };
      else findingStatus[f.id] = { state: "rejected", reason: d.reason };
    }
    await w.writeEscalation({
      runId,
      iter,
      maxIter: maxIterEff,
      reasonCode,
      summary,
      // Per-iteration history: finding COUNT from signature_history, severity split
      // + verdict + cost from the length-aligned iteration_stats (persisted per
      // iteration). The LAST row can always be backfilled from the live pending.json.
      // For EARLIER rows missing stats (e.g. state.json written before iteration_stats
      // existed, so it loaded as []), we have no severity split: render the verdict as
      // "n/a" rather than fabricating a "FAIL · 0 CRIT · 0 WARN" row — a 0/0 FAIL beside
      // a non-zero finding count reads as "there were never any findings", contradicting
      // the Final-findings section and eroding trust in the report. The Findings column
      // still shows the real signature count so the row isn't silently emptied.
      perIter: history.map((sigs, i) => {
        const s = stats[i];
        const isLast = i === history.length - 1;
        const verdict = s?.verdict ?? (isLast ? "FAIL" : "n/a");
        return {
          iter: i + 1,
          verdict,
          crit: s?.critical ?? (isLast ? pending.counts.critical : 0),
          warn: s?.warn ?? (isLast ? pending.counts.warn : 0),
          costUsd: s?.cost_usd ?? 0,
          findings: sigs.length,
        };
      }),
      topFindings: pending.findings,
      findingStatus,
      triggeredAt: new Date().toISOString(),
    });
    await this.i.audit.append({ event: "escalation", run_id: runId, iter, trigger: "stop-hook" });
    await this.i.state.update((cur) => ({
      ...cur,
      escalated: true,
      escalation_reason: reasonCode,
    }));
  }
}
