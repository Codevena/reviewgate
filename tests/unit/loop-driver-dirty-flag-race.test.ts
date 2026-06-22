// tests/unit/loop-driver-dirty-flag-race.test.ts
//
// F-05/F-16: the dirty.flag is read ONCE at run start, but the unlink on PASS /
// escalation deleted whatever was on disk at that moment. The async PostToolUse
// trigger is NOT serialized by the gate lock, so a parallel session could
// atomically rewrite the flag DURING the multi-minute panel — and the unlink
// destroyed the fresh flag even though its batch was never reviewed (the other
// session's next stop then sees no flag + unchanged HEAD → allow_stop →
// unreviewed code ships). Post-fix the unlink is compare-and-delete: a flag
// whose ts/diff_hash no longer match the one captured at run start survives.
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import type { IterationResult } from "../../src/core/orchestrator.ts";
import { StateStore } from "../../src/core/state-store.ts";
import type { RunSummary } from "../../src/schemas/audit-event.ts";
import { auditDir, dirtyFlagPath } from "../../src/utils/paths.ts";

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-flag-race-"));
  writeFileSync(join(dir, "foo.ts"), "x");
  return dir;
}

function writeFlag(repo: string, diffHash: string, ts: string): void {
  writeFileSync(dirtyFlagPath(repo), JSON.stringify({ diff_hash: diffHash, ts }));
}

function summaryOf(verdict: RunSummary["verdict"], critical = 0, warn = 0): RunSummary {
  return {
    verdict,
    source: "panel",
    counts: { critical, warn, info: 0 },
    cost_usd: 0,
    duration_ms: 1,
    demoted: 0,
    signatures: [],
    providers: [],
    // G0: clean summary — these fixtures cover genuine (never-demoted) verdicts incl. a
    // natively-non-failing CRITICAL (F-06), which is NOT a value-judgment demote → 0.
    from_critical_demoted: 0,
  };
}

describe("dirty.flag compare-and-delete (F-05/F-16)", () => {
  it("PASS keeps a flag that was rewritten mid-review (concurrent trigger) for the next stop", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXF05PASS");
    writeFlag(repo, "orig", new Date().toISOString());
    // The panel "runs" → a concurrent session's trigger rewrites the flag with a
    // batch this review never saw (fresh ts + diff_hash, as handleTrigger does).
    const stub = {
      runIteration: async (): Promise<IterationResult> => {
        writeFlag(repo, "newer", new Date(Date.now() + 1000).toISOString());
        return {
          verdict: "PASS" as const,
          costUsd: 0,
          durationMs: 1,
          signaturesThisIter: [],
          summary: summaryOf("PASS"),
        };
      },
    };
    const decision = await new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: stub,
      stopHookActive: false,
    }).run();
    expect(decision.kind).toBe("allow_stop"); // THIS run's verdict is honored …
    // … but the NEWER flag survives so the next stop reviews the other batch.
    expect(existsSync(dirtyFlagPath(repo))).toBe(true);
    const kept = JSON.parse(readFileSync(dirtyFlagPath(repo), "utf8")) as { diff_hash?: string };
    expect(kept.diff_hash).toBe("newer");
    expect((await state.load()).iteration).toBe(0); // the PASS still re-armed
  });

  it("PASS still deletes an UNCHANGED flag (no spurious re-review)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXF05CLEAN");
    writeFlag(repo, "orig", new Date().toISOString());
    const stub = {
      runIteration: async (): Promise<IterationResult> => ({
        verdict: "PASS" as const,
        costUsd: 0,
        durationMs: 1,
        signaturesThisIter: [],
        summary: summaryOf("PASS"),
      }),
    };
    const decision = await new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: stub,
      stopHookActive: false,
    }).run();
    expect(decision.kind).toBe("allow_stop");
    expect(existsSync(dirtyFlagPath(repo))).toBe(false);
  });

  it("escalation keeps a flag rewritten mid-review (its captured base must not be lost)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXF05ESC");
    // Defer cap exhausted → handleInfraUnavailable escalates AFTER the panel ran,
    // i.e. across the same multi-minute race window as the PASS path.
    await state.update((cur) => ({ ...cur, iteration: 1, consecutive_infra_defers: 2 }));
    writeFlag(repo, "orig", new Date().toISOString());
    const stub = {
      runIteration: async (): Promise<IterationResult> => {
        writeFlag(repo, "newer", new Date(Date.now() + 1000).toISOString());
        return {
          verdict: "ERROR" as const,
          allReviewersInfraFailed: true,
          costUsd: 0,
          durationMs: 1,
          signaturesThisIter: [],
          summary: summaryOf("ERROR"),
        };
      },
    };
    const decision = await new LoopDriver({
      repoRoot: repo,
      config: { ...defaultConfig, loop: { ...defaultConfig.loop, infraDeferMaxConsecutive: 2 } },
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: stub,
      stopHookActive: false,
    }).run();
    expect(decision.reason).toMatch(/ESCALAT/i);
    expect(existsSync(dirtyFlagPath(repo))).toBe(true); // newer batch preserved
    const kept = JSON.parse(readFileSync(dirtyFlagPath(repo), "utf8")) as { diff_hash?: string };
    expect(kept.diff_hash).toBe("newer");
  });

  it("escalation still deletes an UNCHANGED flag (announce → re-stop terminates)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXF05ESCCLEAN");
    // stuck-signatures precondition → escalates without running the panel.
    await state.update((cur) => ({
      ...cur,
      iteration: 2,
      signature_history: [["s"], ["s"]],
    }));
    writeFlag(repo, "orig", new Date().toISOString());
    const stub = {
      runIteration: async (): Promise<IterationResult> => {
        throw new Error("panel must not run — precondition escalates first");
      },
    };
    const decision = await new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: stub,
      stopHookActive: false,
    }).run();
    expect(decision.reason).toMatch(/ESCALAT/i);
    expect(existsSync(dirtyFlagPath(repo))).toBe(false); // unchanged flag consumed
  });
});

describe("SOFT-PASS open-gate message includes the critical count (F-06 visibility)", () => {
  it("reports CRITICAL + WARN counts when a non-failing CRITICAL reaches SOFT-PASS", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXF06SOFTMSG");
    writeFlag(repo, "h", new Date().toISOString());
    const stub = {
      runIteration: async (): Promise<IterationResult> => ({
        verdict: "SOFT-PASS" as const,
        costUsd: 0,
        durationMs: 1,
        signaturesThisIter: ["sig-c1"],
        summary: summaryOf("SOFT-PASS", 1, 2),
      }),
    };
    const decision = await new LoopDriver({
      repoRoot: repo,
      config: defaultConfig, // softPassPolicy "allow" → the allow_stop message path
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: stub,
      stopHookActive: false,
    }).run();
    expect(decision.kind).toBe("allow_stop");
    expect(decision.reason).toContain("1 CRITICAL");
    expect(decision.reason).toContain("2 WARN");
  });

  it("omits the CRITICAL segment when there are none (no noisy '0 CRITICAL')", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXF06SOFTW");
    writeFlag(repo, "h", new Date().toISOString());
    const stub = {
      runIteration: async (): Promise<IterationResult> => ({
        verdict: "SOFT-PASS" as const,
        costUsd: 0,
        durationMs: 1,
        signaturesThisIter: ["sig-w1"],
        summary: summaryOf("SOFT-PASS", 0, 1),
      }),
    };
    const decision = await new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: stub,
      stopHookActive: false,
    }).run();
    expect(decision.kind).toBe("allow_stop");
    expect(decision.reason).toContain("1 WARN");
    expect(decision.reason).not.toContain("CRITICAL");
  });
});
