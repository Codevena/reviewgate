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
  // `loadAuditWindow` filters runs with a *lexical* string compare (`r.ts >= since`)
  // against ISO timestamps. A raw non-ISO value (e.g. "yesterday", "05/27/2026")
  // is therefore silently mis-compared — it either excludes every real run or
  // matches the wrong window, leaving the user believing they filtered correctly.
  // Reject unparseable input outright and normalize parseable input to an ISO
  // string so the lexical compare is always meaningful.
  let since: string | undefined;
  if (input.since !== undefined) {
    const parsed = new Date(input.since);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(
        `Invalid --since value "${input.since}": expected an ISO date like 2026-05-01 or 2026-05-01T00:00:00Z`,
      );
    }
    since = parsed.toISOString();
  }

  const window = loadAuditWindow(input.repoRoot, {
    ...(since !== undefined ? { since } : {}),
    ...(input.last !== undefined ? { last: input.last } : {}),
  });
  const fpSnap = await new FpLedgerStore(input.repoRoot).snapshot();
  const brainSnap = await new BrainStore(input.repoRoot).snapshot();
  const fpEntries = fpSnap.entries.map((e) => ({
    stage: e.stage,
    rejects: e.rejects.map((r) => ({ provider: r.provider })),
  }));
  const brainEntries = brainSnap.entries.map((e) => ({ status: e.status, type: e.type }));
  const report = aggregate(
    window.runs,
    window.escalationCount,
    fpEntries,
    brainEntries,
    window.decisions,
  );
  return input.json === true ? JSON.stringify(report, null, 2) : renderStats(report);
}
