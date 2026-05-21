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

export function auditDir(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), "audit");
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
