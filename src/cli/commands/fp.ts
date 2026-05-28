// src/cli/commands/fp.ts
import { computeFpClusters, isNearActive } from "../../core/fp-ledger/clusters.ts";
import { FpLedgerStore } from "../../core/fp-ledger/store.ts";

export interface FpListInput {
  repoRoot: string;
  filter?: string;
  write?: (s: string) => void;
}
export interface FpShowInput {
  repoRoot: string;
  id: string;
  write?: (s: string) => void;
}
export interface FpPinInput {
  repoRoot: string;
  id?: string;
  signature?: string;
  by?: string;
  write?: (s: string) => void;
}
export interface FpUnpinInput {
  repoRoot: string;
  id: string;
  write?: (s: string) => void;
}
export interface FpAuditInput {
  repoRoot: string;
  write?: (s: string) => void;
}

export async function runFpList(input: FpListInput): Promise<number> {
  const out = input.write ?? ((s: string) => process.stdout.write(s));
  const snap = await new FpLedgerStore(input.repoRoot).snapshot();
  let entries = snap.entries;
  if (input.filter) {
    const f = input.filter.toLowerCase();
    entries = entries.filter((e) =>
      [e.id, e.file, e.rule_id, e.category, e.stage].some((v) => v.toLowerCase().includes(f)),
    );
  }
  if (entries.length === 0) {
    out("No FP-ledger entries found.\n");
    return 0;
  }
  for (const e of entries) {
    out(
      `${e.id}  [${e.stage}]  ${e.category}  ${e.file}  ${e.rule_id}  (${e.rejects.length} rejects, ${e.distinct_providers.length} providers)\n`,
    );
  }
  return 0;
}

export async function runFpShow(input: FpShowInput): Promise<number> {
  const out = input.write ?? ((s: string) => process.stdout.write(s));
  const snap = await new FpLedgerStore(input.repoRoot).snapshot();
  const e = snap.entries.find((x) => x.id === input.id);
  if (!e) {
    process.stderr.write(`fp show: entry ${input.id} not found\n`);
    return 1;
  }
  out(`ID:         ${e.id}\n`);
  out(`Stage:      ${e.stage}${e.pinned_by ? ` (pinned by ${e.pinned_by})` : ""}\n`);
  out(`Signature:  ${e.signature}\n`);
  out(`Rule:       ${e.rule_id}\n`);
  out(`Category:   ${e.category}\n`);
  out(`File:       ${e.file}\n`);
  out(`Providers:  ${e.distinct_providers.join(", ") || "(none)"}\n`);
  if (e.linked_brain_id) out(`Brain:      paired ${e.linked_brain_id}\n`);
  if (e.contradicts_brain_id)
    out(`⚠ Conflict:  contradicts brain entry ${e.contradicts_brain_id} — needs human review\n`);
  out(`First seen: ${e.first_seen_at}\n`);
  out(`Last seen:  ${e.last_seen_at}\n`);
  out(`Rejects (${e.rejects.length}):\n`);
  for (const r of e.rejects) {
    out(`  - ${r.ts}  ${r.provider}  ${r.reason}\n`);
  }
  return 0;
}

export async function runFpPin(input: FpPinInput): Promise<number> {
  const out = input.write ?? ((s: string) => process.stdout.write(s));
  const store = new FpLedgerStore(input.repoRoot);
  let id = input.id;
  if (!id && input.signature) {
    const snap = await store.snapshot();
    id = snap.entries.find((e) => e.signature === input.signature)?.id;
    if (!id) {
      process.stderr.write(`fp pin: no entry with signature ${input.signature}\n`);
      return 1;
    }
  }
  if (!id) {
    process.stderr.write("fp pin: --id <id> or --signature <sig> is required\n");
    return 2;
  }
  const ok = await store.pin(id, input.by ?? "cli");
  if (!ok) {
    process.stderr.write(`fp pin: entry ${id} not found\n`);
    return 1;
  }
  out(`Pinned ${id} (sticky — still shown as advisory, not hidden).\n`);
  return 0;
}

export async function runFpUnpin(input: FpUnpinInput): Promise<number> {
  const out = input.write ?? ((s: string) => process.stdout.write(s));
  const ok = await new FpLedgerStore(input.repoRoot).unpin(input.id);
  if (!ok) {
    process.stderr.write(`fp unpin: entry ${input.id} not found\n`);
    return 1;
  }
  out(`Unpinned ${input.id}.\n`);
  return 0;
}

export interface FpClustersInput {
  repoRoot: string;
  file?: string;
  write?: (s: string) => void;
  /** Override "now" for deterministic tests. */
  nowIso?: string;
}

export async function runFpClusters(input: FpClustersInput): Promise<number> {
  const out = input.write ?? ((s: string) => process.stdout.write(s));
  const snap = await new FpLedgerStore(input.repoRoot).snapshot();
  const clusters = computeFpClusters(snap.entries, input.nowIso ?? new Date().toISOString());
  const fileNeedle = input.file?.toLowerCase();
  const filtered = fileNeedle
    ? clusters.filter((c) => c.file.toLowerCase().includes(fileNeedle))
    : clusters;
  if (filtered.length === 0) {
    out(
      "No multi-entry FP clusters found (a cluster requires ≥2 entries sharing rule_id_token0 + file).\n",
    );
    return 0;
  }
  out(
    `FP clusters — derived view, no schema change (key = <rule_id_token0>@<file>; ${filtered.length} of ${clusters.length} shown):\n\n`,
  );
  for (const c of filtered) {
    const near = isNearActive(c) ? "  ⚡ near-active" : "";
    out(`[${c.stage}] ${c.key}${near}\n`);
    out(
      `  rejects: ${c.reject_count_total} total, ${c.reject_count_active_window} in active-window (60d), ${c.reject_count_sticky_window} in sticky-window (90d)\n`,
    );
    out(`  providers: ${c.distinct_providers.join(", ") || "(none)"}\n`);
    out(`  members: ${c.member_ids.join(", ")}\n`);
    out(`  signatures: ${c.member_signatures.length} distinct\n`);
    out(`  first seen: ${c.first_seen_at}\n`);
    out(`  last seen:  ${c.last_seen_at}\n\n`);
  }
  return 0;
}

export async function runFpAudit(input: FpAuditInput): Promise<number> {
  const out = input.write ?? ((s: string) => process.stdout.write(s));
  const snap = await new FpLedgerStore(input.repoRoot).snapshot();
  const applied = snap.entries.filter((e) => e.stage !== "candidate");
  if (applied.length === 0) {
    out("No active or sticky FP-ledger entries to audit.\n");
    return 0;
  }
  const groups = new Map<string, typeof applied>();
  for (const e of applied) {
    const firstProvider = e.rejects[0]?.provider ?? "(unknown)";
    const list = groups.get(firstProvider) ?? [];
    list.push(e);
    groups.set(firstProvider, list);
  }
  out(`Active/sticky FP-ledger entries by first-seen provider (${applied.length} total):\n`);
  for (const provider of [...groups.keys()].sort()) {
    out(`\n${provider}:\n`);
    for (const e of groups.get(provider) ?? []) {
      out(
        `  ${e.id}  [${e.stage}]  ${e.file}  ${e.rule_id}  (${e.distinct_providers.length} providers)\n`,
      );
    }
  }
  return 0;
}
