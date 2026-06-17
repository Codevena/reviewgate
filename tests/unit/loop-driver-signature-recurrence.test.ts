// tests/unit/loop-driver-signature-recurrence.test.ts
//
// #5: a single BLOCKING finding's signature recurring across maxSignatureRecurrence
// consecutive reviewed iterations escalates (signature-recurrence), even when the
// whole finding SET churns (so stuck-signatures does not fire).
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import type { IterationResult } from "../../src/core/orchestrator.ts";
import { StateStore } from "../../src/core/state-store.ts";
import type { RunSummary } from "../../src/schemas/audit-event.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import {
  auditDir,
  decisionsDir,
  decisionsPath,
  dirtyFlagPath,
  pendingJsonPath,
} from "../../src/utils/paths.ts";

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-sigrecur-"));
  writeFileSync(join(dir, "foo.ts"), "x");
  return dir;
}

function writeDirty(repo: string): void {
  writeFileSync(
    dirtyFlagPath(repo),
    JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
  );
}

function critFinding(signature: string): Finding {
  return {
    id: "F-001",
    signature,
    severity: "CRITICAL",
    category: "security",
    rule_id: "r",
    file: "foo.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
  };
}

function writePending(repo: string, findings: Finding[]): void {
  writeFileSync(
    pendingJsonPath(repo),
    JSON.stringify({
      schema: "reviewgate.pending.v1",
      run_id: "r",
      iter: 3,
      max_iter: 10,
      verdict: "FAIL",
      counts: {
        critical: findings.filter((f) => f.severity === "CRITICAL").length,
        warn: 0,
        info: 0,
      },
      reviewers: [
        {
          id: "codex",
          provider: "codex",
          model: "m",
          persona: "security",
          status: "ok",
          cost_usd: 0,
          duration_ms: 1,
        },
      ],
      findings,
      cost_usd_total: 0,
      duration_ms_total: 1,
      generated_at: "2026-06-17T00:00:00Z",
      git: { sha: "abc1234", branch: "main", dirty_files: ["foo.ts"] },
    }),
  );
}

const PASS_SUMMARY: RunSummary = {
  verdict: "PASS",
  source: "panel",
  counts: { critical: 0, warn: 0, info: 0 },
  cost_usd: 0,
  duration_ms: 1,
  demoted: 0,
  signatures: [],
  providers: [],
};
// When the per-signature precondition does NOT fire, run() reaches runIteration →
// PASS → re-arm (no escalation). When it DOES fire, the precondition early-returns
// before runIteration, so this is never called.
const passStub = {
  runIteration: async (): Promise<IterationResult> => ({
    verdict: "PASS" as const,
    costUsd: 0,
    durationMs: 1,
    signaturesThisIter: [],
    summary: PASS_SUMMARY,
  }),
};

function driver(repo: string, state: StateStore, config = defaultConfig): LoopDriver {
  return new LoopDriver({
    repoRoot: repo,
    config,
    state,
    audit: new AuditLogger(auditDir(repo)),
    orchestrator: passStub,
    stopHookActive: false,
  });
}

const escMd = (repo: string) => join(repo, ".reviewgate", "ESCALATION.md");
// maxIterations 10 so the max-iterations check never fires; stuckThreshold default 2;
// maxSignatureRecurrence default 3. signature_history rows have DIFFERENT sets (churn)
// sharing only "s1", so whole-set stuck does not fire.
const CFG = { ...defaultConfig, loop: { ...defaultConfig.loop, maxIterations: 10 } };

describe("#5 per-signature recurrence escalation", () => {
  it("escalates signature-recurrence when one blocking sig recurs across the threshold (set churns)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXSR000001");
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      signature_history: [
        ["s1", "a"],
        ["s1", "b"],
        ["s1", "c"],
      ],
    }));
    writePending(repo, [critFinding("s1")]);
    writeDirty(repo);

    const decision = await driver(repo, state, CFG).run();

    expect(decision.kind).toBe("block");
    expect(decision.reason).toMatch(/ESCALATED/);
    expect(decision.reason).toMatch(/signature-recurrence/);
    expect(existsSync(escMd(repo))).toBe(true);
    const st = await state.load();
    expect(st.escalation_reason).toBe("signature-recurrence");
  });

  it("does NOT escalate below the threshold (only 2 recurring rows)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXSR000002");
    await state.update((cur) => ({
      ...cur,
      iteration: 2,
      signature_history: [
        ["s1", "a"],
        ["s1", "b"],
      ],
    }));
    writePending(repo, [critFinding("s1")]);
    writeDirty(repo);

    await driver(repo, state, CFG).run();
    expect(existsSync(escMd(repo))).toBe(false);
  });

  it("does NOT escalate when the recurring sig is only an INFO/advisory finding (not blocking)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXSR000003");
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      signature_history: [
        ["s1", "a"],
        ["s1", "b"],
        ["s1", "c"],
      ],
    }));
    writePending(repo, [{ ...critFinding("s1"), severity: "INFO" }]); // s1 is INFO → not blocking
    writeDirty(repo);

    await driver(repo, state, CFG).run();
    expect(existsSync(escMd(repo))).toBe(false);
  });

  it("does NOT escalate (off-ramp grace) when the agent rejected the sig in the just-completed iteration", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXSR000004");
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      signature_history: [
        ["s1", "a"],
        ["s1", "b"],
        ["s1", "c"],
      ],
    }));
    writePending(repo, [critFinding("s1")]);
    // The agent rejected F-001 (signature s1) in iteration 3's decisions → off-ramp grace.
    mkdirSync(decisionsDir(repo), { recursive: true });
    writeFileSync(
      decisionsPath(repo, 3),
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "F-001", verdict: "rejected", reason: "false positive — the cited symbol is defined two lines above", reviewer_was_wrong: true })}\n`,
    );
    writeDirty(repo);

    await driver(repo, state, CFG).run();
    expect(existsSync(escMd(repo))).toBe(false);
  });

  it("does NOT escalate when maxSignatureRecurrence is 0 (disabled)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXSR000005");
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      signature_history: [
        ["s1", "a"],
        ["s1", "b"],
        ["s1", "c"],
      ],
    }));
    writePending(repo, [critFinding("s1")]);
    writeDirty(repo);
    const cfg = {
      ...defaultConfig,
      loop: { ...defaultConfig.loop, maxIterations: 10, maxSignatureRecurrence: 0 },
    };

    await driver(repo, state, cfg).run();
    expect(existsSync(escMd(repo))).toBe(false);
  });
});
