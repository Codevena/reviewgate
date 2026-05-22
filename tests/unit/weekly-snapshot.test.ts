// tests/unit/weekly-snapshot.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewgateConfig } from "../../src/config/define-config.ts";
import { maybeWriteWeeklySnapshot } from "../../src/stats/snapshot.ts";

function seedRepo(): string {
  const root = join(tmpdir(), `rg-snap-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  return root;
}
function writeRun(root: string, ts: string): void {
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
      verdict: "PASS",
      source: "panel",
      counts: { critical: 0, warn: 0, info: 0 },
      cost_usd: 0.01,
      duration_ms: 10,
      demoted: 0,
      signatures: [],
      providers: [],
    },
  });
  writeFileSync(join(dir, "100000.jsonl"), `${line}\n`, { flag: "a" });
}
const ON = { autoSnapshot: true } as ReviewgateConfig["weeklyReport"];

describe("maybeWriteWeeklySnapshot", () => {
  // now = 2026-05-26 → last complete week = 2026-W21 (2026-05-18..05-25).
  const now = new Date("2026-05-26T00:00:00.000Z");

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
    expect(await Bun.file(p).text()).toBe("PRE-EXISTING");
  });

  it("writes a .empty sentinel for a zero-run week and writes no report", async () => {
    const root = seedRepo();
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

  it("a fresh .failed marker (younger than 6h) suppresses the snapshot", async () => {
    const root = seedRepo();
    writeRun(root, "2026-05-19T10:00:00.000Z"); // W21 has a run → would normally write
    const reportsDirPath = join(root, ".reviewgate", "reports");
    mkdirSync(reportsDirPath, { recursive: true });
    const failed = join(reportsDirPath, ".2026-W21.failed");
    writeFileSync(failed, "");
    // mtime = 1h before `now` → within the 6h cooldown
    const oneHourBefore = new Date(now.getTime() - 60 * 60 * 1000);
    utimesSync(failed, oneHourBefore, oneHourBefore);
    await maybeWriteWeeklySnapshot(root, { weeklyReport: ON } as ReviewgateConfig, { now });
    expect(existsSync(join(reportsDirPath, "2026-W21.md"))).toBe(false); // suppressed
  });

  it("an expired .failed marker (older than 6h) no longer suppresses the snapshot", async () => {
    const root = seedRepo();
    writeRun(root, "2026-05-19T10:00:00.000Z");
    const reportsDirPath = join(root, ".reviewgate", "reports");
    mkdirSync(reportsDirPath, { recursive: true });
    const failed = join(reportsDirPath, ".2026-W21.failed");
    writeFileSync(failed, "");
    // mtime = 7h before `now` → past the 6h cooldown → retry
    const sevenHoursBefore = new Date(now.getTime() - 7 * 60 * 60 * 1000);
    utimesSync(failed, sevenHoursBefore, sevenHoursBefore);
    await maybeWriteWeeklySnapshot(root, { weeklyReport: ON } as ReviewgateConfig, { now });
    expect(existsSync(join(reportsDirPath, "2026-W21.md"))).toBe(true); // retried + wrote
  });
});
