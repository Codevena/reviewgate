// src/stats/iso-week.ts
// Pure ISO-8601 week math in UTC. No I/O. Half-open week bounds [since, until).

export interface IsoWeek {
  year: number;
  week: number;
}

export interface WeekBounds {
  since: string; // inclusive ISO (Mon 00:00:00.000Z)
  until: string; // exclusive ISO (next Mon 00:00:00.000Z)
}

const DAY_MS = 86_400_000;

function thursdayOf(date: Date): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const isoDow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (4 - isoDow));
  return d;
}

export function isoWeekOf(date: Date): IsoWeek {
  const thu = thursdayOf(date);
  const year = thu.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const week = Math.floor((thu.getTime() - jan1.getTime()) / (7 * DAY_MS)) + 1;
  return { year, week };
}

export function weeksInIsoYear(year: number): number {
  return isoWeekOf(new Date(Date.UTC(year, 11, 28))).week;
}

export function weekBounds(year: number, week: number): WeekBounds {
  if (!Number.isInteger(week) || week < 1 || week > weeksInIsoYear(year)) {
    throw new Error(`ISO week out of range: ${year}-W${week}`);
  }
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4IsoDow = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const week1Monday = new Date(jan4.getTime() - (jan4IsoDow - 1) * DAY_MS);
  const since = new Date(week1Monday.getTime() + (week - 1) * 7 * DAY_MS);
  const until = new Date(since.getTime() + 7 * DAY_MS);
  return { since: since.toISOString(), until: until.toISOString() };
}

export function previousWeek(w: IsoWeek): IsoWeek {
  if (w.week > 1) return { year: w.year, week: w.week - 1 };
  const prevYear = w.year - 1;
  return { year: prevYear, week: weeksInIsoYear(prevYear) };
}

export function lastCompleteWeek(now: Date): IsoWeek {
  return previousWeek(isoWeekOf(now));
}

export function formatIsoWeek(w: IsoWeek): string {
  return `${w.year}-W${String(w.week).padStart(2, "0")}`;
}

export function parseIsoWeek(s: string): IsoWeek {
  const m = /^(\d{4})-W(\d{2})$/.exec(s);
  if (!m) throw new Error(`Invalid ISO week string: ${s}`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > weeksInIsoYear(year)) {
    throw new Error(`ISO week out of range: ${s}`);
  }
  return { year, week };
}
