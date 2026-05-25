// src/core/loop-driver.ts
import { existsSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import type { AuditLogger } from "../audit/logger.ts";
import type { ReviewgateConfig } from "../config/define-config.ts";
import type { RunSummary } from "../schemas/audit-event.ts";
import { DecisionEntrySchema } from "../schemas/decision.ts";
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
import { computeRejectRate } from "./fp-ledger/reject-rate.ts";
import type { IterationResult, IterationRunner } from "./orchestrator.ts";
import { ReportWriter } from "./report-writer.ts";
import type { StateStore } from "./state-store.ts";

// Minimum decisions this cycle before the reject-rate circuit-breaker can fire,
// so a single (or couple of) reviewer_was_wrong rejection never escalates.
const MIN_DECISIONS_FOR_REJECT_RATE = 4;

// Consecutive incomplete (timed-out) runs before escalating to the human, so a
// permanently-hanging provider can't loop the block→re-run forever.
const MAX_CONSECUTIVE_INCOMPLETE_RUNS = 2;

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

function allDecisionsAddressed(repoRoot: string, iter: number, requiredIds: string[]): boolean {
  const p = decisionsPath(repoRoot, iter);
  if (!existsSync(p)) return false;
  const lines = readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
  const seen = new Set<string>();
  for (const l of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(l);
    } catch {
      continue; // not JSON → treated as missing decision (fail-closed)
    }
    // Only a fully valid DecisionEntry counts. A bare {finding_id} stub or a
    // rejection with a too-short reason must NOT satisfy the gate — otherwise
    // the gate is trivially bypassable with malformed lines.
    const res = DecisionEntrySchema.safeParse(parsed);
    if (res.success) seen.add(res.data.finding_id);
  }
  return requiredIds.every((id) => seen.has(id));
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
              }
            : {}),
          last_reviewed_head_sha: headSha,
        }),
      );
      // The commit closed the escalated cycle → wipe its decisions too, so a
      // stale finding_id can't satisfy the next cycle's gate (see clearDecisions).
      if (headMovedWhileEscalated) clearDecisions(this.i.repoRoot);
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
    // where each round's finding count is strictly DECREASING (healthy spec/code
    // refinement, e.g. 5 → 3 → 1 → 0) — is genuinely making progress, not stuck, so
    // it is allowed to continue past maxIterations up to a hard backstop (2× the
    // cap). Only a NON-progressing loop (findings flat or rising) escalates at the
    // cap — which is what "without convergence" actually means. The hard backstop +
    // cost-cap + stuck-signature detection remain as upper bounds so this can never
    // run away. (Finding counts come from signature_history, one entry per iteration.)
    const maxIter = this.i.config.loop.maxIterations;
    if (state.iteration >= maxIter) {
      const hist = state.signature_history;
      const lastN = hist.at(-1)?.length ?? 0;
      const prevN = hist.at(-2)?.length ?? Number.POSITIVE_INFINITY;
      // Genuine convergence = the finding count is dropping AND no confirmed reviewer
      // false positives have accumulated this cycle. A single down-tick can otherwise
      // be noise: a reviewer re-adding a (differently-phrased) FP each round makes the
      // count fluctuate (e.g. 4→4→3→4), and the lone `lastN < prevN` tick would read
      // as "progress" and extend the loop to the hard cap. If FPs are accumulating the
      // loop is FP-driven, not converging — deny the grace and escalate at the cap.
      const progressing = hist.length >= 2 && lastN < prevN && state.cumulative_fp_rejects === 0;
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
          `Reached ${state.iteration} iterations without convergence (findings not decreasing).`,
        );
      }
      // Converging (findings strictly fewer than the previous round) and below the
      // hard cap → fall through and review another round toward a clean pass.
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

      // Decisions-gate: every required finding must have a decision.
      if (
        requiredIds.length > 0 &&
        !allDecisionsAddressed(this.i.repoRoot, state.iteration, requiredIds)
      ) {
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
            `Findings from iteration ${state.iteration} were never addressed in .reviewgate/decisions/${state.iteration}.jsonl after a forced re-prompt.`,
          );
        }
        return {
          kind: "block",
          reason: `🔴 Reviewgate · GATE CLOSED — iteration ${state.iteration} · findings not yet addressed in .reviewgate/decisions/${state.iteration}.jsonl. For each finding ID, append a line with verdict=accepted (action:"fixed") OR verdict=rejected (reason:"...", reviewer_was_wrong:true).`,
        };
      }

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
      if (fpThreshold > 0 && state.iteration > state.fp_counted_through_iter) {
        const cumulativeFp = state.cumulative_fp_rejects + rr.wrongRejects;
        await this.i.state.update((cur) =>
          ReviewgateStateSchema.parse({
            ...cur,
            cumulative_fp_rejects: cur.cumulative_fp_rejects + rr.wrongRejects,
            fp_counted_through_iter: Math.max(cur.fp_counted_through_iter, state.iteration),
          }),
        );
        state = await this.i.state.load();
        if (cumulativeFp >= fpThreshold) {
          return this.escalateAndDecide(
            state,
            "reviewer-fp-streak",
            `${cumulativeFp} confirmed reviewer false positives accumulated across ${state.iteration} iterations (threshold ${fpThreshold}) — a reviewer appears to be producing persistent false positives. See .reviewgate/pending.md for the rejected findings and their provider; consider disabling or replacing that reviewer in reviewgate.config.ts.`,
          );
        }
      }
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
        // The review actually completed (any verdict) → the incomplete-run
        // streak is broken; reset so a later timeout starts counting fresh.
        incomplete_runs: 0,
        last_reviewed_head_sha: headSha ?? cur.last_reviewed_head_sha,
        last_stop_ts: new Date().toISOString(),
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
      // satisfy the next cycle's gate (see clearDecisions).
      clearDecisions(this.i.repoRoot);
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
      decision =
        this.i.config.loop.acknowledgePass || forceSoftAck
          ? {
              kind: "block",
              reason: forceSoftAck
                ? `🟡 Reviewgate · GATE OPEN — ⚠️ SOFT-PASS (iteration ${nextIter}): ${formatPanelSummary(result.summary)}. These are non-blocking warnings — review them in .reviewgate/pending.md, then end your turn again to accept and pass through.`
                : `🟢 Reviewgate · GATE OPEN — ✅ ${result.verdict} (iteration ${nextIter}). Review is clean, no findings to address. No action needed: simply end your turn again to pass through (you may briefly confirm the pass to the user first).`,
            }
          : {
              kind: "allow_stop",
              reason: `🟢 Reviewgate · GATE OPEN — ${result.verdict} (iteration ${nextIter}). Clear to finish.`,
            };
    } else if (result.verdict === "ERROR") {
      // The reviewer could not run (error/timeout/quota, or sandbox unavailable).
      // Block — Reviewgate must never pass a turn it could not actually review —
      // but with a reason that points at the reviewer, not at fixing findings.
      // Repeated errors increment the iteration and eventually hit the iter-cap
      // escalation, so this cannot loop forever.
      decision = {
        kind: "block",
        reason: `🔴 Reviewgate · GATE CLOSED — reviewer error (iteration ${nextIter}). The review could not complete. Run \`reviewgate doctor\` to diagnose, fix the reviewer, then continue. Reviewgate will not open the gate on a turn it could not review.`,
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
    const firstAnnounce = !state.escalation_announced;
    // Only write ESCALATION.md + the audit entry + state on the first announce.
    // Re-stops (with a fresh dirty flag) would otherwise churn the file and spam
    // the audit log without changing the already-escalated state.
    if (firstAnnounce) {
      await this.escalate(
        state.session_id,
        state.iteration,
        reasonCode,
        summary,
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
    if (firstAnnounce) {
      return {
        kind: "block",
        reason: `🟠 Reviewgate · GATE ESCALATED (${reasonCode}) — the gate gave up after repeated rounds without a clean pass and is no longer reviewing your changes. Read .reviewgate/ESCALATION.md, surface it to the human, and run \`reviewgate gate --hook reset\` (or restart the session) to re-arm. End your turn again to proceed.`,
      };
    }
    return {
      kind: "allow_stop",
      reason: `🟠 Reviewgate · GATE ESCALATED (${reasonCode}) — not gating. See .reviewgate/ESCALATION.md.`,
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
      // iteration). Falls back to the last iter's pending.json counts / FAIL / 0 for
      // any row missing stats (e.g. state.json written before iteration_stats existed).
      perIter: history.map((sigs, i) => {
        const s = stats[i];
        const isLast = i === history.length - 1;
        return {
          iter: i + 1,
          verdict: s?.verdict ?? "FAIL",
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
