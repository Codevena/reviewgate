// src/stats/load.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DecisionOutcomeSchema, RunSummarySchema } from "../schemas/audit-event.ts";
import type { DecisionOutcome, RunSummary } from "../schemas/audit-event.ts";
import { auditDir } from "../utils/paths.ts";

export interface LoadedRun {
  ts: string;
  run_id: string;
  iter: number;
  summary: RunSummary;
}

export interface AuditWindow {
  runs: LoadedRun[];
  escalationCount: number;
  decisions: DecisionOutcome[];
}

const DAY_MS = 86_400_000;

// Relative `YYYY/MM/DD` day-dirs overlapping [since − 1 day, untilInclusiveDay].
// The −1-day guard recovers in-window events written into the prior day's
// partition by a process that crossed UTC midnight (AuditLogger memoizes its
// partition path for the whole process lifetime).
function dayDirsInRange(since: string, until: string): string[] {
  const startMs = new Date(since).getTime() - DAY_MS;
  const endMs = new Date(until).getTime();
  const dirs: string[] = [];
  const start = new Date(startMs);
  let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const end = new Date(endMs);
  const endDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cur.getTime() <= endDay.getTime()) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, "0");
    const d = String(cur.getUTCDate()).padStart(2, "0");
    dirs.push(`${y}/${m}/${d}`);
    cur = new Date(cur.getTime() + DAY_MS);
  }
  return dirs;
}

function collectFiles(dir: string, since?: string, until?: string): string[] {
  if (since != null && until != null) {
    const files: string[] = [];
    for (const dayDir of dayDirsInRange(since, until)) {
      const abs = join(dir, dayDir);
      if (!existsSync(abs)) continue;
      const glob = new Bun.Glob("*.jsonl");
      for (const rel of glob.scanSync({ cwd: abs })) {
        files.push(join(dayDir, rel));
      }
    }
    return files;
  }
  const glob = new Bun.Glob("**/*.jsonl");
  return [...glob.scanSync({ cwd: dir })];
}

export function loadAuditWindow(
  repoRoot: string,
  opts: { since?: string; until?: string; last?: number },
): AuditWindow {
  const dir = auditDir(repoRoot);
  if (!existsSync(dir)) {
    return { runs: [], escalationCount: 0, decisions: [] };
  }

  const runs: LoadedRun[] = [];
  const escalations: { ts: string }[] = [];
  const decisions: { ts: string; outcome: DecisionOutcome }[] = [];

  for (const rel of collectFiles(dir, opts.since, opts.until)) {
    const fullPath = join(dir, rel);
    let content: string;
    try {
      content = readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (obj.event === "escalation") {
        escalations.push({ ts: typeof obj.ts === "string" ? obj.ts : "" });
      } else if (obj.event === "run.complete" && obj.run_summary != null) {
        let summary: RunSummary;
        try {
          summary = RunSummarySchema.parse(obj.run_summary);
        } catch {
          continue;
        }
        runs.push({
          ts: typeof obj.ts === "string" ? obj.ts : "",
          run_id: typeof obj.run_id === "string" ? obj.run_id : "",
          iter: typeof obj.iter === "number" ? obj.iter : 0,
          summary,
        });
      } else if (obj.event === "decision.applied" && obj.decision_outcome != null) {
        const res = DecisionOutcomeSchema.safeParse(obj.decision_outcome);
        if (res.success) {
          decisions.push({ ts: typeof obj.ts === "string" ? obj.ts : "", outcome: res.data });
        }
      }
    }
  }

  runs.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const { since, until, last } = opts;
  // Guard `last <= 0`: `slice(length - 0)` (and `slice(length + |neg|)`) yields an
  // EMPTY run window, but `lowerBound` then stays undefined and escalations/
  // decisions fall through to the UNWINDOWED set — i.e. 0 runs but ALL
  // escalations/decisions counted (a miscount). "the N most-recent runs" with
  // N ≤ 0 is an empty window across the board: no runs, no escalations, no
  // decisions. A negative count is meaningless → treated identically.
  if (last != null && last <= 0) {
    return { runs: [], escalationCount: 0, decisions: [] };
  }
  let filteredRuns = since != null ? runs.filter((r) => r.ts >= since) : runs;
  if (until != null) filteredRuns = filteredRuns.filter((r) => r.ts < until);
  let filteredEscalations = since != null ? escalations.filter((e) => e.ts >= since) : escalations;
  if (until != null) filteredEscalations = filteredEscalations.filter((e) => e.ts < until);

  const windowedRuns = last != null ? filteredRuns.slice(filteredRuns.length - last) : filteredRuns;

  const lowerBound = last != null && windowedRuns.length > 0 ? windowedRuns[0]?.ts : undefined;
  const escalationsInWindow =
    lowerBound != null
      ? filteredEscalations.filter((e) => e.ts >= lowerBound)
      : filteredEscalations;

  let filteredDecisions = since != null ? decisions.filter((d) => d.ts >= since) : decisions;
  if (until != null) filteredDecisions = filteredDecisions.filter((d) => d.ts < until);
  const decisionsInWindow =
    lowerBound != null ? filteredDecisions.filter((d) => d.ts >= lowerBound) : filteredDecisions;

  return {
    runs: windowedRuns,
    escalationCount: escalationsInWindow.length,
    decisions: decisionsInWindow.map((d) => d.outcome),
  };
}
