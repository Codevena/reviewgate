// src/core/loop-driver.ts
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { AuditLogger } from "../audit/logger.ts";
import type { ReviewgateConfig } from "../config/define-config.ts";
import { DecisionEntrySchema } from "../schemas/decision.ts";
import { type ReviewgateState, ReviewgateStateSchema } from "../schemas/state.ts";
import { decisionsPath, dirtyFlagPath, pendingJsonPath } from "../utils/paths.ts";
import type { Orchestrator } from "./orchestrator.ts";
import { ReportWriter } from "./report-writer.ts";
import type { StateStore } from "./state-store.ts";

export interface LoopInput {
  repoRoot: string;
  config: ReviewgateConfig;
  state: StateStore;
  audit: AuditLogger;
  orchestrator: Orchestrator;
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
    const report = JSON.parse(readFileSync(p, "utf8")) as { findings?: Array<{ id?: string }> };
    if (!Array.isArray(report.findings)) return [];
    return report.findings.map((f) => f.id).filter((id): id is string => typeof id === "string");
  } catch {
    return [];
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
                escalated: false,
                escalation_reason: null,
                escalation_announced: false,
              }
            : {}),
          last_reviewed_head_sha: headSha,
        }),
      );
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

    // Escalation precondition: iter cap reached before this iteration.
    if (state.iteration >= this.i.config.loop.maxIterations) {
      return this.escalateAndDecide(
        state,
        "max-iterations",
        `Reached ${state.iteration} iterations without convergence.`,
      );
    }

    // Stuck-loop: same signatures two iters in a row.
    const lastIdx = state.signature_history.length - 1;
    const last = state.signature_history[lastIdx];
    const prev = state.signature_history[lastIdx - 1];
    if (last && prev && last.join(",") === prev.join(",")) {
      return this.escalateAndDecide(
        state,
        "stuck-signatures",
        "Findings unchanged across 2 iterations.",
      );
    }

    // If a prior iter exists and decisions are required, check they exist.
    if (state.iteration > 0) {
      const requiredIds = previousFindingIds(this.i.repoRoot);
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
    }

    // Run a new iteration.
    const nextIter = state.iteration + 1;
    const result = await this.i.orchestrator.runIteration({
      runId: state.session_id,
      iter: nextIter,
    });

    // A clean PASS means this change-set converged → re-arm the budget so the
    // next batch starts fresh (and any prior escalation is cleared). A FAIL/ERROR
    // advances the counter toward the iter-cap escalation. Either way, record the
    // HEAD sha so a later commit can be detected and re-armed on.
    const passed = result.verdict === "PASS" || result.verdict === "SOFT-PASS";
    await this.i.state.update((cur) =>
      ReviewgateStateSchema.parse({
        ...cur,
        iteration: passed ? 0 : nextIter,
        cost_usd_so_far: passed ? 0 : cur.cost_usd_so_far + result.costUsd,
        signature_history: passed ? [] : [...cur.signature_history, result.signaturesThisIter],
        escalated: passed ? false : cur.escalated,
        escalation_reason: passed ? null : cur.escalation_reason,
        escalation_announced: passed ? false : cur.escalation_announced,
        last_reviewed_head_sha: headSha ?? cur.last_reviewed_head_sha,
        last_stop_ts: new Date().toISOString(),
      }),
    );

    if (result.verdict === "PASS" || result.verdict === "SOFT-PASS") {
      try {
        unlinkSync(dirtyFlagPath(this.i.repoRoot));
      } catch {
        /* noop */
      }
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
      if (this.i.config.loop.acknowledgePass) {
        return {
          kind: "block",
          reason: `🟢 Reviewgate · GATE OPEN — ✅ ${result.verdict} (iteration ${nextIter}). Review is clean, no findings to address. No action needed: simply end your turn again to pass through (you may briefly confirm the pass to the user first).`,
        };
      }
      return {
        kind: "allow_stop",
        reason: `🟢 Reviewgate · GATE OPEN — ${result.verdict} (iteration ${nextIter}). Clear to finish.`,
      };
    }

    // The reviewer could not run (error/timeout/quota, or sandbox unavailable).
    // Block — Reviewgate must never pass a turn it could not actually review —
    // but with a reason that points at the reviewer, not at fixing findings.
    // Repeated errors increment the iteration and eventually hit the iter-cap
    // escalation, so this cannot loop forever.
    if (result.verdict === "ERROR") {
      return {
        kind: "block",
        reason: `🔴 Reviewgate · GATE CLOSED — reviewer error (iteration ${nextIter}). The review could not complete. Run \`reviewgate doctor\` to diagnose, fix the reviewer, then continue. Reviewgate will not open the gate on a turn it could not review.`,
      };
    }

    return {
      kind: "block",
      reason: `🔴 Reviewgate · GATE CLOSED — iteration ${nextIter}/${this.i.config.loop.maxIterations} · ${result.signaturesThisIter.length} finding(s). See .reviewgate/pending.md · record per-finding decisions in .reviewgate/decisions/${nextIter}.jsonl.`,
    };
  }

  // Escalate, then decide whether to BLOCK (to surface it to the agent) or
  // allow the stop. The gate blocks ONCE per escalation so the agent learns it
  // has stopped gating — an allow_stop alone is silent and indistinguishable
  // from "clean". After announcing, it allows; the dirty flag is consumed so the
  // re-stop terminates. Re-arm (commit or PASS) clears escalation_announced.
  private async escalateAndDecide(
    state: ReviewgateState,
    reasonCode:
      | "max-iterations"
      | "cost-cap"
      | "stuck-signatures"
      | "reject-rate-high"
      | "decisions-unaddressed",
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
    reasonCode:
      | "max-iterations"
      | "cost-cap"
      | "stuck-signatures"
      | "reject-rate-high"
      | "decisions-unaddressed",
    summary: string,
    history: string[][],
  ): Promise<void> {
    const w = new ReportWriter(this.i.repoRoot);
    await w.writeEscalation({
      runId,
      iter,
      maxIter: this.i.config.loop.maxIterations,
      reasonCode,
      summary,
      perIter: history.map((sigs, i) => ({
        iter: i + 1,
        verdict: "FAIL",
        crit: 0,
        warn: 0,
        costUsd: 0,
        findings: sigs.length,
      })),
      topFindings: [],
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
