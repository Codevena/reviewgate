// tests/unit/audit-logger.test.ts
import { describe, expect, it, setSystemTime } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { verifyChain } from "../../src/audit/verifier.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import { POLICY_PASSES } from "../../src/core/policy/catalog.ts";
import { PolicyTraceRecorder } from "../../src/core/policy/trace.ts";
import { StateStore } from "../../src/core/state-store.ts";
import type { RunSummary } from "../../src/schemas/audit-event.ts";
import { loadAuditWindow } from "../../src/stats/load.ts";
import { auditDir, dirtyFlagPath } from "../../src/utils/paths.ts";

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

  it("preserves the pre-extraction canonical audit hash bytes", async () => {
    setSystemTime(new Date("2026-08-10T12:00:00.000Z"));
    try {
      const log = new AuditLogger(tmp());
      const event = await log.append({
        event: "session.start",
        run_id: "r1",
        iter: 0,
        trigger: "session-start",
      });
      expect(event.this_event_hash).toBe(
        "77968fbe0f1179d1c3445b603a476f47d16df8a4d2dcac2c3a96fbc229bacbc6",
      );
    } finally {
      setSystemTime();
    }
  });

  it("writePolicyTrace never throws when the audit root cannot be a directory", () => {
    const blocked = join(tmp(), "blocked-audit-root");
    writeFileSync(blocked, "not a directory");
    const result = new AuditLogger(blocked).writePolicyTrace({} as never);
    expect(result).toEqual({ status: "error" });
  });

  it("stores a policy trace in the logger chain's already-selected UTC day partition", async () => {
    setSystemTime(new Date("2026-08-10T23:59:59.000Z"));
    try {
      const log = new AuditLogger(tmp());
      await log.append({
        event: "session.start",
        run_id: "midnight-run",
        iter: 0,
        trigger: "session-start",
      });
      const recorder = PolicyTraceRecorder.start({ runId: "midnight-run", iter: 1, ablated: [] });
      recorder.recordStage({
        stageId: "verdict.compute",
        reasonCode: "no-blocking-findings",
        inputSignatures: [],
        verdict: "PASS",
      });
      const trace = recorder.finalize({
        rawResponseSha256: ["a".repeat(64)],
        verdict: "PASS",
        finalFindings: [],
      });
      if (trace === null) throw new Error("fixture trace did not finalize");

      setSystemTime(new Date("2026-08-11T00:00:01.000Z"));
      const stored = log.writePolicyTrace(trace);
      expect(stored.status).toBe("complete");
      if (stored.status !== "complete") throw new Error("fixture trace did not persist");
      expect(stored.ref).toStartWith("2026/08/10/policy/");
    } finally {
      setSystemTime();
    }
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

describe("LoopDriver run.complete policy identity", () => {
  it("binds run.complete to the exact IterationResult compact summary identity", async () => {
    const repo = tmp();
    const state = new StateStore(repo);
    await state.initialise("RUN-LOOP-POLICY");
    writeFileSync(
      dirtyFlagPath(repo),
      JSON.stringify({ diff_hash: "dirty", ts: new Date().toISOString() }),
    );
    const audit = new AuditLogger(auditDir(repo));
    const passes = POLICY_PASSES.map((pass) => ({
      pass_id: pass.id,
      status: "ran" as const,
      considered: 0,
      opportunities: 0,
      would_apply: 0,
      applied: 0,
      protected: 0,
      blocking_removed: 0,
      blocking_preserved: 0,
      dropped: 0,
    }));
    const policySummary = {
      catalog_version: "reviewgate.policy-catalog.v1" as const,
      status: "complete" as const,
      passes,
      policy_trace_ref: "2026/08/10/policy/aaaaaaaaaaaa-i1-bbbbbbbbbbbb.json",
      policy_trace_sha256: "b".repeat(64),
    };
    const summary: RunSummary = {
      verdict: "PASS",
      source: "panel",
      counts: { critical: 0, warn: 0, info: 0 },
      cost_usd: 0,
      duration_ms: 1,
      demoted: 0,
      signatures: [],
      providers: [],
      from_critical_demoted: 0,
      corroboration_clamped: 0,
      // Deliberately valid but stale: LoopDriver owns the final audit binding
      // and must prefer the compact identity carried beside the pending report.
      policy_trace_status: "complete",
      policy_trace_ref: "2026/08/10/policy/cccccccccccc-i1-dddddddddddd.json",
      policy_trace_sha256: "d".repeat(64),
    };
    const driver = new LoopDriver({
      repoRoot: repo,
      config: {
        ...defaultConfig,
        loop: { ...defaultConfig.loop, runTimeoutMs: 0 },
      },
      state,
      audit,
      orchestrator: {
        async runIteration() {
          return {
            verdict: "PASS" as const,
            costUsd: 0,
            durationMs: 1,
            signaturesThisIter: [],
            locationsThisIter: [],
            policySummary,
            summary,
          };
        },
      },
      stopHookActive: false,
      freshHeadSha: async () => null,
    });

    await driver.run();
    const events = readFileSync(audit.currentFilePath(), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)) as Array<{ event: string; run_summary?: RunSummary }>;
    const complete = events.find((event) => event.event === "run.complete")?.run_summary;
    expect(complete?.policy_trace_status).toBe(policySummary.status);
    expect(complete?.policy_trace_ref).toBe(policySummary.policy_trace_ref);
    expect(complete?.policy_trace_sha256).toBe(policySummary.policy_trace_sha256);
  });
});
