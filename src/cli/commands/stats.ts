// src/cli/commands/stats.ts
import { BrainStore } from "../../core/brain/store.ts";
import { FpLedgerStore } from "../../core/fp-ledger/store.ts";
import { aggregate } from "../../stats/aggregate.ts";
import { loadAuditWindow } from "../../stats/load.ts";
import { renderStats } from "../../stats/render.ts";

export interface RunStatsInput {
  repoRoot: string;
  since?: string;
  last?: number;
  json?: boolean;
}

export async function runStats(input: RunStatsInput): Promise<string> {
  const window = loadAuditWindow(input.repoRoot, {
    ...(input.since !== undefined ? { since: input.since } : {}),
    ...(input.last !== undefined ? { last: input.last } : {}),
  });
  const fpSnap = await new FpLedgerStore(input.repoRoot).snapshot();
  const brainSnap = await new BrainStore(input.repoRoot).snapshot();
  const fpEntries = fpSnap.entries.map((e) => ({
    stage: e.stage,
    rejects: e.rejects.map((r) => ({ provider: r.provider })),
  }));
  const brainEntries = brainSnap.entries.map((e) => ({ status: e.status, type: e.type }));
  const report = aggregate(window.runs, window.escalationCount, fpEntries, brainEntries);
  return input.json === true ? JSON.stringify(report, null, 2) : renderStats(report);
}
