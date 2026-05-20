// src/core/loop-driver.ts
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { AuditLogger } from "../audit/logger.ts";
import type { ReviewgateConfig } from "../config/define-config.ts";
import { ReviewgateStateSchema } from "../schemas/state.ts";
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
    try {
      const obj = JSON.parse(l) as { finding_id?: string };
      if (obj.finding_id) seen.add(obj.finding_id);
    } catch {
      // ignore parse failures; treated as missing decisions
    }
  }
  return requiredIds.every((id) => seen.has(id));
}

export class LoopDriver {
  constructor(private readonly i: LoopInput) {}

  async run(): Promise<LoopDecision> {
    if (this.i.stopHookActive) {
      await this.i.audit.append({
        event: "gate.decision",
        run_id: "pending",
        iter: 0,
        trigger: "stop-hook",
      });
      return {
        kind: "allow_stop",
        reason: "stop_hook_active=true; allowing the parent loop to terminate.",
      };
    }

    const flag = readDirtyFlag(this.i.repoRoot);
    const state = await this.i.state.load();

    // No dirty.flag since last PASS → nothing to review.
    if (!flag) {
      return { kind: "allow_stop", reason: "No code changes detected since last review." };
    }

    // Escalation precondition: cost cap reached (apikey/openrouter mode only;
    // OAuth mode cost is 0 so this never fires there).
    if (
      this.i.config.loop.costCapUsd > 0 &&
      state.cost_usd_so_far >= this.i.config.loop.costCapUsd
    ) {
      await this.escalate(
        state.session_id,
        state.iteration,
        "cost-cap",
        `Cost $${state.cost_usd_so_far.toFixed(2)} reached the cap of $${this.i.config.loop.costCapUsd.toFixed(2)}.`,
        state.signature_history,
      );
      try {
        unlinkSync(dirtyFlagPath(this.i.repoRoot));
      } catch {
        /* noop */
      }
      return {
        kind: "allow_stop",
        reason: "Reviewgate escalated: cost cap reached. See .reviewgate/ESCALATION.md.",
      };
    }

    // Escalation precondition: iter cap reached before this iteration.
    if (state.iteration >= this.i.config.loop.maxIterations) {
      await this.escalate(
        state.session_id,
        state.iteration,
        "max-iterations",
        `Reached ${state.iteration} iterations without convergence.`,
        state.signature_history,
      );
      try {
        unlinkSync(dirtyFlagPath(this.i.repoRoot));
      } catch {
        /* noop */
      }
      return {
        kind: "allow_stop",
        reason: `Reviewgate escalated after ${state.iteration} iterations. See .reviewgate/ESCALATION.md.`,
      };
    }

    // Stuck-loop: same signatures two iters in a row.
    const lastIdx = state.signature_history.length - 1;
    const last = state.signature_history[lastIdx];
    const prev = state.signature_history[lastIdx - 1];
    if (last && prev && last.join(",") === prev.join(",")) {
      await this.escalate(
        state.session_id,
        state.iteration,
        "stuck-signatures",
        "Findings unchanged across 2 iterations.",
        state.signature_history,
      );
      try {
        unlinkSync(dirtyFlagPath(this.i.repoRoot));
      } catch {
        /* noop */
      }
      return {
        kind: "allow_stop",
        reason:
          "Reviewgate escalated: no progress across 2 iterations. See .reviewgate/ESCALATION.md.",
      };
    }

    // If a prior iter exists and decisions are required, check they exist.
    if (state.iteration > 0) {
      const requiredIds = previousFindingIds(this.i.repoRoot);
      if (
        requiredIds.length > 0 &&
        !allDecisionsAddressed(this.i.repoRoot, state.iteration, requiredIds)
      ) {
        return {
          kind: "block",
          reason: `Iteration ${state.iteration} findings are not yet addressed in .reviewgate/decisions/${state.iteration}.jsonl. For each finding ID, append a line with verdict=accepted (action:"fixed") OR verdict=rejected (reason:"...", reviewer_was_wrong:true).`,
        };
      }
    }

    // Run a new iteration.
    const nextIter = state.iteration + 1;
    const result = await this.i.orchestrator.runIteration({
      runId: state.session_id,
      iter: nextIter,
    });

    await this.i.state.update((cur) =>
      ReviewgateStateSchema.parse({
        ...cur,
        iteration: nextIter,
        cost_usd_so_far: cur.cost_usd_so_far + result.costUsd,
        signature_history: [...cur.signature_history, result.signaturesThisIter],
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
      // flag is already deleted, so the agent's re-stop sees no work + stop_hook_active
      // → allow_stop. No loop. Default off (silent pass) to keep the happy path lean.
      if (this.i.config.loop.acknowledgePass) {
        return {
          kind: "block",
          reason: `✅ Reviewgate ${result.verdict} on iteration ${nextIter} — the review is complete and clean, no findings to address. No action needed: simply end your turn again to finish (you may briefly confirm the pass to the user first).`,
        };
      }
      return {
        kind: "allow_stop",
        reason: `Reviewgate ${result.verdict} on iteration ${nextIter}.`,
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
        reason: `Reviewgate could not complete a review on iteration ${nextIter} (reviewer did not run successfully). Run \`reviewgate doctor\` to diagnose, fix the reviewer, then continue. Reviewgate will not pass a turn it could not review.`,
      };
    }

    return {
      kind: "block",
      reason: `Reviewgate FAIL — iteration ${nextIter} of ${this.i.config.loop.maxIterations}. See .reviewgate/pending.md. Append per-finding decisions to .reviewgate/decisions/${nextIter}.jsonl.`,
    };
  }

  private async escalate(
    runId: string,
    iter: number,
    reasonCode: "max-iterations" | "cost-cap" | "stuck-signatures" | "reject-rate-high",
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
