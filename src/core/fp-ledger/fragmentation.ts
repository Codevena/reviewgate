// src/core/fp-ledger/fragmentation.ts
// #4: advisory detector for a FRAGMENTING false-positive class — a file with many
// distinct FP-ledger entries that recur (recent rejects) but can't promote to
// auto-suppression (fragmented rule_ids / single-reviewer ≥2-provider floor). Pure.
// NON-suppressing: the caller renders a banner recommending a house rule (the durable
// fix); this never demotes/suppresses a finding.
import type { FpLedgerEntry } from "../../schemas/fp-ledger.ts";

export const FP_FRAG_MIN_SIGNATURES = 3;
export const FP_FRAG_MIN_REJECTS = 3;
export const FP_FRAG_WINDOW_DAYS = 60;
export const FP_FRAG_MAX_REPORTED = 3;
const DAY_MS = 86_400_000;

export interface FpFragmentation {
  file: string;
  distinct_signatures: number;
  total_rejects: number;
  sample_rule_ids: string[];
}

// `suppressedFiles` = files where suppression is EFFECTIVELY ACTIVE at `now` (the
// caller builds it from the windowed views — fpActiveSnapshot + active/sticky clusters
// — NOT the stored, promote-only entry.stage). The detector relies entirely on it for
// the "already suppressed" exclusion and never reads entry.stage.
export function fragmentingFpClasses(
  entries: FpLedgerEntry[],
  nowIso: string,
  opts: {
    minDistinctSignatures: number;
    minRejects: number;
    windowDays: number;
    suppressedFiles: Set<string>;
  },
): FpFragmentation[] {
  const nowMs = Date.parse(nowIso);
  const windowMs = opts.windowDays * DAY_MS;
  const byFile = new Map<string, FpLedgerEntry[]>();
  for (const e of entries) {
    if (opts.suppressedFiles.has(e.file)) continue;
    const arr = byFile.get(e.file);
    if (arr) arr.push(e);
    else byFile.set(e.file, [e]);
  }
  const out: FpFragmentation[] = [];
  for (const [file, fileEntries] of byFile) {
    const sigs = new Set<string>();
    const ruleIds = new Set<string>();
    let rejects = 0;
    for (const e of fileEntries) {
      const inWindow = e.rejects.filter((r) => nowMs - Date.parse(r.ts) <= windowMs);
      if (inWindow.length === 0) continue; // stale signature — no recent activity
      sigs.add(e.signature);
      ruleIds.add(e.rule_id);
      rejects += inWindow.length;
    }
    if (sigs.size >= opts.minDistinctSignatures && rejects >= opts.minRejects) {
      out.push({
        file,
        distinct_signatures: sigs.size,
        total_rejects: rejects,
        sample_rule_ids: [...ruleIds].sort().slice(0, 4),
      });
    }
  }
  out.sort((a, b) => b.total_rejects - a.total_rejects || a.file.localeCompare(b.file));
  return out;
}
