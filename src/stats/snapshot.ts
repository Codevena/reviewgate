// src/stats/snapshot.ts
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewgateConfig } from "../config/define-config.ts";
import { reportsDir, weekReportPath } from "../utils/paths.ts";
import { formatIsoWeek, lastCompleteWeek, weekBounds } from "./iso-week.ts";
import { loadAuditWindow } from "./load.ts";
import { writeReportFile } from "./report-file.ts";
import { assembleWeeklyReport } from "./weekly-assemble.ts";
import { renderWeeklyMarkdown } from "./weekly-render.ts";

const SNAPSHOT_RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

function emptyMarker(repoRoot: string, iso: string): string {
  return join(reportsDir(repoRoot), `.${iso}.empty`);
}
function failedMarker(repoRoot: string, iso: string): string {
  return join(reportsDir(repoRoot), `.${iso}.failed`);
}

// Best-effort, idempotent weekly snapshot of the last COMPLETE week. Cheap
// short-circuits first (no audit scan); the expensive build runs at most once
// per ISO week on the success path. The caller wraps this in its own try/catch;
// it also self-guards so a thrown build is recorded as a cooldown marker.
export async function maybeWriteWeeklySnapshot(
  repoRoot: string,
  config: ReviewgateConfig,
  opts: { now?: Date } = {},
): Promise<void> {
  if (config.weeklyReport?.autoSnapshot !== true) return;
  const now = opts.now ?? new Date();
  const week = lastCompleteWeek(now);
  const iso = formatIsoWeek(week);

  if (existsSync(weekReportPath(repoRoot, iso))) return; // already written
  if (existsSync(emptyMarker(repoRoot, iso))) return; // known zero-run week
  const failed = failedMarker(repoRoot, iso);
  if (existsSync(failed)) {
    try {
      if (now.getTime() - statSync(failed).mtimeMs < SNAPSHOT_RETRY_COOLDOWN_MS) return;
    } catch {
      /* stat failed — fall through and retry */
    }
  }

  try {
    const bounds = weekBounds(week.year, week.week);
    const win = loadAuditWindow(repoRoot, { since: bounds.since, until: bounds.until });
    if (win.runs.length === 0) {
      writeReportFile(emptyMarker(repoRoot, iso), "", { exclusive: false });
      return;
    }
    const report = await assembleWeeklyReport(repoRoot, week, { now });
    const md = renderWeeklyMarkdown(report);
    writeReportFile(weekReportPath(repoRoot, iso), md, { exclusive: true });
  } catch {
    // Record/refresh an expiring cooldown marker so a persistently-failing build
    // does not rescan on every gate stop. Not a poison — it expires.
    try {
      mkdirSync(reportsDir(repoRoot), { recursive: true });
      writeFileSync(failed, "", { mode: 0o600 });
    } catch {
      /* best-effort */
    }
  }
}
