// tests/unit/stats-load.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuditWindow } from "../../src/stats/load.ts";

function tmp() {
  return mkdtempSync(join(tmpdir(), "rg-stats-"));
}

const minimalSummary = {
  verdict: "PASS" as const,
  source: "panel" as const,
  counts: { critical: 0, warn: 0, info: 0 },
  cost_usd: 0,
  duration_ms: 1,
  demoted: 0,
  signatures: [],
  providers: [],
};

// Minimal valid run.complete event (only the fields the loader needs)
function runCompleteEvent(ts: string, run_id: string, iter: number) {
  return {
    ts,
    run_id,
    iter,
    event: "run.complete",
    run_summary: minimalSummary,
  };
}

describe("loadAuditWindow", () => {
  it("returns empty result when audit dir is missing", () => {
    const repo = tmp();
    const result = loadAuditWindow(repo, {});
    expect(result.runs).toEqual([]);
    expect(result.escalationCount).toBe(0);
  });

  it("reads run.complete events, skips escalation and malformed lines", () => {
    const repo = tmp();
    const auditPath = join(repo, ".reviewgate", "audit", "2026", "05", "20");
    mkdirSync(auditPath, { recursive: true });

    const lines = [
      JSON.stringify(runCompleteEvent("2026-05-20T10:00:00.000Z", "r1", 1)),
      JSON.stringify({
        ts: "2026-05-20T11:00:00.000Z",
        run_id: "r",
        iter: 1,
        event: "escalation",
        trigger: "stop-hook",
      }),
      JSON.stringify(runCompleteEvent("2026-05-20T12:00:00.000Z", "r2", 2)),
      "{not json",
    ].join("\n");

    writeFileSync(join(auditPath, "x.jsonl"), `${lines}\n`);

    const result = loadAuditWindow(repo, {});
    expect(result.runs.length).toBe(2);
    expect(result.escalationCount).toBe(1);

    // sorted ascending by ts
    expect(result.runs[0]?.ts).toBe("2026-05-20T10:00:00.000Z");
    expect(result.runs[0]?.run_id).toBe("r1");
    expect(result.runs[0]?.iter).toBe(1);
    expect(result.runs[0]?.summary).toEqual(minimalSummary);

    expect(result.runs[1]?.ts).toBe("2026-05-20T12:00:00.000Z");
    expect(result.runs[1]?.run_id).toBe("r2");
    expect(result.runs[1]?.iter).toBe(2);
  });

  it("last: 1 returns only the most-recent run", () => {
    const repo = tmp();
    const auditPath = join(repo, ".reviewgate", "audit", "2026", "05", "20");
    mkdirSync(auditPath, { recursive: true });

    const lines = [
      JSON.stringify(runCompleteEvent("2026-05-20T10:00:00.000Z", "r1", 1)),
      JSON.stringify(runCompleteEvent("2026-05-20T12:00:00.000Z", "r2", 2)),
    ].join("\n");

    writeFileSync(join(auditPath, "x.jsonl"), `${lines}\n`);

    const result = loadAuditWindow(repo, { last: 1 });
    expect(result.runs.length).toBe(1);
    expect(result.runs[0]?.ts).toBe("2026-05-20T12:00:00.000Z");
    expect(result.runs[0]?.run_id).toBe("r2");
  });

  it("last: windows escalationCount to the kept runs' time span (no >100% rate)", () => {
    const repo = tmp();
    const auditPath = join(repo, ".reviewgate", "audit", "2026", "05", "20");
    mkdirSync(auditPath, { recursive: true });
    const lines = [
      JSON.stringify(runCompleteEvent("2026-05-20T10:00:00.000Z", "r1", 1)),
      JSON.stringify(runCompleteEvent("2026-05-20T12:00:00.000Z", "r2", 2)),
      // two escalations BEFORE the most-recent run (12:00) — must be excluded by last:1
      JSON.stringify({
        ts: "2026-05-20T09:00:00.000Z",
        run_id: "r0",
        iter: 1,
        event: "escalation",
      }),
      JSON.stringify({
        ts: "2026-05-20T11:00:00.000Z",
        run_id: "r1",
        iter: 2,
        event: "escalation",
      }),
    ].join("\n");
    writeFileSync(join(auditPath, "x.jsonl"), `${lines}\n`);

    // all-time: both escalations counted
    expect(loadAuditWindow(repo, {}).escalationCount).toBe(2);
    // last:1 keeps only the 12:00 run → escalations before 12:00 are out of window
    const windowed = loadAuditWindow(repo, { last: 1 });
    expect(windowed.runs.length).toBe(1);
    expect(windowed.escalationCount).toBe(0);
  });

  it("since: date filters out older runs and escalations", () => {
    const repo = tmp();
    const auditPath = join(repo, ".reviewgate", "audit", "2026", "05", "20");
    mkdirSync(auditPath, { recursive: true });

    const lines = [
      JSON.stringify(runCompleteEvent("2026-05-20T10:00:00.000Z", "r1", 1)),
      JSON.stringify({
        ts: "2026-05-20T11:00:00.000Z",
        run_id: "r",
        iter: 1,
        event: "escalation",
        trigger: "stop-hook",
      }),
      JSON.stringify(runCompleteEvent("2026-05-20T12:00:00.000Z", "r2", 2)),
    ].join("\n");

    writeFileSync(join(auditPath, "x.jsonl"), `${lines}\n`);

    // since after all events → no runs, no escalations
    const result = loadAuditWindow(repo, { since: "2026-05-21" });
    expect(result.runs.length).toBe(0);
    expect(result.escalationCount).toBe(0);
  });
});
