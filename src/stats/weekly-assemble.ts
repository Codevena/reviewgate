// src/stats/weekly-assemble.ts
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BrainStore } from "../core/brain/store.ts";
import { FpLedgerStore } from "../core/fp-ledger/store.ts";
import { auditDir } from "../utils/paths.ts";
import type { BrainEntryLite, FpEntryLite } from "./aggregate.ts";
import { aggregate } from "./aggregate.ts";
import { formatIsoWeek, previousWeek, weekBounds } from "./iso-week.ts";
import type { IsoWeek } from "./iso-week.ts";
import { loadAuditWindow } from "./load.ts";
import type { LoadedRun } from "./load.ts";
import { buildWeeklyReport } from "./weekly.ts";
import type { WeeklyReport } from "./weekly.ts";

function signatureMap(runs: LoadedRun[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of runs) {
    if (r.summary.source !== "panel") continue;
    for (const sig of r.summary.signatures) m.set(sig, (m.get(sig) ?? 0) + 1);
  }
  return m;
}

// True if any audit day-partition directory is dated strictly before `since`.
// Cheap: walks YYYY/MM/DD dir names, no .jsonl parsing.
function hasPartitionBefore(repoRoot: string, since: string): boolean {
  const dir = auditDir(repoRoot);
  if (!existsSync(dir)) return false;
  const sinceDay = since.slice(0, 10); // YYYY-MM-DD
  try {
    for (const y of readdirSync(dir)) {
      if (!/^\d{4}$/.test(y)) continue;
      for (const m of readdirSync(join(dir, y))) {
        if (!/^\d{2}$/.test(m)) continue;
        for (const d of readdirSync(join(dir, y, m))) {
          if (!/^\d{2}$/.test(d)) continue;
          if (`${y}-${m}-${d}` < sinceDay) return true;
        }
      }
    }
  } catch {
    // tolerate a malformed audit tree (e.g. a stray file where a dir is expected)
    return false;
  }
  return false;
}

export async function assembleWeeklyReport(
  repoRoot: string,
  week: IsoWeek,
  opts: { now: Date },
): Promise<WeeklyReport> {
  const bounds = weekBounds(week.year, week.week);
  const prev = previousWeek(week);
  const prevBounds = weekBounds(prev.year, prev.week);

  const curWindow = loadAuditWindow(repoRoot, { since: bounds.since, until: bounds.until });
  const prevWindow = loadAuditWindow(repoRoot, {
    since: prevBounds.since,
    until: prevBounds.until,
  });

  const fpSnap = await new FpLedgerStore(repoRoot).snapshot();
  const brainSnap = await new BrainStore(repoRoot).snapshot();

  const fpLite: FpEntryLite[] = fpSnap.entries.map((e) => ({
    stage: e.stage,
    rejects: e.rejects.map((r) => ({ provider: r.provider })),
  }));
  const brainLite: BrainEntryLite[] = brainSnap.entries.map((e) => ({
    status: e.status,
    type: e.type,
  }));

  const current = aggregate(
    curWindow.runs,
    curWindow.escalationCount,
    fpLite,
    brainLite,
    curWindow.decisions,
  );

  const hasPriorHistory = prevWindow.runs.length > 0 || hasPartitionBefore(repoRoot, bounds.since);
  const previous = hasPriorHistory
    ? aggregate(
        prevWindow.runs,
        prevWindow.escalationCount,
        fpLite,
        brainLite,
        prevWindow.decisions,
      )
    : null;

  const generatedAt = opts.now.toISOString();

  return buildWeeklyReport(current, previous, {
    weekIso: formatIsoWeek(week),
    bounds,
    previousWeekIso: formatIsoWeek(prev),
    currentSignatures: signatureMap(curWindow.runs),
    previousSignatures: signatureMap(prevWindow.runs),
    windowedFpEntries: fpSnap.entries,
    windowedBrainEntries: brainSnap.entries,
    generatedAt,
    now: opts.now,
  });
}
