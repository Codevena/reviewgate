// src/cli/validate-time-args.ts
//
// Friendly, fail-fast validation for the CLI's date/week flags. Without this the
// raw parse error (parseIsoWeek throwing, or `new Date("yesterday").toISOString()`
// throwing RangeError "Invalid Date") propagates out of the citty command handler
// as a full stack trace exposing internal file paths — useless to a user who just
// typo'd a flag. These helpers return a one-line, actionable message (naming the
// expected format) or null when the value is valid.
import { parseIsoWeek } from "../stats/iso-week.ts";

/** Validate a `--since` value. Returns an error message, or null if valid. */
export function validateSince(since: string): string | null {
  if (Number.isNaN(new Date(since).getTime())) {
    return `Invalid --since value "${since}": expected an ISO date like 2026-05-01 or 2026-05-01T00:00:00Z`;
  }
  return null;
}

/** Validate a `--week` value. Returns an error message, or null if valid. */
export function validateWeek(week: string): string | null {
  try {
    parseIsoWeek(week);
    return null;
  } catch {
    return `Invalid --week value "${week}": expected ISO week format YYYY-Www (e.g. 2026-W12)`;
  }
}
