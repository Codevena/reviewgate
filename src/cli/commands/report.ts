// src/cli/commands/report.ts
import { lastCompleteWeek, parseIsoWeek } from "../../stats/iso-week.ts";
import { writeReportFile } from "../../stats/report-file.ts";
import { assembleWeeklyReport } from "../../stats/weekly-assemble.ts";
import { renderWeeklyMarkdown } from "../../stats/weekly-render.ts";
import { weekReportPath } from "../../utils/paths.ts";

export interface RunReportInput {
  repoRoot: string;
  week?: string; // ISO week e.g. "2026-W20"; default = last complete week
  json?: boolean;
  now?: Date; // injectable clock for tests
}

export async function runReport(input: RunReportInput): Promise<string> {
  const now = input.now ?? new Date();
  const week = input.week !== undefined ? parseIsoWeek(input.week) : lastCompleteWeek(now);
  const report = await assembleWeeklyReport(input.repoRoot, week, { now });

  if (input.json === true) {
    return JSON.stringify(report, null, 2);
  }

  const md = renderWeeklyMarkdown(report);
  writeReportFile(weekReportPath(input.repoRoot, report.week.iso), md, { exclusive: false });
  return md;
}
