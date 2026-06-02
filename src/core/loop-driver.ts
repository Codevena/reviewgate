// src/core/loop-driver.ts
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import type { AuditLogger } from "../audit/logger.ts";
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
import { ProposalStore } from "./brain/proposal-store.ts";
import { learnFromDecisions } from "./fp-ledger/learn.ts";
import { computeRejectRate } from "./fp-ledger/reject-rate.ts";
import { FpLedgerStore } from "./fp-ledger/store.ts";
import type { IterationResult, IterationRunner } from "./orchestrator.ts";
import { QuotaCooldownStore } from "./quota-cooldown.ts";
import { ReportWriter } from "./report-writer.ts";
import { learnReputationFromDecisions } from "./reputation/learn.ts";
import { ReputationStore } from "./reputation/store.ts";
import type { StateStore } from "./state-store.ts";

// Minimum decisions this cycle before the reject-rate circuit-breaker can fire,
// so a single (or couple of) reviewer_was_wrong rejection never escalates.
const MIN_DECISIONS_FOR_REJECT_RATE = 4;

// Consecutive incomplete (timed-out) runs before escalating to the human, so a
// permanently-hanging provider can't loop the block→re-run forever.
const MAX_CONSECUTIVE_INCOMPLETE_RUNS = 2;

// Escalation reasons where the REVIEWER (or a transient provider outage) is the
// problem, not the agent's code. Blocking there punishes correct agent behavior
// (e.g. consistently rejecting a noisy reviewer's findings) and holds the dev
// hostage. For these the gate still writes ESCALATION.md + audit (the human is
// informed) but ALLOWS the stop with a loud warning instead of blocking.
const ALLOW_STOP_ESCALATIONS: ReadonlySet<EscalationReason> = new Set<EscalationReason>([
  "reviewer-fp-streak",
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
  const lastById = new Map<string, DecisionEntry>();
  for (const line of readFileSync(dp, "utf8").split("\n")) {
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

interface DecisionsGate {
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
function evaluateDecisions(repoRoot: string, iter: number, requiredIds: string[]): DecisionsGate {
  const p = decisionsPath(repoRoot, iter);
  const seen = new Set<string>();
  const invalid: string[] = [];
  // Finding ids that appeared on a present-but-invalid line. Tracked explicitly
  // (NOT parsed back out of the human-readable `invalid` strings) so a future
  // wording change to a reason can never silently mis-attribute an id.
  const invalidIds = new Set<string>();
  if (existsSync(p)) {
    const lines = readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0);
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
          iteration_stats: [],
          fp_rejects_history: [],
          escalated: false,
          escalation_reason: null,
          escalation_announced: false,
          incomplete_runs: 0,
          cumulative_fp_rejects: 0,
          fp_counted_through_iter: 0,
          cycle_rejected_signatures: [],
          claimed_fixed_signatures: {},
          reputation_cycle_seq: cur.reputation_cycle_seq + 1,
        }),
      );
      clearDecisions(this.i.repoRoot);
      new ProposalStore(this.i.repoRoot, state.session_id).clear();
      state = await this.i.state.load();
    }

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
    const maxIter = this.i.config.loop.maxIterations;
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
      // Converging = REAL (non-FP) findings strictly fewer than the prior reviewed
      // round, OR no real findings remain (only reviewer FPs left — the fp-streak
      // breaker's job, IF enabled). Total count is NOT used: the panel can add fresh
      // FPs faster than real findings are fixed, masking real progress.
      const progressing = m >= 2 && (lastReal < prevReal || (lastReal === 0 && fpStreakOn));
      const hardCap = maxIter * 2;
      if (state.iteration >= hardCap) {
        return this.escalateAndDecide(
          state,
          "max-iterations",
          `Reached the hard cap of ${hardCap} iterations.`,
        );
      }
      if (!progressing) {
        return this.escalateAndDecide(
          state,
          "max-iterations",
          `Reached ${state.iteration} iterations without convergence (real findings not decreasing).`,
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
      );
    }

    // If a prior iter exists, both the decisions-gate and the reject-rate
    // circuit-breaker need the prior iteration's blocking finding ids — read
    // pending.json ONCE and share it.
    if (state.iteration > 0) {
      const requiredIds = previousFindingIds(this.i.repoRoot);

      // Fold decisions INTO the learn loops FIRST — before ANY early-return in
      // this block (the decisions-unaddressed escalation below AND the
      // reviewer-fp-streak escalation further down). If the agent rejected SOME
      // findings with reviewer_was_wrong before leaving others unaddressed, that
      // valid FP/reputation signal must be consumed even when we then escalate.
      // absorbPriorDecisions is idempotent (FP-ledger keys run_id on the iter;
      // reputation on its eid), so a single hoisted call is safe.
      await this.absorbPriorDecisions(state);

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

      // (absorbPriorDecisions was hoisted to the TOP of this block so it runs
      // before the decisions-unaddressed early-return too — see above.)

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
        const settledRun = await runP.then(
          (r) => ({ ok: true as const, r }),
          () => null,
        );
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
        fp_rejects_history: passed ? [] : cur.fp_rejects_history,
        // Per-cycle suppression set (2b): cleared on re-arm so a fresh cycle
        // starts with no suppressed signatures; preserved across a cycle's FAILs.
        cycle_rejected_signatures: passed ? [] : cur.cycle_rejected_signatures,
        // §4.3: claimed-fixed map is cycle-scoped — cleared on re-arm, preserved across a cycle's FAILs.
        claimed_fixed_signatures: passed ? {} : cur.claimed_fixed_signatures,
        // The review actually completed (any verdict) → the incomplete-run
        // streak is broken; reset so a later timeout starts counting fresh.
        incomplete_runs: 0,
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
      try {
        unlinkSync(dirtyFlagPath(this.i.repoRoot));
      } catch {
        /* noop */
      }
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
      const isSoft = result.verdict === "SOFT-PASS";
      const warnCount = result.summary.counts.warn;
      decision =
        this.i.config.loop.acknowledgePass || forceSoftAck
          ? {
              kind: "block",
              reason: forceSoftAck
                ? `🟡 Reviewgate · GATE OPEN — ⚠️ SOFT-PASS (iteration ${nextIter}): ${formatPanelSummary(result.summary)}${coverageSuffix}. These are non-blocking warnings — review them in .reviewgate/pending.md, then end your turn again to accept and pass through.`
                : coverage
                  ? `🟢 Reviewgate · GATE OPEN — ✅ ${result.verdict} (iteration ${nextIter}) · ⚠ ${coverage}. Verdict is based on the reviewer(s) that did complete; treat as advisory if full coverage matters for this slice. End your turn again to pass through.`
                  : `🟢 Reviewgate · GATE OPEN — ✅ ${result.verdict} (iteration ${nextIter}). Review is clean, no findings to address. No action needed: simply end your turn again to pass through (you may briefly confirm the pass to the user first).`,
            }
          : {
              kind: "allow_stop",
              reason: isSoft
                ? `🟡 Reviewgate · GATE OPEN — SOFT-PASS (iteration ${nextIter}): ${warnCount} WARN${coverageSuffix}. Non-blocking — see .reviewgate/pending.md.`
                : `🟢 Reviewgate · GATE OPEN — ${result.verdict} (iteration ${nextIter})${coverageSuffix}. Clear to finish.`,
            };
    } else if (result.verdict === "ERROR") {
      // The reviewer could not run (error/timeout/quota, or sandbox unavailable).
      // Block — Reviewgate must never pass a turn it could not actually review —
      // but with a reason that points at the reviewer, not at fixing findings.
      // Repeated errors increment the iteration and eventually hit the iter-cap
      // escalation, so this cannot loop forever.
      decision = {
        kind: "block",
        reason: `🔴 Reviewgate · GATE CLOSED — reviewer error (iteration ${nextIter}): ${formatErrorBreakdown(result.summary)}. See .reviewgate/pending.md for per-reviewer status detail. Run \`reviewgate doctor\` if this persists.`,
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
      ReviewgateStateSchema.parse({ ...cur, last_stop_ts: new Date().toISOString() }),
    );
    const note = this.quotaDegradationNote(new Date()) ?? "";
    return {
      kind: "allow_stop",
      reason: `🟠 Reviewgate · GATE DEFERRED (iteration ${state.iteration}) — every reviewer is quota-capped right now, so this turn could not be reviewed. NOT blocking (transient outage, not your code); the change stays flagged and is re-reviewed automatically on your next turn once quota resets.${note}`,
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
    return `\n\n⚠ Quota-degraded panel: ${list} could not review this cycle. A capped reviewer cannot corroborate or refute the others' findings — if its failover did not cover the slot, this escalation rests on a degraded panel. Consider waiting for the quota reset, then re-run \`reviewgate gate --hook reset\` before treating these findings as final.`;
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
  ): Promise<LoopDecision> {
    const degraded = this.quotaDegradationNote(new Date());
    const fullSummary = degraded ? summary + degraded : summary;
    const suffix = degraded ? " · ⚠ degraded panel (quota) — see ESCALATION.md" : "";
    const firstAnnounce = !state.escalation_announced;
    // Only write ESCALATION.md + the audit entry + state on the first announce.
    // Re-stops (with a fresh dirty flag) would otherwise churn the file and spam
    // the audit log without changing the already-escalated state.
    if (firstAnnounce) {
      await this.escalate(
        state.session_id,
        state.iteration,
        reasonCode,
        fullSummary,
        state.signature_history,
        state.iteration_stats,
      );
      await this.i.state.update((cur) => ({ ...cur, escalation_announced: true }));
    }
    try {
      unlinkSync(dirtyFlagPath(this.i.repoRoot));
    } catch {
      /* noop */
    }
    // Some escalations mean "the REVIEWER is the problem, not the agent's code"
    // (reviewer-fp-streak: the agent kept correctly rejecting a noisy reviewer's
    // findings). Blocking there punishes correct behavior and holds the dev
    // hostage. For those we still write ESCALATION.md + audit (the human IS
    // informed) but ALLOW the stop with a loud warning instead of blocking.
    if (firstAnnounce && !ALLOW_STOP_ESCALATIONS.has(reasonCode)) {
      return {
        kind: "block",
        reason: `🟠 Reviewgate · GATE ESCALATED (${reasonCode}) — the gate gave up after repeated rounds without a clean pass and is no longer reviewing your changes. Read .reviewgate/ESCALATION.md, surface it to the human, and run \`reviewgate gate --hook reset\` (or restart the session) to re-arm. End your turn again to proceed.${suffix}`,
      };
    }
    if (firstAnnounce) {
      return {
        kind: "allow_stop",
        reason: `🟠 Reviewgate · GATE ESCALATED (${reasonCode}) — the reviewer panel is being treated as UNRELIABLE here, not your code; NOT blocking your turn. Read .reviewgate/ESCALATION.md and consider disabling/replacing that reviewer in reviewgate.config.ts.${suffix}`,
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
    reasonCode: EscalationReason,
    summary: string,
    history: string[][],
    stats: ReviewgateState["iteration_stats"],
  ): Promise<void> {
    const w = new ReportWriter(this.i.repoRoot);
    const pending = readPendingReport(this.i.repoRoot);
    await w.writeEscalation({
      runId,
      iter,
      maxIter: this.i.config.loop.maxIterations,
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
