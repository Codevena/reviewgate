// src/core/brain/proposal-store.ts
//
// Per-run pool of memory_proposals accumulated across iterations of a single
// review cycle. Lets the Curator see cross-iteration provider diversity when the
// reviewer panel is single-primary-with-failover: iter 1 may carry claude-code's
// proposals, iter 2 (after a primary timeout) carries opencode's; with the pool
// the curator sees BOTH in the same invocation and can reach the 2-distinct-
// providers quorum that one-iteration-at-a-time always misses.
//
// Lifecycle:
//   - Append per iteration (Orchestrator, post-panel, pre-curator).
//   - Curator reads the full pool, NOT just this iteration's batch.
//   - File is cleared on PASS, commit-recovery from escalation, or session reset.
// Best-effort: append/read errors do NOT throw — they get logged to
// `proposals/pool/errors.jsonl` and the in-memory iter batch is used as a
// fallback so a corrupt pool can never block the gate.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { type MemoryProposal, MemoryProposalSchema } from "../../schemas/brain.ts";
import { proposalsPoolDir, proposalsPoolErrorLog, proposalsPoolPath } from "../../utils/paths.ts";

export const StoredProposalSchema = z.object({
  iter: z.number().int().nonnegative(),
  appended_at: z.string(),
  // sha256(title + "\n" + body + "\n" + first-reviewer_id) — used for
  // append-time dedup so re-running the same iter or replaying a cassette
  // doesn't double-count an identical proposal.
  signature: z.string(),
  proposal: MemoryProposalSchema,
});
export type StoredProposal = z.infer<typeof StoredProposalSchema>;

/** Stable signature for dedup. Includes the first reviewer's id so the same
 *  proposal emitted by DIFFERENT providers still aggregates (different sig),
 *  which is the whole point — cross-provider proposals must NOT dedup.
 *
 *  Assumption: every evidence item in `p` carries the SAME `reviewer_id`,
 *  guaranteed by `buildProposalEvidence` in the orchestrator which stamps the
 *  emitting adapter's id onto every item (anti-collusion). If a future change
 *  ever allows multi-provider evidence in one proposal, this signature would
 *  silently collapse cross-provider proposals — update this function to fold
 *  ALL reviewer_ids into the hash if that happens. */
export function proposalSignature(p: MemoryProposal): string {
  const reviewerId = p.evidence.find((e) => e.reviewer_id)?.reviewer_id ?? "";
  return createHash("sha256").update(`${p.title}\n${p.body}\n${reviewerId}`).digest("hex");
}

function logError(repoRoot: string, op: string, runId: string, err: unknown): void {
  try {
    const dir = proposalsPoolDir(repoRoot);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      schema: "reviewgate.proposalstore.error.v1",
      ts: new Date().toISOString(),
      op,
      run_id: runId,
      message: err instanceof Error ? err.message : String(err),
    });
    appendFileSync(proposalsPoolErrorLog(repoRoot), `${line}\n`, { mode: 0o600 });
  } catch {
    /* nothing we can do; never let logging break the gate */
  }
}

export class ProposalStore {
  constructor(
    private readonly repoRoot: string,
    private readonly runId: string,
  ) {}

  /** Append this iteration's proposals to the run-scoped pool, deduping any
   *  whose signature already exists in the file. Idempotent. Best-effort: a
   *  filesystem failure is logged to errors.jsonl, never thrown. */
  appendIter(iter: number, proposals: MemoryProposal[], nowIso: string): void {
    if (proposals.length === 0) return;
    try {
      const path = proposalsPoolPath(this.repoRoot, this.runId);
      if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
      const existing = new Set(this.readAll().map((s) => s.signature));
      const lines: string[] = [];
      for (const p of proposals) {
        const sig = proposalSignature(p);
        if (existing.has(sig)) continue;
        existing.add(sig);
        const stored: StoredProposal = {
          iter,
          appended_at: nowIso,
          signature: sig,
          proposal: p,
        };
        lines.push(JSON.stringify(stored));
      }
      if (lines.length === 0) return;
      appendFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
    } catch (e) {
      logError(this.repoRoot, "append", this.runId, e);
    }
  }

  /** Read all StoredProposal entries from this run's pool. Skips malformed
   *  lines silently (a crash mid-write leaves a truncated last line — the
   *  earlier complete entries are still recoverable). Returns [] if missing. */
  readAll(): StoredProposal[] {
    try {
      const path = proposalsPoolPath(this.repoRoot, this.runId);
      if (!existsSync(path)) return [];
      const out: StoredProposal[] = [];
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          out.push(StoredProposalSchema.parse(JSON.parse(t)));
        } catch {
          /* skip malformed line (e.g. truncated final write) */
        }
      }
      return out;
    } catch (e) {
      logError(this.repoRoot, "read", this.runId, e);
      return [];
    }
  }

  /** Cumulative MemoryProposal[] for the run — the input the Curator should
   *  see. Convenience wrapper over readAll(). */
  proposals(): MemoryProposal[] {
    return this.readAll().map((s) => s.proposal);
  }

  /** Drop the pool file for this run. Idempotent. Called when the cycle closes
   *  (PASS, commit-recovery). Best-effort: failure is logged, not thrown. */
  clear(): void {
    try {
      const path = proposalsPoolPath(this.repoRoot, this.runId);
      rmSync(path, { force: true });
    } catch (e) {
      logError(this.repoRoot, "clear", this.runId, e);
    }
  }
}

/** Reset-hook helper — wipe every run-scoped pool file in the proposals/pool
 *  directory. A new session starts with no stale pool from a prior cycle.
 *  Best-effort: errors are logged, not thrown. */
export function clearAllProposalPools(repoRoot: string): void {
  try {
    const dir = proposalsPoolDir(repoRoot);
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl") || name === "errors.jsonl") continue;
      try {
        rmSync(`${dir}/${name}`, { force: true });
      } catch (e) {
        logError(repoRoot, "clear-all", name, e);
      }
    }
  } catch (e) {
    logError(repoRoot, "clear-all", "(dir)", e);
  }
}
