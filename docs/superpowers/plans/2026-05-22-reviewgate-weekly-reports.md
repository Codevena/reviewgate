# Weekly Reports (`reviewgate report`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `reviewgate report` CLI command and an opt-in auto-snapshot that produce a per-ISO-week Markdown report with a week-over-week trend and a highlights section, built on the existing `src/stats/` pipeline.

**Architecture:** A thin pure ISO-week layer (`iso-week.ts`) + a pure weekly assembler (`weekly.ts`) that reuses `aggregate()` twice (target week + previous week), a Markdown renderer (`weekly-render.ts`), an I/O orchestration layer (`weekly-assemble.ts`) that loads both weeks and probes prior history, an atomic file writer (`report-file.ts`), the CLI command (`report.ts`), and an opt-in auto-snapshot (`snapshot.ts`) wired as the last trailing side-effect of the loop-driver iteration path. `loadAuditWindow` gains an exclusive `until` upper bound with partition-scoped scanning.

**Tech Stack:** Bun, TypeScript, Zod, `bun:test`. Runtime is Bun — use `bun`/`bunx`, `bun test`, `Bun.Glob`, `node:fs`, `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-05-22-reviewgate-weekly-reports-design.md` (Codex-reviewed → PASS).

**Conventions (read once):**
- Always run `bunx tsc --noEmit` AND `bun run lint` before considering a change done — both must be clean.
- Test files live in `tests/unit/` (named `*.test.ts`) and `tests/integration/` (`*-pipeline.test.ts`).
- Commits authored as the repo user — **never** add Claude attribution or `Co-Authored-By`.
- ISO timestamps are UTC ISO strings (`new Date(...).toISOString()`); lexicographic comparison of ISO strings equals chronological comparison.

---

## File Structure

**Create:**
- `src/stats/iso-week.ts` — pure ISO-8601 week math (UTC).
- `src/stats/weekly.ts` — `WeeklyReport`/`Delta` types + pure `buildWeeklyReport`.
- `src/stats/weekly-render.ts` — pure `renderWeeklyMarkdown`.
- `src/stats/weekly-assemble.ts` — I/O `assembleWeeklyReport` (loads both weeks, prior-history probe, windowed entries → calls `buildWeeklyReport`).
- `src/stats/report-file.ts` — `writeReportFile` (atomic temp + rename/link).
- `src/stats/snapshot.ts` — `maybeWriteWeeklySnapshot`.
- `src/cli/commands/report.ts` — `runReport`.
- Tests: `tests/unit/iso-week.test.ts`, `tests/unit/weekly-aggregate.test.ts`, `tests/unit/weekly-render.test.ts`, `tests/unit/weekly-assemble.test.ts`, `tests/unit/report-file.test.ts`, `tests/unit/weekly-snapshot.test.ts`, `tests/unit/report-cli.test.ts`, `tests/integration/weekly-report-pipeline.test.ts`.

**Modify:**
- `src/stats/load.ts` — add exclusive `until` + partition-scoped scan.
- `src/utils/paths.ts` — add `reportsDir`, `weekReportPath`.
- `src/config/define-config.ts` — add `weeklyReport` to `ConfigSchema`.
- `src/config/defaults.ts` — add `weeklyReport` default.
- `src/cli/commands/init.ts` — add commented `weeklyReport` line to the starter config.
- `src/cli/index.ts` — register the `report` command.
- `src/core/loop-driver.ts` — wire `maybeWriteWeeklySnapshot` as the trailing iteration-path side-effect.
- `tests/unit/stats-load.test.ts` — add `until` + partition-scope tests.

---

## Task 1: ISO-week math (`iso-week.ts`)

**Files:**
- Create: `src/stats/iso-week.ts`
- Test: `tests/unit/iso-week.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/iso-week.test.ts
import { describe, expect, it } from "bun:test";
import {
  formatIsoWeek,
  isoWeekOf,
  lastCompleteWeek,
  parseIsoWeek,
  previousWeek,
  weekBounds,
  weeksInIsoYear,
} from "../../src/stats/iso-week.ts";

describe("iso-week", () => {
  it("isoWeekOf uses the Thursday rule", () => {
    // 2026-01-01 is a Thursday → ISO week 2026-W01.
    expect(isoWeekOf(new Date("2026-01-01T12:00:00Z"))).toEqual({ year: 2026, week: 1 });
    // 2021-01-01 is a Friday → belongs to ISO week 2020-W53.
    expect(isoWeekOf(new Date("2021-01-01T12:00:00Z"))).toEqual({ year: 2020, week: 53 });
  });

  it("weekBounds is a half-open Monday→Monday UTC range", () => {
    expect(weekBounds(2026, 20)).toEqual({
      since: "2026-05-11T00:00:00.000Z",
      until: "2026-05-18T00:00:00.000Z",
    });
  });

  it("weeksInIsoYear returns 52 or 53", () => {
    expect(weeksInIsoYear(2026)).toBe(53);
    expect(weeksInIsoYear(2025)).toBe(52);
  });

  it("weekBounds AND parseIsoWeek reject out-of-range weeks", () => {
    expect(() => weekBounds(2026, 54)).toThrow();
    expect(() => weekBounds(2026, 0)).toThrow();
    expect(() => parseIsoWeek("2026-W54")).toThrow();
    expect(() => parseIsoWeek("2026-W00")).toThrow();
    expect(() => parseIsoWeek("garbage")).toThrow();
  });

  it("parse/format roundtrip", () => {
    expect(formatIsoWeek({ year: 2026, week: 20 })).toBe("2026-W20");
    expect(parseIsoWeek("2026-W20")).toEqual({ year: 2026, week: 20 });
    expect(parseIsoWeek("2026-W05")).toEqual({ year: 2026, week: 5 });
  });

  it("previousWeek of W01 rolls into the prior ISO year's last week", () => {
    expect(previousWeek({ year: 2026, week: 1 })).toEqual({ year: 2025, week: 52 });
    expect(previousWeek({ year: 2021, week: 1 })).toEqual({ year: 2020, week: 53 });
    expect(previousWeek({ year: 2026, week: 20 })).toEqual({ year: 2026, week: 19 });
  });

  it("lastCompleteWeek picks the ended week, even on a Sunday UTC", () => {
    // 2026-05-17 is the Sunday of 2026-W20 (still in progress). The last
    // COMPLETE week at that moment is W19.
    expect(lastCompleteWeek(new Date("2026-05-17T23:59:00Z"))).toEqual({ year: 2026, week: 19 });
    // Monday 2026-05-18 00:00 → W20 just ended.
    expect(lastCompleteWeek(new Date("2026-05-18T00:00:00Z"))).toEqual({ year: 2026, week: 20 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/iso-week.test.ts`
Expected: FAIL — `Cannot find module '../../src/stats/iso-week.ts'`.

- [ ] **Step 3: Implement `iso-week.ts`**

```ts
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

// The Thursday of the ISO week containing `date` (UTC). The ISO week-year is the
// year of that Thursday.
function thursdayOf(date: Date): Date {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  // getUTCDay: Sun=0..Sat=6. ISO day-of-week: Mon=1..Sun=7.
  const isoDow = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  // Shift to the Thursday (ISO day 4) of this week.
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
  // The ISO week of Dec 28 is always the last week of its ISO year.
  return isoWeekOf(new Date(Date.UTC(year, 11, 28))).week;
}

export function weekBounds(year: number, week: number): WeekBounds {
  if (!Number.isInteger(week) || week < 1 || week > weeksInIsoYear(year)) {
    throw new Error(`ISO week out of range: ${year}-W${week}`);
  }
  // Monday of ISO week 1 = the Monday of the week containing Jan 4.
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
  // The most recent week that has fully ended = the week before the current one.
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/iso-week.test.ts`
Expected: PASS (all assertions).

- [ ] **Step 5: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/stats/iso-week.ts tests/unit/iso-week.test.ts
git commit -m "feat(stats): pure ISO-8601 week math (iso-week.ts)"
```

---

## Task 2: `loadAuditWindow` exclusive `until` + partition-scoped scan

**Files:**
- Modify: `src/stats/load.ts`
- Test: `tests/unit/stats-load.test.ts` (add cases)

- [ ] **Step 1: Write the failing tests (append to the existing file)**

```ts
// Append inside tests/unit/stats-load.test.ts (it already imports loadAuditWindow,
// writes seeded audit files, and has a helper to create a temp repo — reuse them.
// If no helper exists, use the pattern below.)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "bun:test";
import { loadAuditWindow } from "../../src/stats/load.ts";

function seedRepo(): string {
  const root = join(tmpdir(), `rg-load-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function writeRun(root: string, ts: string, runId: string): void {
  const d = new Date(ts);
  const y = String(d.getUTCFullYear());
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const dir = join(root, ".reviewgate", "audit", y, m, day);
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    schema: "reviewgate.audit.v1",
    event: "run.complete",
    ts,
    run_id: runId,
    iter: 1,
    trigger: "stop-hook",
    run_summary: {
      verdict: "PASS",
      source: "panel",
      counts: { critical: 0, warn: 0, info: 0 },
      cost_usd: 0.01,
      duration_ms: 50,
      demoted: 0,
      signatures: [],
      providers: [],
    },
  });
  // Append into a single file in that day's partition.
  writeFileSync(join(dir, "120000.jsonl"), `${line}\n`, { flag: "a" });
}

function writeEscalation(root: string, ts: string): void {
  const d = new Date(ts);
  const y = String(d.getUTCFullYear());
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const dir = join(root, ".reviewgate", "audit", y, m, day);
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    schema: "reviewgate.audit.v1",
    event: "escalation",
    ts,
    run_id: "esc",
    iter: 1,
    trigger: "stop-hook",
  });
  writeFileSync(join(dir, "130000.jsonl"), `${line}\n`, { flag: "a" });
}

describe("loadAuditWindow until + partition scope", () => {
  it("until excludes runs and escalations at or after the bound", () => {
    const root = seedRepo();
    writeRun(root, "2026-05-11T10:00:00.000Z", "a"); // in window
    writeRun(root, "2026-05-18T10:00:00.000Z", "b"); // at/after until → excluded
    writeEscalation(root, "2026-05-12T10:00:00.000Z"); // in window
    writeEscalation(root, "2026-05-18T11:00:00.000Z"); // excluded
    const w = loadAuditWindow(root, {
      since: "2026-05-11T00:00:00.000Z",
      until: "2026-05-18T00:00:00.000Z",
    });
    expect(w.runs.map((r) => r.run_id)).toEqual(["a"]);
    expect(w.escalationCount).toBe(1);
  });

  it("finds an in-window run physically stored in the prior day's partition", () => {
    // Simulates AuditLogger's memoized path: a process started 2026-05-10 writes
    // a 2026-05-11 (in-window) event into the 2026-05-10 partition file.
    const root = seedRepo();
    const d = new Date("2026-05-10T23:00:00.000Z");
    const dir = join(
      root,
      ".reviewgate",
      "audit",
      String(d.getUTCFullYear()),
      String(d.getUTCMonth() + 1).padStart(2, "0"),
      String(d.getUTCDate()).padStart(2, "0"),
    );
    mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      schema: "reviewgate.audit.v1",
      event: "run.complete",
      ts: "2026-05-11T00:30:00.000Z", // in window
      run_id: "boundary",
      iter: 1,
      trigger: "stop-hook",
      run_summary: {
        verdict: "PASS",
        source: "panel",
        counts: { critical: 0, warn: 0, info: 0 },
        cost_usd: 0,
        duration_ms: 1,
        demoted: 0,
        signatures: [],
        providers: [],
      },
    });
    writeFileSync(join(dir, "230000.jsonl"), `${line}\n`);
    const w = loadAuditWindow(root, {
      since: "2026-05-11T00:00:00.000Z",
      until: "2026-05-18T00:00:00.000Z",
    });
    expect(w.runs.map((r) => r.run_id)).toEqual(["boundary"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/stats-load.test.ts`
Expected: FAIL — `until` is ignored (run `b`/escalation included) and/or the boundary run is missed.

- [ ] **Step 3: Modify `src/stats/load.ts`**

Replace the function body so it accepts `until`, filters both runs and escalations by it before `last`, and — when both `since` and `until` are present — scans only the day partitions overlapping `[since − 1 day, until]`.

```ts
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

const DAY_MS = 86_400_000;

// Relative `YYYY/MM/DD` day-dirs overlapping [since − 1 day, untilInclusiveDay].
// The −1-day guard recovers in-window events written into the prior day's
// partition by a process that crossed UTC midnight (AuditLogger memoizes its
// partition path for the whole process lifetime).
function dayDirsInRange(since: string, until: string): string[] {
  const startMs = new Date(since).getTime() - DAY_MS;
  const endMs = new Date(until).getTime(); // until's day is included (half-open ts filter still excludes >= until)
  const dirs: string[] = [];
  let cur = new Date(startMs);
  cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth(), cur.getUTCDate()));
  const end = new Date(endMs);
  const endDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  while (cur.getTime() <= endDay.getTime()) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, "0");
    const d = String(cur.getUTCDate()).padStart(2, "0");
    dirs.push(`${y}/${m}/${d}`);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dirs;
}

function collectFiles(dir: string, since?: string, until?: string): string[] {
  // Partition-scoped scan when a closed [since, until) window is requested.
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
  // Full-history scan (since-only / last / unbounded) — unchanged behavior.
  const glob = new Bun.Glob("**/*.jsonl");
  return [...glob.scanSync({ cwd: dir })];
}

export function loadAuditWindow(
  repoRoot: string,
  opts: { since?: string; until?: string; last?: number },
): AuditWindow {
  const dir = auditDir(repoRoot);
  if (!existsSync(dir)) {
    return { runs: [], escalationCount: 0 };
  }

  const runs: LoadedRun[] = [];
  const escalations: { ts: string }[] = [];

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
      }
    }
  }

  runs.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  const { since, until, last } = opts;
  // Apply since (>=) and until (<, exclusive) to BOTH runs and escalations,
  // BEFORE any `last` narrowing.
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

  return {
    runs: windowedRuns,
    escalationCount: escalationsInWindow.length,
  };
}
```

- [ ] **Step 4: Run the full load test file to verify pass + no regressions**

Run: `bun test tests/unit/stats-load.test.ts`
Expected: PASS — new cases pass, all pre-existing `since`/`last` cases still pass.

- [ ] **Step 5: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/stats/load.ts tests/unit/stats-load.test.ts
git commit -m "feat(stats): loadAuditWindow exclusive until + partition-scoped scan"
```

---

## Task 3: Pure `buildWeeklyReport` (`weekly.ts`)

**Files:**
- Create: `src/stats/weekly.ts`
- Test: `tests/unit/weekly-aggregate.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/weekly-aggregate.test.ts
import { describe, expect, it } from "bun:test";
import type { StatsReport } from "../../src/stats/aggregate.ts";
import { buildWeeklyReport } from "../../src/stats/weekly.ts";
import type { WeeklyBuildArgs } from "../../src/stats/weekly.ts";
import type { FpLedgerEntry } from "../../src/schemas/fp-ledger.ts";
import type { BrainEntry } from "../../src/schemas/brain.ts";

function emptyStats(overrides: Partial<StatsReport> = {}): StatsReport {
  return {
    window: { runCount: 0, firstTs: null, lastTs: null, bySource: { panel: 0, cache: 0, skipped: 0 } },
    verdicts: { PASS: 0, "SOFT-PASS": 0, FAIL: 0, ERROR: 0 },
    escalationRate: 0,
    cost: { total: 0, avgPerRun: 0, perProvider: {} },
    providers: [],
    topSignatures: [],
    fpLedger: { active: 0, sticky: 0, candidate: 0, perProviderConfirmed: {} },
    brain: { byStatus: {}, byType: {} },
    ...overrides,
  };
}

function baseArgs(overrides: Partial<WeeklyBuildArgs> = {}): WeeklyBuildArgs {
  return {
    weekIso: "2026-W20",
    bounds: { since: "2026-05-11T00:00:00.000Z", until: "2026-05-18T00:00:00.000Z" },
    previousWeekIso: "2026-W19",
    currentSignatures: new Map(),
    previousSignatures: new Map(),
    windowedFpEntries: [],
    windowedBrainEntries: [],
    generatedAt: "2026-05-25T09:00:00.000Z",
    now: new Date("2026-05-25T09:00:00.000Z"),
    ...overrides,
  };
}

describe("buildWeeklyReport", () => {
  it("computes runCount/cost/escalation/verdict deltas vs previous week", () => {
    const current = emptyStats({
      window: { runCount: 12, firstTs: null, lastTs: null, bySource: { panel: 12, cache: 0, skipped: 0 } },
      verdicts: { PASS: 10, "SOFT-PASS": 0, FAIL: 2, ERROR: 0 },
      escalationRate: 0.1,
      cost: { total: 0.84, avgPerRun: 0.07, perProvider: {} },
    });
    const previous = emptyStats({
      window: { runCount: 15, firstTs: null, lastTs: null, bySource: { panel: 15, cache: 0, skipped: 0 } },
      verdicts: { PASS: 14, "SOFT-PASS": 0, FAIL: 1, ERROR: 0 },
      escalationRate: 0.06,
      cost: { total: 0.71, avgPerRun: 0.047, perProvider: {} },
    });
    const r = buildWeeklyReport(current, previous, baseArgs());
    expect(r.previousWeek).toEqual({ iso: "2026-W19" });
    expect(r.trend?.runCount).toEqual({ current: 12, previous: 15, abs: -3 });
    expect(r.trend?.cost.abs).toBeCloseTo(0.13, 5);
    expect(r.trend?.verdicts.FAIL).toEqual({ current: 2, previous: 1, abs: 1 });
    expect(r.meta.status).toBe("complete"); // until <= now
  });

  it("treats null previous as a first report (trend null)", () => {
    const r = buildWeeklyReport(emptyStats({ window: { runCount: 3, firstTs: null, lastTs: null, bySource: { panel: 3, cache: 0, skipped: 0 } } }), null, baseArgs());
    expect(r.previousWeek).toBeNull();
    expect(r.trend).toBeNull();
  });

  it("a zero-run previous week is a valid baseline (not first report)", () => {
    const current = emptyStats({ window: { runCount: 12, firstTs: null, lastTs: null, bySource: { panel: 12, cache: 0, skipped: 0 } } });
    const r = buildWeeklyReport(current, emptyStats(), baseArgs());
    expect(r.previousWeek).toEqual({ iso: "2026-W19" });
    expect(r.trend?.runCount).toEqual({ current: 12, previous: 0, abs: 12 });
  });

  it("providerErrorRate unions providers across both weeks", () => {
    const current = emptyStats({
      providers: [{ provider: "codex", runs: 4, findings: 0, demoteRate: 0, errorRate: 0.25, avgDurationMs: 10, cost: 0 }],
    });
    const previous = emptyStats({
      providers: [{ provider: "gemini", runs: 2, findings: 0, demoteRate: 0, errorRate: 0.5, avgDurationMs: 10, cost: 0 }],
    });
    const r = buildWeeklyReport(current, previous, baseArgs());
    const byProvider = Object.fromEntries((r.trend?.providerErrorRate ?? []).map((p) => [p.provider, p.delta]));
    expect(byProvider.codex).toEqual({ current: 0.25, previous: 0, abs: 0.25 });
    expect(byProvider.gemini).toEqual({ current: 0, previous: 0.5, abs: -0.5 });
  });

  it("newSignatures = current signatures absent from previous (beyond top-10)", () => {
    const current = new Map<string, number>([["sig-new", 3], ["sig-old", 1]]);
    const previous = new Map<string, number>([["sig-old", 5]]);
    const r = buildWeeklyReport(emptyStats({ window: { runCount: 1, firstTs: null, lastTs: null, bySource: { panel: 1, cache: 0, skipped: 0 } } }), emptyStats(), baseArgs({ currentSignatures: current, previousSignatures: previous }));
    expect(r.highlights.newSignatures).toEqual([{ signature: "sig-new", count: 3 }]);
  });

  it("windows FP highlights by first_seen_at with distinct sorted providers", () => {
    const fp = (id: string, firstSeen: string, providers: string[]): FpLedgerEntry => ({
      id, signature: `sig-${id}`, rule_id: "r", category: "security", file: "a.ts", symbol: "f",
      stage: "active", rejects: providers.map((p) => ({ run_id: "x", provider: p, ts: firstSeen, reason: "r" })),
      distinct_providers: providers, first_seen_at: firstSeen, last_seen_at: firstSeen, created_at: firstSeen,
    });
    const inWeek = fp("1", "2026-05-12T00:00:00.000Z", ["gemini", "codex", "codex"]);
    const outWeek = fp("2", "2026-05-01T00:00:00.000Z", ["codex"]);
    const r = buildWeeklyReport(emptyStats({ window: { runCount: 1, firstTs: null, lastTs: null, bySource: { panel: 1, cache: 0, skipped: 0 } } }), emptyStats(), baseArgs({ windowedFpEntries: [inWeek, outWeek] }));
    // NOTE: assemble layer normally pre-filters; buildWeeklyReport also filters defensively by bounds.
    expect(r.highlights.newFpSignatures).toEqual([{ signature: "sig-1", stage: "active", providers: ["codex", "gemini"] }]);
  });

  it("status = partial when now is inside the week, with generatedThrough", () => {
    const r = buildWeeklyReport(emptyStats({ window: { runCount: 2, firstTs: null, lastTs: null, bySource: { panel: 2, cache: 0, skipped: 0 } } }), emptyStats(), baseArgs({
      now: new Date("2026-05-14T12:00:00.000Z"),
      generatedAt: "2026-05-14T12:00:00.000Z",
    }));
    expect(r.meta.status).toBe("partial");
    expect(r.meta.generatedThrough).toBe("2026-05-14T12:00:00.000Z");
  });

  it("status = future when the week is entirely after now", () => {
    const r = buildWeeklyReport(emptyStats(), null, baseArgs({ now: new Date("2026-01-01T00:00:00.000Z"), generatedAt: "2026-01-01T00:00:00.000Z" }));
    expect(r.meta.status).toBe("future");
    expect(r.meta.generatedThrough).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/weekly-aggregate.test.ts`
Expected: FAIL — `Cannot find module '../../src/stats/weekly.ts'`.

- [ ] **Step 3: Implement `weekly.ts`**

```ts
// src/stats/weekly.ts
// Pure weekly-report assembly: deltas + highlights. No I/O, no Date.now().
import type { StatsReport } from "./aggregate.ts";
import type { FpLedgerEntry } from "../schemas/fp-ledger.ts";
import type { BrainEntry } from "../schemas/brain.ts";

export interface Delta {
  current: number;
  previous: number;
  abs: number;
}

export interface WeeklyReport {
  meta: {
    generatedAt: string;
    fpBrainReflect: "generation-time";
    status: "complete" | "partial" | "future";
    generatedThrough: string | null;
  };
  week: { iso: string; since: string; until: string };
  previousWeek: { iso: string } | null;
  current: StatsReport;
  trend: {
    runCount: Delta;
    cost: Delta;
    escalationRate: Delta;
    verdicts: Record<"PASS" | "SOFT-PASS" | "FAIL" | "ERROR", Delta>;
    providerErrorRate: { provider: string; delta: Delta }[];
  } | null;
  highlights: {
    newFpSignatures: { signature: string; stage: string; providers: string[] }[];
    newBrainEntries: { id: string; type: string; status: string }[];
    topCostProviders: { provider: string; cost: number }[];
    newSignatures: { signature: string; count: number }[];
  };
}

export interface WeeklyBuildArgs {
  weekIso: string;
  bounds: { since: string; until: string };
  previousWeekIso: string;
  currentSignatures: Map<string, number>;
  previousSignatures: Map<string, number>;
  windowedFpEntries: FpLedgerEntry[];
  windowedBrainEntries: BrainEntry[];
  generatedAt: string;
  now: Date;
}

const HIGHLIGHT_CAP = 20;

function delta(current: number, previous: number): Delta {
  return { current, previous, abs: current - previous };
}

function weekStatus(
  now: Date,
  bounds: { since: string; until: string },
  generatedAt: string,
): { status: "complete" | "partial" | "future"; generatedThrough: string | null } {
  const nowMs = now.getTime();
  const sinceMs = new Date(bounds.since).getTime();
  const untilMs = new Date(bounds.until).getTime();
  if (untilMs <= nowMs) return { status: "complete", generatedThrough: null };
  if (sinceMs <= nowMs) return { status: "partial", generatedThrough: generatedAt };
  return { status: "future", generatedThrough: null };
}

export function buildWeeklyReport(
  current: StatsReport,
  previous: StatsReport | null,
  args: WeeklyBuildArgs,
): WeeklyReport {
  const { status, generatedThrough } = weekStatus(args.now, args.bounds, args.generatedAt);

  let trend: WeeklyReport["trend"] = null;
  if (previous !== null) {
    const verdictKeys = ["PASS", "SOFT-PASS", "FAIL", "ERROR"] as const;
    const verdicts = Object.fromEntries(
      verdictKeys.map((k) => [k, delta(current.verdicts[k], previous.verdicts[k])]),
    ) as Record<(typeof verdictKeys)[number], Delta>;

    const errCur = new Map(current.providers.map((p) => [p.provider, p.errorRate]));
    const errPrev = new Map(previous.providers.map((p) => [p.provider, p.errorRate]));
    const providerErrorRate = [...new Set([...errCur.keys(), ...errPrev.keys()])]
      .sort()
      .map((provider) => ({
        provider,
        delta: delta(errCur.get(provider) ?? 0, errPrev.get(provider) ?? 0),
      }));

    trend = {
      runCount: delta(current.window.runCount, previous.window.runCount),
      cost: delta(current.cost.total, previous.cost.total),
      escalationRate: delta(current.escalationRate, previous.escalationRate),
      verdicts,
      providerErrorRate,
    };
  }

  const sinceMs = new Date(args.bounds.since).getTime();
  const untilMs = new Date(args.bounds.until).getTime();
  const inWindow = (ts: string): boolean => {
    const t = new Date(ts).getTime();
    return t >= sinceMs && t < untilMs;
  };

  const newFpSignatures = args.windowedFpEntries
    .filter((e) => inWindow(e.first_seen_at))
    .sort((a, b) => (a.first_seen_at < b.first_seen_at ? 1 : a.first_seen_at > b.first_seen_at ? -1 : 0))
    .slice(0, HIGHLIGHT_CAP)
    .map((e) => ({
      signature: e.signature,
      stage: e.stage,
      providers: [...new Set(e.rejects.map((r) => r.provider))].sort(),
    }));

  const newBrainEntries = args.windowedBrainEntries
    .filter((e) => inWindow(e.created_at))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .slice(0, HIGHLIGHT_CAP)
    .map((e) => ({ id: e.id, type: e.type, status: e.status }));

  const topCostProviders = Object.entries(current.cost.perProvider)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([provider, cost]) => ({ provider, cost }));

  const newSignatures = [...args.currentSignatures.entries()]
    .filter(([sig]) => !args.previousSignatures.has(sig))
    .sort(([sigA, a], [sigB, b]) => (b !== a ? b - a : sigA < sigB ? -1 : 1))
    .map(([signature, count]) => ({ signature, count }));

  return {
    meta: { generatedAt: args.generatedAt, fpBrainReflect: "generation-time", status, generatedThrough },
    week: { iso: args.weekIso, since: args.bounds.since, until: args.bounds.until },
    previousWeek: previous !== null ? { iso: args.previousWeekIso } : null,
    current,
    trend,
    highlights: { newFpSignatures, newBrainEntries, topCostProviders, newSignatures },
  };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/unit/weekly-aggregate.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/stats/weekly.ts tests/unit/weekly-aggregate.test.ts
git commit -m "feat(stats): pure buildWeeklyReport (deltas + highlights)"
```

---

## Task 4: Markdown renderer (`weekly-render.ts`)

**Files:**
- Create: `src/stats/weekly-render.ts`
- Test: `tests/unit/weekly-render.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/weekly-render.test.ts
import { describe, expect, it } from "bun:test";
import { renderWeeklyMarkdown } from "../../src/stats/weekly-render.ts";
import type { WeeklyReport } from "../../src/stats/weekly.ts";

function baseReport(overrides: Partial<WeeklyReport> = {}): WeeklyReport {
  const emptyStats = {
    window: { runCount: 12, firstTs: null, lastTs: null, bySource: { panel: 12, cache: 0, skipped: 0 } },
    verdicts: { PASS: 10, "SOFT-PASS": 0, FAIL: 2, ERROR: 0 },
    escalationRate: 0.1,
    cost: { total: 0.84, avgPerRun: 0.07, perProvider: { codex: 0.84 } },
    providers: [{ provider: "codex", runs: 12, findings: 4, demoteRate: 0, errorRate: 0, avgDurationMs: 1000, cost: 0.84 }],
    topSignatures: [],
    fpLedger: { active: 1, sticky: 0, candidate: 0, perProviderConfirmed: {} },
    brain: { byStatus: {}, byType: {} },
  };
  return {
    meta: { generatedAt: "2026-05-25T09:00:00.000Z", fpBrainReflect: "generation-time", status: "complete", generatedThrough: null },
    week: { iso: "2026-W20", since: "2026-05-11T00:00:00.000Z", until: "2026-05-18T00:00:00.000Z" },
    previousWeek: { iso: "2026-W19" },
    current: emptyStats,
    trend: {
      runCount: { current: 12, previous: 15, abs: -3 },
      cost: { current: 0.84, previous: 0.71, abs: 0.13 },
      escalationRate: { current: 0.1, previous: 0.06, abs: 0.04 },
      verdicts: { PASS: { current: 10, previous: 14, abs: -4 }, "SOFT-PASS": { current: 0, previous: 0, abs: 0 }, FAIL: { current: 2, previous: 1, abs: 1 }, ERROR: { current: 0, previous: 0, abs: 0 } },
      providerErrorRate: [{ provider: "codex", delta: { current: 0, previous: 0, abs: 0 } }],
    },
    highlights: { newFpSignatures: [], newBrainEntries: [], topCostProviders: [{ provider: "codex", cost: 0.84 }], newSignatures: [] },
    ...overrides,
  };
}

describe("renderWeeklyMarkdown", () => {
  it("renders a header, summary table with trend arrows, and the FP/brain caveat", () => {
    const md = renderWeeklyMarkdown(baseReport());
    expect(md).toContain("# Reviewgate Weekly Report — 2026-W20");
    expect(md).toContain("▼"); // runCount decreased
    expect(md).toContain("▲"); // cost increased
    expect(md.toLowerCase()).toContain("reflect current state");
  });

  it("renders a first-report note and omits the trend when previousWeek is null", () => {
    const md = renderWeeklyMarkdown(baseReport({ previousWeek: null, trend: null }));
    expect(md.toLowerCase()).toContain("first report");
    expect(md).not.toContain("▼");
  });

  it("renders an in-progress banner for a partial week", () => {
    const md = renderWeeklyMarkdown(baseReport({ meta: { generatedAt: "2026-05-14T12:00:00.000Z", fpBrainReflect: "generation-time", status: "partial", generatedThrough: "2026-05-14T12:00:00.000Z" } }));
    expect(md).toContain("in progress");
    expect(md).toContain("2026-05-14T12:00:00.000Z");
  });

  it("renders a zero-run note for an empty/future week", () => {
    const zero = baseReport({
      current: { ...baseReport().current, window: { runCount: 0, firstTs: null, lastTs: null, bySource: { panel: 0, cache: 0, skipped: 0 } } },
      meta: { generatedAt: "2026-01-01T00:00:00.000Z", fpBrainReflect: "generation-time", status: "future", generatedThrough: null },
      previousWeek: null,
      trend: null,
    });
    expect(renderWeeklyMarkdown(zero)).toContain("no runs in 2026-W20");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/weekly-render.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `weekly-render.ts`**

```ts
// src/stats/weekly-render.ts
import type { Delta, WeeklyReport } from "./weekly.ts";

function arrow(abs: number): string {
  if (abs > 0) return "▲";
  if (abs < 0) return "▼";
  return "▬";
}

function deltaCell(d: Delta, fmt: (n: number) => string): string {
  const sign = d.abs > 0 ? "+" : "";
  return `${arrow(d.abs)} ${sign}${fmt(d.abs)}`;
}

const num = (n: number): string => `${n}`;
const usd = (n: number): string => `$${n.toFixed(4)}`;
const pp = (n: number): string => `${(n * 100).toFixed(1)}pp`;
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

export function renderWeeklyMarkdown(r: WeeklyReport): string {
  const lines: string[] = [];
  lines.push(`# Reviewgate Weekly Report — ${r.week.iso}`);
  const range = `${r.week.since.slice(0, 10)} → ${new Date(new Date(r.week.until).getTime() - 1).toISOString().slice(0, 10)}`;
  const sub = r.previousWeek ? `${range} · vs ${r.previousWeek.iso}` : `${range} · first report`;
  lines.push(`_${sub}_`);
  lines.push("");

  if (r.meta.status === "partial") {
    lines.push(`> ⚠ in progress — week-to-date through ${r.meta.generatedThrough}`);
    lines.push("");
  }

  if (r.current.window.runCount === 0) {
    lines.push(`No runs in ${r.week.iso}.`.replace("No runs", "no runs"));
    lines.push("");
    lines.push("_FP-ledger / brain figures reflect current state, not historical week-state._");
    return `${lines.join("\n")}\n`;
  }

  // Summary
  lines.push("## Summary");
  lines.push("");
  if (r.trend) {
    lines.push("| Metric | This week | Prev week | Δ |");
    lines.push("| --- | --- | --- | --- |");
    lines.push(`| Runs | ${r.current.window.runCount} | ${r.trend.runCount.previous} | ${deltaCell(r.trend.runCount, num)} |`);
    lines.push(`| Cost | ${usd(r.current.cost.total)} | ${usd(r.trend.cost.previous)} | ${deltaCell(r.trend.cost, usd)} |`);
    lines.push(`| Escalation rate | ${pct(r.current.escalationRate)} | ${pct(r.trend.escalationRate.previous)} | ${arrow(r.trend.escalationRate.abs)} ${r.trend.escalationRate.abs > 0 ? "+" : ""}${pp(r.trend.escalationRate.abs)} |`);
  } else {
    lines.push("| Metric | This week |");
    lines.push("| --- | --- |");
    lines.push(`| Runs | ${r.current.window.runCount} |`);
    lines.push(`| Cost | ${usd(r.current.cost.total)} |`);
    lines.push(`| Escalation rate | ${pct(r.current.escalationRate)} |`);
  }
  lines.push("");

  // Verdicts
  lines.push("## Verdicts");
  lines.push("");
  for (const v of ["PASS", "SOFT-PASS", "FAIL", "ERROR"] as const) {
    const count = r.current.verdicts[v];
    if (count === 0 && !(r.trend && r.trend.verdicts[v].previous > 0)) continue;
    const d = r.trend ? `  (${deltaCell(r.trend.verdicts[v], num)})` : "";
    lines.push(`- ${v}: ${count}${d}`);
  }
  lines.push("");

  // Reviewers
  lines.push("## Reviewers");
  lines.push("");
  if (r.trend && r.trend.providerErrorRate.length > 0) {
    lines.push("| Provider | Error rate | Δ |");
    lines.push("| --- | --- | --- |");
    const cur = new Map(r.current.providers.map((p) => [p.provider, p.errorRate]));
    for (const { provider, delta } of r.trend.providerErrorRate) {
      lines.push(`| ${provider} | ${pct(cur.get(provider) ?? 0)} | ${arrow(delta.abs)} ${delta.abs > 0 ? "+" : ""}${pp(delta.abs)} |`);
    }
  } else {
    for (const p of r.current.providers) {
      lines.push(`- ${p.provider}: error rate ${pct(p.errorRate)}, ${p.runs} run(s)`);
    }
  }
  lines.push("");

  // Highlights
  lines.push("## Highlights");
  lines.push("");
  const h = r.highlights;
  if (h.newSignatures.length > 0) {
    lines.push("**New signatures this week:**");
    for (const s of h.newSignatures.slice(0, 10)) lines.push(`- ${s.count}× ${s.signature}`);
    lines.push("");
  }
  if (h.topCostProviders.length > 0) {
    lines.push("**Top cost drivers:**");
    for (const c of h.topCostProviders) lines.push(`- ${c.provider}: ${usd(c.cost)}`);
    lines.push("");
  }
  if (h.newFpSignatures.length > 0) {
    lines.push("**New false-positive entries (first seen this week):**");
    for (const f of h.newFpSignatures) lines.push(`- [${f.stage}] ${f.signature} (${f.providers.join(", ")})`);
    lines.push("");
  }
  if (h.newBrainEntries.length > 0) {
    lines.push("**New brain memories (created this week):**");
    for (const b of h.newBrainEntries) lines.push(`- [${b.status}/${b.type}] ${b.id}`);
    lines.push("");
  }

  lines.push("_FP-ledger / brain figures reflect current state, not historical week-state._");
  return `${lines.join("\n")}\n`;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/unit/weekly-render.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/stats/weekly-render.ts tests/unit/weekly-render.test.ts
git commit -m "feat(stats): weekly-render markdown renderer"
```

---

## Task 5: Paths helpers (`reportsDir`, `weekReportPath`)

**Files:**
- Modify: `src/utils/paths.ts`

- [ ] **Step 1: Add the helpers**

Append to `src/utils/paths.ts` (after the existing `auditDir` export):

```ts
export function reportsDir(repoRoot: string): string {
  return join(reviewgateDir(repoRoot), "reports");
}

export function weekReportPath(repoRoot: string, iso: string): string {
  return join(reportsDir(repoRoot), `${iso}.md`);
}
```

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`
Expected: clean (these are referenced by later tasks).

- [ ] **Step 3: Commit**

```bash
git add src/utils/paths.ts
git commit -m "feat(stats): reportsDir + weekReportPath path helpers"
```

---

## Task 6: Atomic report file writer (`report-file.ts`)

**Files:**
- Create: `src/stats/report-file.ts`
- Test: `tests/unit/report-file.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/report-file.test.ts
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { writeReportFile } from "../../src/stats/report-file.ts";

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-rf-"));
  return join(dir, "nested", "2026-W20.md"); // nested dir must be created
}

describe("writeReportFile", () => {
  it("creates the dir and writes the content (overwrite mode)", () => {
    const p = tmpFile();
    writeReportFile(p, "hello", { exclusive: false });
    expect(readFileSync(p, "utf8")).toBe("hello");
    writeReportFile(p, "world", { exclusive: false });
    expect(readFileSync(p, "utf8")).toBe("world"); // overwrote
  });

  it("exclusive mode creates if absent and refuses to overwrite", () => {
    const p = tmpFile();
    expect(writeReportFile(p, "first", { exclusive: true })).toBe(true);
    expect(writeReportFile(p, "second", { exclusive: true })).toBe(false); // EEXIST → no-op
    expect(readFileSync(p, "utf8")).toBe("first");
  });

  it("leaves no temp files behind", () => {
    const p = tmpFile();
    writeReportFile(p, "x", { exclusive: true });
    const dir = join(p, "..");
    const leftovers = [...new Bun.Glob("*.tmp").scanSync({ cwd: dir })];
    expect(leftovers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/report-file.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `report-file.ts`**

```ts
// src/stats/report-file.ts
import { existsSync, linkSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Writes `content` to `path` atomically via a unique temp file.
//  - exclusive:false → renameSync (atomic overwrite). Always returns true.
//  - exclusive:true  → linkSync+unlink (atomic create-if-absent). Returns false
//    (no-op) if the final file already exists; never overwrites a concurrent writer.
// Never leaves a partial final file: rename/link are atomic; the temp is removed
// in a finally.
export function writeReportFile(
  path: string,
  content: string,
  opts: { exclusive: boolean },
): boolean {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  if (opts.exclusive && existsSync(path)) return false;

  const tmp = join(dir, `.${crypto.randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, content, { mode: 0o600 });
    if (opts.exclusive) {
      try {
        linkSync(tmp, path); // atomic; throws EEXIST if path exists
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw err;
      }
    }
    renameSync(tmp, path); // atomic overwrite
    return true;
  } finally {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* best-effort temp cleanup */
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/unit/report-file.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/stats/report-file.ts tests/unit/report-file.test.ts
git commit -m "feat(stats): atomic writeReportFile (overwrite + exclusive create)"
```

---

## Task 7: I/O orchestration (`weekly-assemble.ts`)

**Files:**
- Create: `src/stats/weekly-assemble.ts`
- Test: `tests/unit/weekly-assemble.test.ts`

This loads the target week + previous week from the audit log, probes prior history (directory-existence, no parse), builds signature maps, loads FP/brain snapshots, and calls `buildWeeklyReport`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/weekly-assemble.test.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { assembleWeeklyReport } from "../../src/stats/weekly-assemble.ts";

function seedRepo(): string {
  const root = join(tmpdir(), `rg-asm-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function writeRun(root: string, ts: string, verdict: string, signatures: string[]): void {
  const d = new Date(ts);
  const dir = join(root, ".reviewgate", "audit", String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    schema: "reviewgate.audit.v1", event: "run.complete", ts, run_id: ts, iter: 1, trigger: "stop-hook",
    run_summary: { verdict, source: "panel", counts: { critical: 0, warn: 0, info: 0 }, cost_usd: 0.05, duration_ms: 10, demoted: 0, signatures, providers: [] },
  });
  writeFileSync(join(dir, `${d.getUTCHours()}0000.jsonl`), `${line}\n`, { flag: "a" });
}

describe("assembleWeeklyReport", () => {
  it("computes trend vs the previous week and diffs new signatures", async () => {
    const root = seedRepo();
    // W19 (prev): 2026-05-04 .. 2026-05-11
    writeRun(root, "2026-05-05T10:00:00.000Z", "PASS", ["sig-old"]);
    // W20 (target): 2026-05-11 .. 2026-05-18
    writeRun(root, "2026-05-12T10:00:00.000Z", "FAIL", ["sig-new"]);
    writeRun(root, "2026-05-13T10:00:00.000Z", "PASS", ["sig-old"]);
    const report = await assembleWeeklyReport(root, { year: 2026, week: 20 }, { now: new Date("2026-05-25T00:00:00.000Z") });
    expect(report.week.iso).toBe("2026-W20");
    expect(report.previousWeek).toEqual({ iso: "2026-W19" });
    expect(report.current.window.runCount).toBe(2);
    expect(report.trend?.runCount).toEqual({ current: 2, previous: 1, abs: 1 });
    expect(report.highlights.newSignatures).toEqual([{ signature: "sig-new", count: 1 }]);
  });

  it("treats a no-history week as a first report (trend null)", async () => {
    const root = seedRepo();
    writeRun(root, "2026-05-12T10:00:00.000Z", "PASS", []);
    const report = await assembleWeeklyReport(root, { year: 2026, week: 20 }, { now: new Date("2026-05-25T00:00:00.000Z") });
    expect(report.previousWeek).toBeNull();
    expect(report.trend).toBeNull();
  });

  it("a quiet previous week with older history is a zero baseline, not a first report", async () => {
    const root = seedRepo();
    writeRun(root, "2026-04-20T10:00:00.000Z", "PASS", []); // older history, weeks before
    writeRun(root, "2026-05-12T10:00:00.000Z", "PASS", []); // target W20; W19 empty
    const report = await assembleWeeklyReport(root, { year: 2026, week: 20 }, { now: new Date("2026-05-25T00:00:00.000Z") });
    expect(report.previousWeek).toEqual({ iso: "2026-W19" });
    expect(report.trend?.runCount).toEqual({ current: 1, previous: 0, abs: 1 });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/weekly-assemble.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `weekly-assemble.ts`**

```ts
// src/stats/weekly-assemble.ts
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BrainStore } from "../core/brain/store.ts";
import { FpLedgerStore } from "../core/fp-ledger/store.ts";
import type { BrainEntryLite, FpEntryLite } from "./aggregate.ts";
import { aggregate } from "./aggregate.ts";
import { formatIsoWeek, previousWeek, weekBounds } from "./iso-week.ts";
import type { IsoWeek } from "./iso-week.ts";
import { loadAuditWindow } from "./load.ts";
import type { LoadedRun } from "./load.ts";
import { auditDir } from "../utils/paths.ts";
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
  const prevWindow = loadAuditWindow(repoRoot, { since: prevBounds.since, until: prevBounds.until });

  const fpSnap = await new FpLedgerStore(repoRoot).snapshot();
  const brainSnap = await new BrainStore(repoRoot).snapshot();

  const fpLite: FpEntryLite[] = fpSnap.entries.map((e) => ({
    stage: e.stage,
    rejects: e.rejects.map((r) => ({ provider: r.provider })),
  }));
  const brainLite: BrainEntryLite[] = brainSnap.entries.map((e) => ({ status: e.status, type: e.type }));

  const current = aggregate(curWindow.runs, curWindow.escalationCount, fpLite, brainLite);

  const hasPriorHistory =
    prevWindow.runs.length > 0 || hasPartitionBefore(repoRoot, bounds.since);
  const previous = hasPriorHistory
    ? aggregate(prevWindow.runs, prevWindow.escalationCount, fpLite, brainLite)
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
```

> Note: `buildWeeklyReport` already filters FP/brain entries to `[since, until)` defensively, so passing the full snapshots is correct. The lite FP/brain shapes feed `aggregate()` (live-state counts), matching `stats`.

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/unit/weekly-assemble.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/stats/weekly-assemble.ts tests/unit/weekly-assemble.test.ts
git commit -m "feat(stats): assembleWeeklyReport I/O orchestration (loads both weeks + prior-history probe)"
```

---

## Task 8: CLI command (`report.ts`) + register in `index.ts`

**Files:**
- Create: `src/cli/commands/report.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/unit/report-cli.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/report-cli.test.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { runReport } from "../../src/cli/commands/report.ts";

function seedRepo(): string {
  const root = join(tmpdir(), `rg-rep-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return root;
}
function writeRun(root: string, ts: string): void {
  const d = new Date(ts);
  const dir = join(root, ".reviewgate", "audit", String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ schema: "reviewgate.audit.v1", event: "run.complete", ts, run_id: ts, iter: 1, trigger: "stop-hook", run_summary: { verdict: "PASS", source: "panel", counts: { critical: 0, warn: 0, info: 0 }, cost_usd: 0.01, duration_ms: 10, demoted: 0, signatures: [], providers: [] } });
  writeFileSync(join(dir, "100000.jsonl"), `${line}\n`, { flag: "a" });
}

describe("runReport", () => {
  it("writes a markdown file for an explicit complete week and returns markdown", async () => {
    const root = seedRepo();
    writeRun(root, "2026-05-12T10:00:00.000Z");
    const out = await runReport({ repoRoot: root, week: "2026-W20", now: new Date("2026-05-25T00:00:00.000Z") });
    expect(out).toContain("# Reviewgate Weekly Report — 2026-W20");
    expect(existsSync(join(root, ".reviewgate", "reports", "2026-W20.md"))).toBe(true);
  });

  it("--json returns JSON and writes NO file", async () => {
    const root = seedRepo();
    writeRun(root, "2026-05-12T10:00:00.000Z");
    const out = await runReport({ repoRoot: root, week: "2026-W20", json: true, now: new Date("2026-05-25T00:00:00.000Z") });
    expect(JSON.parse(out).week.iso).toBe("2026-W20");
    expect(existsSync(join(root, ".reviewgate", "reports", "2026-W20.md"))).toBe(false);
  });

  it("a current in-progress week renders the partial banner", async () => {
    const root = seedRepo();
    writeRun(root, "2026-05-12T10:00:00.000Z");
    const out = await runReport({ repoRoot: root, week: "2026-W20", now: new Date("2026-05-13T12:00:00.000Z") });
    expect(out).toContain("in progress");
  });

  it("rejects a malformed week string", async () => {
    const root = seedRepo();
    await expect(runReport({ repoRoot: root, week: "garbage", now: new Date() })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/report-cli.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `report.ts`**

```ts
// src/cli/commands/report.ts
import { lastCompleteWeek, parseIsoWeek } from "../../stats/iso-week.ts";
import { weekReportPath } from "../../utils/paths.ts";
import { writeReportFile } from "../../stats/report-file.ts";
import { assembleWeeklyReport } from "../../stats/weekly-assemble.ts";
import { renderWeeklyMarkdown } from "../../stats/weekly-render.ts";

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
    return JSON.stringify(report, null, 2); // --json: stdout only, no file
  }

  const md = renderWeeklyMarkdown(report);
  // Explicit user command always (re-)renders and overwrites.
  writeReportFile(weekReportPath(input.repoRoot, report.week.iso), md, { exclusive: false });
  return md;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/unit/report-cli.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the command in `src/cli/index.ts`**

Add the import near the other command imports (after the `runStats` import line):

```ts
import { runReport } from "./commands/report.ts";
```

Add the command definition next to the `stats` command (before the `main` definition):

```ts
const report = defineCommand({
  meta: {
    name: "report",
    description: "Generate a weekly review report (Markdown + .reviewgate/reports/<iso>.md)",
  },
  args: { week: { type: "string" }, json: { type: "boolean" } },
  async run({ args }) {
    const week = typeof args.week === "string" ? args.week : undefined;
    const output = await runReport({
      repoRoot: process.cwd(),
      ...(week !== undefined ? { week } : {}),
      json: args.json === true,
    });
    process.stdout.write(`${output}\n`);
  },
});
```

Add `report` to the `subCommands` map:

```ts
  subCommands: { init, gate, "review-plan": reviewPlan, doctor, audit, brain, fp, stats, report },
```

- [ ] **Step 6: Typecheck + lint + verify the command loads**

Run: `bunx tsc --noEmit && bun run lint`
Expected: clean.

Run: `bun run dev report --help`
Expected: prints the `report` command usage (week/json args).

- [ ] **Step 7: Commit**

```bash
git add src/cli/commands/report.ts src/cli/index.ts tests/unit/report-cli.test.ts
git commit -m "feat(cli): reviewgate report command (weekly markdown + --week/--json)"
```

---

## Task 9: Config — `weeklyReport.autoSnapshot`

**Files:**
- Modify: `src/config/define-config.ts`, `src/config/defaults.ts`, `src/cli/commands/init.ts`
- Test: `tests/unit/config-loader.test.ts` (add a case) — or reuse the existing config test file.

- [ ] **Step 1: Write the failing test (append to `tests/unit/config-loader.test.ts`)**

```ts
import { describe, expect, it } from "bun:test";
import { ConfigSchema } from "../../src/config/define-config.ts";
import { defaultConfig } from "../../src/config/defaults.ts";

describe("weeklyReport config", () => {
  it("defaults weeklyReport to null (off)", () => {
    const parsed = ConfigSchema.parse(defaultConfig);
    expect(parsed.weeklyReport ?? null).toBeNull();
  });

  it("accepts weeklyReport.autoSnapshot", () => {
    const parsed = ConfigSchema.parse({ ...defaultConfig, weeklyReport: { autoSnapshot: true } });
    expect(parsed.weeklyReport?.autoSnapshot).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/config-loader.test.ts`
Expected: FAIL — `weeklyReport` is stripped/unknown or not parsed.

- [ ] **Step 3: Add `weeklyReport` to `ConfigSchema`**

In `src/config/define-config.ts`, add this key inside the top-level `ConfigSchema = z.object({ ... })` (e.g. right after the `docReview` block, mirroring the `fpLedger` opt-in pattern):

```ts
  // Weekly report auto-snapshot-on-rollover. Opt-in.
  weeklyReport: z.object({ autoSnapshot: z.boolean() }).nullable().default(null).optional(),
```

- [ ] **Step 4: Add the default in `defaults.ts`**

In `src/config/defaults.ts`, add a top-level key (mirroring how `cache`/`research` sit at the top level):

```ts
  weeklyReport: null as null | { autoSnapshot: boolean },
```

- [ ] **Step 5: Add the commented hint to the init starter config**

In `src/cli/commands/init.ts`, inside the `starter` array, add a commented line just before the closing `"};"` line:

```ts
      '  // weeklyReport: { autoSnapshot: true }, // write .reviewgate/reports/<iso>.md on weekly rollover',
```

- [ ] **Step 6: Run to verify pass + full suite sanity**

Run: `bun test tests/unit/config-loader.test.ts`
Expected: PASS.

Run: `bunx tsc --noEmit && bun run lint`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add src/config/define-config.ts src/config/defaults.ts src/cli/commands/init.ts tests/unit/config-loader.test.ts
git commit -m "feat(config): opt-in weeklyReport.autoSnapshot (default off) + init starter hint"
```

---

## Task 10: Auto-snapshot (`snapshot.ts`)

**Files:**
- Create: `src/stats/snapshot.ts`
- Test: `tests/unit/weekly-snapshot.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/weekly-snapshot.test.ts
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { maybeWriteWeeklySnapshot } from "../../src/stats/snapshot.ts";
import type { ReviewgateConfig } from "../../src/config/define-config.ts";

function seedRepo(): string {
  const root = join(tmpdir(), `rg-snap-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return root;
}
function writeRun(root: string, ts: string): void {
  const d = new Date(ts);
  const dir = join(root, ".reviewgate", "audit", String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ schema: "reviewgate.audit.v1", event: "run.complete", ts, run_id: ts, iter: 1, trigger: "stop-hook", run_summary: { verdict: "PASS", source: "panel", counts: { critical: 0, warn: 0, info: 0 }, cost_usd: 0.01, duration_ms: 10, demoted: 0, signatures: [], providers: [] } });
  writeFileSync(join(dir, "100000.jsonl"), `${line}\n`, { flag: "a" });
}
const ON = { autoSnapshot: true } as ReviewgateConfig["weeklyReport"];

describe("maybeWriteWeeklySnapshot", () => {
  // now = 2026-05-25 → last complete week = 2026-W21 (2026-05-18..05-25). Use a
  // run inside W21 so the snapshot has content. (W22 starts 2026-05-25.)
  const now = new Date("2026-05-26T00:00:00.000Z"); // last complete week = 2026-W21

  it("writes the last-complete-week report when autoSnapshot is on", async () => {
    const root = seedRepo();
    writeRun(root, "2026-05-19T10:00:00.000Z"); // inside W21
    await maybeWriteWeeklySnapshot(root, { weeklyReport: ON } as ReviewgateConfig, { now });
    expect(existsSync(join(root, ".reviewgate", "reports", "2026-W21.md"))).toBe(true);
  });

  it("is a no-op when the report already exists", async () => {
    const root = seedRepo();
    writeRun(root, "2026-05-19T10:00:00.000Z");
    const p = join(root, ".reviewgate", "reports", "2026-W21.md");
    mkdirSync(join(root, ".reviewgate", "reports"), { recursive: true });
    writeFileSync(p, "PRE-EXISTING");
    await maybeWriteWeeklySnapshot(root, { weeklyReport: ON } as ReviewgateConfig, { now });
    expect((await Bun.file(p).text())).toBe("PRE-EXISTING"); // untouched
  });

  it("writes a .empty sentinel for a zero-run week and writes no report", async () => {
    const root = seedRepo();
    // no runs at all
    await maybeWriteWeeklySnapshot(root, { weeklyReport: ON } as ReviewgateConfig, { now });
    expect(existsSync(join(root, ".reviewgate", "reports", "2026-W21.md"))).toBe(false);
    expect(existsSync(join(root, ".reviewgate", "reports", ".2026-W21.empty"))).toBe(true);
  });

  it("does nothing when autoSnapshot is off", async () => {
    const root = seedRepo();
    writeRun(root, "2026-05-19T10:00:00.000Z");
    await maybeWriteWeeklySnapshot(root, { weeklyReport: null } as ReviewgateConfig, { now });
    expect(existsSync(join(root, ".reviewgate", "reports", "2026-W21.md"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test tests/unit/weekly-snapshot.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `snapshot.ts`**

```ts
// src/stats/snapshot.ts
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewgateConfig } from "../config/define-config.ts";
import { formatIsoWeek, lastCompleteWeek, weekBounds } from "./iso-week.ts";
import { loadAuditWindow } from "./load.ts";
import { reportsDir, weekReportPath } from "../utils/paths.ts";
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
// per ISO week on the success path. Caller wraps in its own try/catch; this
// also self-guards so a thrown build is recorded as a cooldown marker.
export async function maybeWriteWeeklySnapshot(
  repoRoot: string,
  config: ReviewgateConfig,
  opts: { now?: Date } = {},
): Promise<void> {
  if (config.weeklyReport?.autoSnapshot !== true) return;
  const now = opts.now ?? new Date();
  const week = lastCompleteWeek(now);
  const iso = formatIsoWeek(week);

  // (a) already written
  if (existsSync(weekReportPath(repoRoot, iso))) return;
  // (b) known zero-run week (permanent sentinel)
  if (existsSync(emptyMarker(repoRoot, iso))) return;
  // (c) in failure cooldown
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
      // zero-run week → permanent sentinel, no empty report file
      writeReportFile(emptyMarker(repoRoot, iso), "", { exclusive: false });
      return;
    }
    const report = await assembleWeeklyReport(repoRoot, week, { now });
    const md = renderWeeklyMarkdown(report);
    writeReportFile(weekReportPath(repoRoot, iso), md, { exclusive: true });
  } catch {
    // Record/refresh an expiring cooldown marker so a persistently-failing build
    // does not rescan on every gate stop. Not a poison — it expires after the
    // cooldown. mkdir first: on an early failure the reports dir may not exist yet.
    try {
      mkdirSync(reportsDir(repoRoot), { recursive: true });
      writeFileSync(failed, "", { mode: 0o600 });
    } catch {
      /* best-effort */
    }
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `bun test tests/unit/weekly-snapshot.test.ts`
Expected: PASS (all four cases).

- [ ] **Step 5: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/stats/snapshot.ts tests/unit/weekly-snapshot.test.ts
git commit -m "feat(stats): opt-in weekly auto-snapshot (idempotent, cooldown-bounded)"
```

---

## Task 11: Wire the snapshot into `loop-driver.ts`

**Files:**
- Modify: `src/core/loop-driver.ts`

The snapshot must run as the **last trailing side-effect** of the iteration path — after the state update, the PASS-branch dirty-flag/decisions handling, and the `gate.decision` append — so an interruption during the snapshot cannot desync audit/state. Refactor the iteration-path returns to funnel through one trailing call.

- [ ] **Step 1: Add the import**

At the top of `src/core/loop-driver.ts`, add:

```ts
import { maybeWriteWeeklySnapshot } from "../stats/snapshot.ts";
```

- [ ] **Step 2: Refactor the iteration-path tail to a single trailing return**

Locate the block that begins right after `await this.i.state.update(...)` (the `if (result.verdict === "PASS" || result.verdict === "SOFT-PASS") { ... }` through the final FAIL `return { kind: "block", ... }`). Replace those branched `return`s so each assigns a `decision` variable, then run the snapshot once and return:

```ts
    let decision: LoopDecision;
    if (result.verdict === "PASS" || result.verdict === "SOFT-PASS") {
      try {
        unlinkSync(dirtyFlagPath(this.i.repoRoot));
      } catch {
        /* noop */
      }
      clearDecisions(this.i.repoRoot);
      await this.i.audit.append({
        event: "gate.decision",
        run_id: state.session_id,
        iter: nextIter,
        trigger: "stop-hook",
      });
      decision = this.i.config.loop.acknowledgePass
        ? {
            kind: "block",
            reason: `🟢 Reviewgate · GATE OPEN — ✅ ${result.verdict} (iteration ${nextIter}). Review is clean, no findings to address. No action needed: simply end your turn again to pass through (you may briefly confirm the pass to the user first).`,
          }
        : {
            kind: "allow_stop",
            reason: `🟢 Reviewgate · GATE OPEN — ${result.verdict} (iteration ${nextIter}). Clear to finish.`,
          };
    } else if (result.verdict === "ERROR") {
      decision = {
        kind: "block",
        reason: `🔴 Reviewgate · GATE CLOSED — reviewer error (iteration ${nextIter}). The review could not complete. Run \`reviewgate doctor\` to diagnose, fix the reviewer, then continue. Reviewgate will not open the gate on a turn it could not review.`,
      };
    } else {
      decision = {
        kind: "block",
        reason: `🔴 Reviewgate · GATE CLOSED — iteration ${nextIter}/${this.i.config.loop.maxIterations} · ${result.signaturesThisIter.length} finding(s). See .reviewgate/pending.md · record per-finding decisions in .reviewgate/decisions/${nextIter}.jsonl.`,
      };
    }

    // Last trailing side-effect: opt-in weekly snapshot. State, dirty-flag, and
    // gate.decision are already committed, so an interruption here cannot desync
    // audit vs gate state. Fully isolated (own try/catch) — never affects the
    // verdict. await'd because the gate process exits right after.
    try {
      await maybeWriteWeeklySnapshot(this.i.repoRoot, this.i.config);
    } catch {
      /* best-effort: a snapshot failure must never affect the gate */
    }

    return decision;
```

> Verify after editing: the comment lines explaining the original `acknowledgePass` block can be kept or trimmed; do not remove the `unlinkSync` / `clearDecisions` / `gate.decision` append — they must still run on PASS, before the snapshot.

- [ ] **Step 3: Typecheck + lint**

Run: `bunx tsc --noEmit && bun run lint`
Expected: clean.

- [ ] **Step 4: Run the loop-driver tests + full suite**

Run: `bun test`
Expected: PASS / 0 fail (pre-existing skips unchanged). The existing loop-driver tests must still pass — the refactor preserves the exact decisions and side-effect ordering on every verdict (autoSnapshot defaults off, so `maybeWriteWeeklySnapshot` returns immediately in those tests).

- [ ] **Step 5: Commit**

```bash
git add src/core/loop-driver.ts
git commit -m "feat(core): run opt-in weekly snapshot as the trailing loop-driver side-effect"
```

---

## Task 12: Integration test + compiled-binary verification

**Files:**
- Create: `tests/integration/weekly-report-pipeline.test.ts`

- [ ] **Step 1: Write the integration test**

```ts
// tests/integration/weekly-report-pipeline.test.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { runReport } from "../../src/cli/commands/report.ts";

function seedRepo(): string {
  const root = join(tmpdir(), `rg-wpipe-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return root;
}
function writeRun(root: string, ts: string, verdict: string, cost: number, signatures: string[]): void {
  const d = new Date(ts);
  const dir = join(root, ".reviewgate", "audit", String(d.getUTCFullYear()), String(d.getUTCMonth() + 1).padStart(2, "0"), String(d.getUTCDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({ schema: "reviewgate.audit.v1", event: "run.complete", ts, run_id: ts, iter: 1, trigger: "stop-hook", run_summary: { verdict, source: "panel", counts: { critical: 0, warn: 0, info: 0 }, cost_usd: cost, duration_ms: 10, demoted: 0, signatures, providers: [{ provider: "codex", runs: 1, errors: 0, findings: signatures.length, demoted: 0, cost_usd: cost, duration_ms: 10 }] } });
  writeFileSync(join(dir, `${d.getUTCHours()}0000.jsonl`), `${line}\n`, { flag: "a" });
}

describe("weekly report pipeline (seeded 2-week audit log)", () => {
  it("renders a markdown report with correct week-over-week deltas", async () => {
    const root = seedRepo();
    // W19: 1 run, $0.10
    writeRun(root, "2026-05-05T10:00:00.000Z", "PASS", 0.1, ["sig-old"]);
    // W20: 3 runs, $0.30 total, a new signature
    writeRun(root, "2026-05-12T10:00:00.000Z", "PASS", 0.1, ["sig-old"]);
    writeRun(root, "2026-05-13T10:00:00.000Z", "FAIL", 0.1, ["sig-new"]);
    writeRun(root, "2026-05-14T10:00:00.000Z", "PASS", 0.1, ["sig-old"]);

    const md = await runReport({ repoRoot: root, week: "2026-W20", now: new Date("2026-05-25T00:00:00.000Z") });
    expect(md).toContain("# Reviewgate Weekly Report — 2026-W20");
    expect(md).toContain("vs 2026-W19");
    expect(md).toContain("▲"); // runs up (3 vs 1)
    expect(md).toContain("sig-new"); // new-signature highlight
    expect(existsSync(join(root, ".reviewgate", "reports", "2026-W20.md"))).toBe(true);
    expect(readFileSync(join(root, ".reviewgate", "reports", "2026-W20.md"), "utf8")).toBe(md);
  });
});
```

- [ ] **Step 2: Run the integration test**

Run: `bun test tests/integration/weekly-report-pipeline.test.ts`
Expected: PASS.

- [ ] **Step 3: Full suite + typecheck + lint**

Run: `bun test && bunx tsc --noEmit && bun run lint`
Expected: all green, 0 fail.

- [ ] **Step 4: Build the binary and verify the command in the COMPILED binary**

Run:
```bash
bun run build
TMP=$(mktemp -d)
cd "$TMP" && git init -q
mkdir -p .reviewgate/audit/2026/05/12
printf '%s\n' '{"schema":"reviewgate.audit.v1","event":"run.complete","ts":"2026-05-12T10:00:00.000Z","run_id":"r1","iter":1,"trigger":"stop-hook","run_summary":{"verdict":"PASS","source":"panel","counts":{"critical":0,"warn":0,"info":0},"cost_usd":0.02,"duration_ms":10,"demoted":0,"signatures":["sig-x"],"providers":[]}}' > .reviewgate/audit/2026/05/12/100000.jsonl
"$OLDPWD/dist/reviewgate" report --week 2026-W20
ls .reviewgate/reports/
cd "$OLDPWD"
```
Expected: prints the Markdown report for `2026-W20` to stdout AND `.reviewgate/reports/2026-W20.md` exists in the temp repo. (This confirms no compiled-binary regression — per the project's real-e2e rule; tree-sitter/wasm is not involved here, but the audit-load + render path must work in the binary.)

- [ ] **Step 5: Commit**

```bash
git add tests/integration/weekly-report-pipeline.test.ts
git commit -m "test(stats): weekly report pipeline integration test"
```

---

## Definition of Done

After all tasks: run the project's **Definition of Done — Review Pipeline** from CLAUDE.md (static checks → Codex ×reviews → Claude reviews → gate). Then update `NEXT_SESSION.md` and the project memory, and **ask the user before pushing**.

## Self-Review notes (author)
- Every spec section maps to a task: iso-week (T1), load `until`+partition (T2), `buildWeeklyReport` purity/deltas/highlights/status (T3), markdown render (T4), paths (T5), atomic exclusive/overwrite write (T6), assemble + prior-history probe (T7), CLI `report`/`--week`/`--json`/partial/future/malformed (T8), config opt-in + init hint (T9), snapshot idempotence/`.empty`/cooldown (T10), loop-driver trailing-side-effect ordering (T11), integration + compiled-binary (T12).
- Type names are consistent across tasks: `IsoWeek`, `WeekBounds`, `Delta`, `WeeklyReport`, `WeeklyBuildArgs`, `buildWeeklyReport`, `assembleWeeklyReport`, `renderWeeklyMarkdown`, `writeReportFile`, `maybeWriteWeeklySnapshot`, `runReport`.
- The `−1-day` partition guard (T2) is justified by `AuditLogger.currentFilePath()` memoization (verified in the spec).
