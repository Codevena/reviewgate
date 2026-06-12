// tests/unit/stats-load.test.ts
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAuditWindow } from "../../src/stats/load.ts";

// ---------------------------------------------------------------------------
// Helpers for the until + partition-scope tests
// ---------------------------------------------------------------------------
function seedRepo(): string {
  const root = join(tmpdir(), `rg-load-${Math.random().toString(36).slice(2)}`);
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

function writeDecision(root: string, ts: string, outcome: Record<string, unknown>): void {
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
    event: "decision.applied",
    ts,
    run_id: "s1",
    iter: 1,
    trigger: "stop-hook",
    decision_outcome: outcome,
  });
  writeFileSync(join(dir, "120500.jsonl"), `${line}\n`, { flag: "a" });
}

describe("loadAuditWindow decisions", () => {
  it("collects decision.applied events and windows them by ts via --since", () => {
    const root = seedRepo();
    writeDecision(root, "2026-06-01T12:00:00.000Z", {
      finding_id: "F-1",
      severity: "CRITICAL",
      bucket: "tp",
      providers: ["codex"],
    });
    writeDecision(root, "2026-06-05T12:00:00.000Z", {
      finding_id: "F-2",
      severity: "WARN",
      bucket: "fp",
      reviewer_was_wrong: true,
      providers: ["gemini"],
    });
    const win = loadAuditWindow(root, { since: "2026-06-03T00:00:00.000Z" });
    expect(win.decisions).toHaveLength(1);
    expect(win.decisions[0]?.finding_id).toBe("F-2");
  });

  it("returns an empty decisions array when there is no audit dir", () => {
    const root = seedRepo();
    expect(loadAuditWindow(root, {}).decisions).toEqual([]);
  });
});

describe("loadAuditWindow until + partition scope", () => {
  it("until excludes runs and escalations at or after the bound", () => {
    const root = seedRepo();
    writeRun(root, "2026-05-11T10:00:00.000Z", "a");
    writeRun(root, "2026-05-18T10:00:00.000Z", "b");
    writeEscalation(root, "2026-05-12T10:00:00.000Z");
    writeEscalation(root, "2026-05-18T11:00:00.000Z");
    const w = loadAuditWindow(root, {
      since: "2026-05-11T00:00:00.000Z",
      until: "2026-05-18T00:00:00.000Z",
    });
    expect(w.runs.map((r) => r.run_id)).toEqual(["a"]);
    expect(w.escalationCount).toBe(1);
  });

  it("finds an in-window run physically stored in the prior day's partition", () => {
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
      ts: "2026-05-11T00:30:00.000Z",
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
