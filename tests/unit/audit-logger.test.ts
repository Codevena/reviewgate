// tests/unit/audit-logger.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { verifyChain } from "../../src/audit/verifier.ts";
import { loadAuditWindow } from "../../src/stats/load.ts";

function tmp() {
  return mkdtempSync(join(tmpdir(), "rg-audit-"));
}

describe("AuditLogger", () => {
  it("appends events with sha256 hash chain", async () => {
    const dir = tmp();
    const log = new AuditLogger(dir);
    await log.append({ event: "session.start", run_id: "r1", iter: 0, trigger: "session-start" });
    await log.append({ event: "run.start", run_id: "r1", iter: 1, trigger: "stop-hook" });
    await log.append({ event: "reviewer.complete", run_id: "r1", iter: 1, trigger: "stop-hook" });
    const path = log.currentFilePath();
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.length).toBe(3);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed[0].prev_event_hash).toBe("");
    expect(parsed[1].prev_event_hash).toBe(parsed[0].this_event_hash);
    expect(parsed[2].prev_event_hash).toBe(parsed[1].this_event_hash);
  });

  it("verifyChain returns ok=true on a freshly written chain", async () => {
    const dir = tmp();
    const log = new AuditLogger(dir);
    await log.append({ event: "session.start", run_id: "r1", iter: 0, trigger: "session-start" });
    await log.append({ event: "session.end", run_id: "r1", iter: 0, trigger: "session-start" });
    const v = await verifyChain(log.currentFilePath());
    expect(v.ok).toBe(true);
    expect(v.brokenAtLine).toBeNull();
  });

  it("verifyChain detects tampering", async () => {
    const dir = tmp();
    const log = new AuditLogger(dir);
    await log.append({ event: "session.start", run_id: "r1", iter: 0, trigger: "session-start" });
    await log.append({ event: "reviewer.complete", run_id: "r1", iter: 1, trigger: "stop-hook" });
    const path = log.currentFilePath();
    const { readFileSync, writeFileSync } = await import("node:fs");
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const obj = JSON.parse(lines[0] as string);
    obj.iter = 999; // tamper but recompute nothing
    lines[0] = JSON.stringify(obj);
    writeFileSync(path, `${lines.join("\n")}\n`);
    const v = await verifyChain(path);
    expect(v.ok).toBe(false);
    expect(v.brokenAtLine).toBe(2);
  });

  it("gives every same-clock logger its own filesystem-safe chain", async () => {
    const dir = tmp();
    const logs = Array.from({ length: 64 }, () => new AuditLogger(dir));
    const paths = logs.map((log) => log.currentFilePath());

    expect(new Set(paths).size).toBe(paths.length);
    for (const path of paths) {
      expect(basename(path)).toMatch(/^\d{9}-p\d+-[0-9a-f]{32}\.jsonl$/);
    }

    await Promise.all(
      logs.map((log, i) =>
        log.append({ event: "session.start", run_id: `r${i}`, iter: 0, trigger: "session-start" }),
      ),
    );
    for (const log of logs) expect((await verifyChain(log.currentFilePath())).ok).toBe(true);
  });

  it("stats aggregates run.complete events from independent same-clock chains", async () => {
    const repo = tmp();
    const auditDir = join(repo, ".reviewgate", "audit");
    const summary = {
      verdict: "PASS" as const,
      source: "panel" as const,
      counts: { critical: 0, warn: 0, info: 0 },
      cost_usd: 0,
      duration_ms: 1,
      demoted: 0,
      signatures: [],
      providers: [],
    };
    const logs = [new AuditLogger(auditDir), new AuditLogger(auditDir), new AuditLogger(auditDir)];
    await Promise.all(
      logs.map((log, i) =>
        log.append({
          event: "run.complete",
          run_id: `same-clock-${i}`,
          iter: 1,
          trigger: "stop-hook",
          run_summary: summary,
        }),
      ),
    );

    expect(new Set(logs.map((log) => log.currentFilePath())).size).toBe(3);
    expect(
      loadAuditWindow(repo, {})
        .runs.map((run) => run.run_id)
        .sort(),
    ).toEqual(["same-clock-0", "same-clock-1", "same-clock-2"]);
  });
});
