// tests/unit/weekly-assemble.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleWeeklyReport } from "../../src/stats/weekly-assemble.ts";

function seedRepo(): string {
  const root = join(tmpdir(), `rg-asm-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function writeRun(root: string, ts: string, verdict: string, signatures: string[]): void {
  const d = new Date(ts);
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
    ts,
    run_id: ts,
    iter: 1,
    trigger: "stop-hook",
    run_summary: {
      verdict,
      source: "panel",
      counts: { critical: 0, warn: 0, info: 0 },
      cost_usd: 0.05,
      duration_ms: 10,
      demoted: 0,
      signatures,
      providers: [],
    },
  });
  writeFileSync(join(dir, `${d.getUTCHours()}0000.jsonl`), `${line}\n`, { flag: "a" });
}

describe("assembleWeeklyReport", () => {
  it("computes trend vs the previous week and diffs new signatures", async () => {
    const root = seedRepo();
    writeRun(root, "2026-05-05T10:00:00.000Z", "PASS", ["sig-old"]); // W19
    writeRun(root, "2026-05-12T10:00:00.000Z", "FAIL", ["sig-new"]); // W20
    writeRun(root, "2026-05-13T10:00:00.000Z", "PASS", ["sig-old"]);
    const report = await assembleWeeklyReport(
      root,
      { year: 2026, week: 20 },
      { now: new Date("2026-05-25T00:00:00.000Z") },
    );
    expect(report.week.iso).toBe("2026-W20");
    expect(report.previousWeek).toEqual({ iso: "2026-W19" });
    expect(report.current.window.runCount).toBe(2);
    expect(report.trend?.runCount).toEqual({ current: 2, previous: 1, abs: 1 });
    expect(report.highlights.newSignatures).toEqual([{ signature: "sig-new", count: 1 }]);
  });

  it("treats a no-history week as a first report (trend null)", async () => {
    const root = seedRepo();
    writeRun(root, "2026-05-12T10:00:00.000Z", "PASS", []);
    const report = await assembleWeeklyReport(
      root,
      { year: 2026, week: 20 },
      { now: new Date("2026-05-25T00:00:00.000Z") },
    );
    expect(report.previousWeek).toBeNull();
    expect(report.trend).toBeNull();
  });

  it("a quiet previous week with older history is a zero baseline, not a first report", async () => {
    const root = seedRepo();
    writeRun(root, "2026-04-20T10:00:00.000Z", "PASS", []); // older history
    writeRun(root, "2026-05-12T10:00:00.000Z", "PASS", []); // W20; W19 empty
    const report = await assembleWeeklyReport(
      root,
      { year: 2026, week: 20 },
      { now: new Date("2026-05-25T00:00:00.000Z") },
    );
    expect(report.previousWeek).toEqual({ iso: "2026-W19" });
    expect(report.trend?.runCount).toEqual({ current: 1, previous: 0, abs: 1 });
  });
});
