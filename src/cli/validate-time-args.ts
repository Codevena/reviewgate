// src/cli/validate-time-args.ts
//
// Friendly, fail-fast validation for the CLI's date/week flags. Without this the
// raw parse error (parseIsoWeek throwing, or `new Date("yesterday").toISOString()`
// throwing RangeError "Invalid Date") propagates out of the citty command handler
// as a full stack trace exposing internal file paths — useless to a user who just
// typo'd a flag. These helpers return a one-line, actionable message (naming the
// expected format) or null when the value is valid.
import { parseIsoWeek } from "../stats/iso-week.ts";

// Strict ISO-8601: a date (YYYY-MM-DD) OR a date-time with optional fractional
// seconds and an optional Z / ±HH:MM offset. Anchored so we reject ambiguous,
// locale-dependent forms (e.g. "05/01/2026" — is that May 1st or Jan 5th? — or
// "yesterday") that `new Date()` would otherwise silently accept and turn into the
// WRONG time window. We deliberately do NOT accept a bare "T"-less time.
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/** Validate a `--since` value. Returns an error message, or null if valid. */
export function validateSince(since: string): string | null {
  const value = since.trim();
  const err = `Invalid --since value "${since}": expected a strict ISO-8601 date like 2026-05-01 or 2026-05-01T00:00:00Z`;
  // 1) Reject ambiguous / locale-dependent shapes up front (regex).
  if (!ISO_8601.test(value)) return err;
  // 2) Reject out-of-range times etc. that match the shape but aren't real
  //    (e.g. 2026-13-01 → NaN).
  if (Number.isNaN(new Date(value).getTime())) return err;
  // 3) Reject calendar overflows that `new Date()` SILENTLY rolls over instead of
  //    rejecting (e.g. 2026-02-30 → Mar 2, 2026-04-31 → May 1). Validate ONLY the
  //    Y-M-D portion via a UTC round-trip — independent of any time/timezone offset
  //    (a valid offset like ...T23:00:00-05:00 must NOT be rejected just because it
  //    shifts the UTC day).
  const [y, m, d] = value.slice(0, 10).split("-").map(Number) as [number, number, number];
  const ymd = new Date(Date.UTC(y, m - 1, d));
  if (ymd.getUTCFullYear() !== y || ymd.getUTCMonth() + 1 !== m || ymd.getUTCDate() !== d) {
    return err;
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
