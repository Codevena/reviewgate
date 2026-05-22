// src/stats/load.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RunSummarySchema } from "../schemas/audit-event.ts";
import type { RunSummary } from "../schemas/audit-event.ts";
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
}

export function loadAuditWindow(
  repoRoot: string,
  opts: { since?: string; last?: number },
): AuditWindow {
  const dir = auditDir(repoRoot);
  if (!existsSync(dir)) {
    return { runs: [], escalationCount: 0 };
  }

  const runs: LoadedRun[] = [];
  const escalations: { ts: string }[] = [];

  // Collect all .jsonl files under the audit dir
  const glob = new Bun.Glob("**/*.jsonl");
  const files = [...glob.scanSync({ cwd: dir })];

  for (const rel of files) {
    const fullPath = join(dir, rel);
    let content: string;
    try {
      content = readFileSync(fullPath, "utf8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // skip malformed lines
        continue;
      }

      if (obj.event === "escalation") {
        escalations.push({ ts: typeof obj.ts === "string" ? obj.ts : "" });
      } else if (obj.event === "run.complete" && obj.run_summary != null) {
        let summary: RunSummary;
        try {
          summary = RunSummarySchema.parse(obj.run_summary);
        } catch {
          // skip lines with invalid run_summary shape
          continue;
        }
        runs.push({
          ts: typeof obj.ts === "string" ? obj.ts : "",
          run_id: typeof obj.run_id === "string" ? obj.run_id : "",
          iter: typeof obj.iter === "number" ? obj.iter : 0,
          summary,
        });
      }
    }
  }

  // Sort runs ascending by ts (ISO string lexicographic comparison works)
  runs.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  // Apply since filter to both runs and escalations
  const { since, last } = opts;
  const filteredRuns = since != null ? runs.filter((r) => r.ts >= since) : runs;
  const filteredEscalations =
    since != null ? escalations.filter((e) => e.ts >= since) : escalations;

  // Apply last (most-recent N runs) — only affects runs, not escalationCount
  const windowedRuns = last != null ? filteredRuns.slice(filteredRuns.length - last) : filteredRuns;

  return {
    runs: windowedRuns,
    escalationCount: filteredEscalations.length,
  };
}
