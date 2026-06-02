// src/utils/paths.ts
import { join, resolve } from "node:path";

export function reviewgateDir(repoRoot: string): string {
  return resolve(repoRoot, ".reviewgate");
}

export function stateJsonPath(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), "state.json");
}

export function lockPath(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), ".lock");
}

// Serializes the whole stop-hook gate run (LoopDriver + Orchestrator), so two
// stop-hooks on the same checkout can't run reviews in parallel and interleave
// writes to pending.*, decisions, and the dirty flag. Distinct from `lockPath`,
// which only guards individual state.json writes.
export function gateLockPath(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), "gate.lock");
}

export function dirtyFlagPath(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), "dirty.flag");
}

export function pendingMdPath(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), "pending.md");
}

export function pendingJsonPath(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), "pending.json");
}

// One-shot `review-plan` reports go to their OWN paths so a manual plan review
// never clobbers the gate's pending.md/json (which drives the decisions loop).
export function planReviewMdPath(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), "plan-review.md");
}

export function planReviewJsonPath(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), "plan-review.json");
}

export function decisionsDir(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), "decisions");
}

export function decisionsPath(repoRoot: string, iter: number): string {
  return join(decisionsDir(repoRoot), `${iter}.jsonl`);
}

export function escalationMdPath(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), "ESCALATION.md");
}

// M5 Part B1 — FP-ledger storage. A single JSON document (one FpLedgerIndex)
// despite the `.jsonl` name kept from the design spec; mirrors BrainStore's
// flock + atomic-write pattern.
export function learningsDir(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), "learnings");
}
export function knownFpPath(repoRoot: string): string {
  return join(learningsDir(repoRoot), "known_fp.jsonl");
}
export function fpLedgerLockPath(repoRoot: string): string {
  return join(learningsDir(repoRoot), ".lock");
}
export function implicitOutcomesPath(repoRoot: string): string {
  return join(learningsDir(repoRoot), "implicit-outcomes.jsonl");
}
export function implicitOutcomesLockPath(repoRoot: string): string {
  return join(learningsDir(repoRoot), ".implicit-outcomes.lock");
}

export function auditDir(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), "audit");
}

export function reportsDir(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), "reports");
}

export function weekReportPath(repoRoot: string, iso: string): string {
  return join(reportsDir(repoRoot), `${iso}.md`);
}

export function brainDir(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), "brain");
}
export function brainJsonPath(repoRoot: string): string {
  return join(brainDir(repoRoot), "brain.json");
}
export function brainMdPath(repoRoot: string): string {
  return join(brainDir(repoRoot), "brain.md");
}
export function brainSourcesPath(repoRoot: string): string {
  return join(brainDir(repoRoot), "sources.jsonl");
}
export function brainArchivePath(repoRoot: string): string {
  return join(brainDir(repoRoot), "archive.md");
}
export function brainLockPath(repoRoot: string): string {
  return join(brainDir(repoRoot), ".lock");
}
export function brainCandidatesPath(repoRoot: string): string {
  return join(brainDir(repoRoot), "candidates.jsonl");
}
export function brainCandidatesLockPath(repoRoot: string): string {
  return join(brainDir(repoRoot), "candidates.lock");
}
export function reputationJsonPath(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), "reputation.json");
}
export function reputationLockPath(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), "reputation.lock");
}
export function brainSnapshotsDir(repoRoot: string): string {
  return join(brainDir(repoRoot), "snapshots");
}
/**
 * Path to a run's curator-decisions JSONL file.
 *
 * `runId` is sanitized to `[A-Za-z0-9_-]` so a malicious/crafted run id cannot
 * inject path separators or `..` traversal segments and escape the
 * curator-decisions directory. Any disallowed character is stripped; a runId
 * that sanitizes to empty is rejected.
 */
export function curatorDecisionsPath(repoRoot: string, runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9_-]/g, "");
  if (safe.length === 0) {
    throw new Error(`curatorDecisionsPath: runId sanitizes to empty: ${JSON.stringify(runId)}`);
  }
  return join(brainDir(repoRoot), "proposals", "curator-decisions", `${safe}.jsonl`);
}

// F2 per-run proposal pool — accumulates memory_proposals across all iterations
// of a single review cycle so the curator sees cross-iteration provider
// diversity (e.g. claude-code on iter 1 + opencode fallback on iter 2 → 2
// distinct providers → quorum reachable in a single-reviewer-with-failover
// config). One file per run_id; cleared on PASS / commit-recovery / reset.
export function proposalsPoolDir(repoRoot: string): string {
  return join(brainDir(repoRoot), "proposals", "pool");
}

export function proposalsPoolPath(repoRoot: string, runId: string): string {
  const safe = runId.replace(/[^A-Za-z0-9_-]/g, "");
  if (safe.length === 0) {
    throw new Error(`proposalsPoolPath: runId sanitizes to empty: ${JSON.stringify(runId)}`);
  }
  return join(proposalsPoolDir(repoRoot), `${safe}.jsonl`);
}

export function proposalsPoolErrorLog(repoRoot: string): string {
  return join(proposalsPoolDir(repoRoot), "errors.jsonl");
}
