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

export function decisionsPath(repoRoot: string, iter: number): string {
  return join(reviewgateDir(repoRoot), "decisions", `${iter}.jsonl`);
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
export function curatorDecisionsPath(repoRoot: string, runId: string): string {
  return join(brainDir(repoRoot), "proposals", "curator-decisions", `${runId}.jsonl`);
}
