// src/cli/commands/brain.ts
import { BrainStore } from "../../core/brain/store.ts";

export interface BrainListInput {
  repoRoot: string;
  filter?: string;
  write?: (s: string) => void;
}

export interface BrainShowInput {
  repoRoot: string;
  id: string;
  write?: (s: string) => void;
}

export interface BrainRevokeInput {
  repoRoot: string;
  id: string;
  write?: (s: string) => void;
}

export async function runBrainList(input: BrainListInput): Promise<number> {
  const out = input.write ?? ((s: string) => process.stdout.write(s));
  const store = new BrainStore(input.repoRoot);
  const snap = await store.snapshot();
  let entries = snap.entries;
  if (input.filter) {
    const f = input.filter.toLowerCase();
    entries = entries.filter(
      (e) =>
        e.id.toLowerCase().includes(f) ||
        e.title.toLowerCase().includes(f) ||
        e.type.toLowerCase().includes(f) ||
        e.status.toLowerCase().includes(f),
    );
  }
  if (entries.length === 0) {
    out("No brain entries found.\n");
    return 0;
  }
  for (const e of entries) {
    out(`${e.id}  [${e.status}]  ${e.type}  ${e.title}\n`);
  }
  return 0;
}

export async function runBrainShow(input: BrainShowInput): Promise<number> {
  const out = input.write ?? ((s: string) => process.stdout.write(s));
  const store = new BrainStore(input.repoRoot);
  const snap = await store.snapshot();
  const entry = snap.entries.find((e) => e.id === input.id);
  if (!entry) {
    process.stderr.write(`brain show: entry ${input.id} not found\n`);
    return 1;
  }
  out(`ID:         ${entry.id}\n`);
  out(`Type:       ${entry.type}\n`);
  out(`Status:     ${entry.status}\n`);
  out(`Scope:      ${entry.scope}\n`);
  out(`Title:      ${entry.title}\n`);
  out(`Body:       ${entry.body}\n`);
  out(`Confidence: ${entry.confidence}\n`);
  out(`Refs:       ${entry.referenced_count}\n`);
  out(`Tags:       ${entry.tags.join(", ") || "(none)"}\n`);
  out(`Created:    ${entry.created_at}\n`);
  if (entry.last_referenced_at) out(`Last ref:   ${entry.last_referenced_at}\n`);
  return 0;
}

export async function runBrainRevoke(input: BrainRevokeInput): Promise<number> {
  const out = input.write ?? ((s: string) => process.stdout.write(s));
  const store = new BrainStore(input.repoRoot);
  const removed = await store.revoke(input.id);
  if (!removed) {
    process.stderr.write(`brain revoke: entry ${input.id} not found\n`);
    return 1;
  }
  out(`Revoked ${input.id}.\n`);
  return 0;
}
