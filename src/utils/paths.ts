// src/utils/paths.ts
import { resolve, join } from 'node:path';

export function reviewgateDir(repoRoot: string): string {
  return resolve(repoRoot, '.reviewgate');
}

export function stateJsonPath(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), 'state.json');
}

export function lockPath(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), '.lock');
}

export function dirtyFlagPath(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), 'dirty.flag');
}

export function pendingMdPath(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), 'pending.md');
}

export function pendingJsonPath(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), 'pending.json');
}

export function decisionsPath(repoRoot: string, iter: number): string {
  return join(reviewgateDir(repoRoot), 'decisions', `${iter}.jsonl`);
}

export function escalationMdPath(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), 'ESCALATION.md');
}

export function auditDir(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), 'audit');
}
