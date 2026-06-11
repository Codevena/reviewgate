// tests/unit/loop-driver-absorb-preconditions.test.ts
//
// F-04: absorbPriorDecisions used to run INSIDE the iteration>0 block, AFTER the
// cost-cap / max-iterations / stuck-signatures escalation preconditions had
// already early-returned via escalateAndDecide. When one of them fired, the
// final iteration's decisions (incl. reviewer_was_wrong rejections — the exact
// FP-ledger/reputation learn signal) were never consumed, and the loss was
// permanent: the post-escalation re-arm resets iteration to 0 and clears the
// decisions files before any later absorb could read them. The fix hoists the
// absorb call ABOVE those preconditions.
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import { StateStore } from "../../src/core/state-store.ts";
import type { RunSummary } from "../../src/schemas/audit-event.ts";
import { auditDir, decisionsPath, dirtyFlagPath, pendingJsonPath } from "../../src/utils/paths.ts";

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-absorb-pre-"));
  writeFileSync(join(dir, "foo.ts"), "x");
  return dir;
}

function writeDirty(repo: string): void {
  writeFileSync(
    dirtyFlagPath(repo),
    JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
  );
}

// A pending.json finding that learnFromDecisions/learnReputationFromDecisions can
// map to a (signature, provider) pair (same shape as the shoal regression test).
function writePending(repo: string, signature: string): void {
  writeFileSync(
    pendingJsonPath(repo),
    JSON.stringify({
      findings: [
        {
          id: "F-001",
          signature,
          severity: "CRITICAL",
          category: "correctness",
          rule_id: "phantom-race",
          file: "lib/foo.ts",
          line_start: 1,
          line_end: 1,
          message: "phantom",
          details: "details",
          reviewer: { provider: "opencode", model: "default", persona: "security" },
          confidence: 0.9,
          consensus: "singleton",
        },
      ],
    }),
  );
}

function writeRejection(repo: string, iter: number): void {
  const dp = decisionsPath(repo, iter);
  mkdirSync(dirname(dp), { recursive: true });
  writeFileSync(
    dp,
    `${JSON.stringify({
      schema: "reviewgate.decision.v1",
      finding_id: "F-001",
      verdict: "rejected",
      reason: "confirmed false positive, the claimed race does not exist at this line",
      reviewer_was_wrong: true,
    })}\n`,
  );
}

// A stub that must NEVER run — every test escalates at a PRECONDITION, before a
// new iteration is started. If it runs, the precondition under test didn't fire.
const neverRunStub = (ran: { value: boolean }) => ({
  runIteration: async () => {
    ran.value = true;
    const summary: RunSummary = {
      verdict: "PASS",
      source: "panel",
      counts: { critical: 0, warn: 0, info: 0 },
      cost_usd: 0,
      duration_ms: 1,
      demoted: 0,
      signatures: [],
      providers: [],
    };
    return {
      verdict: "PASS" as const,
      costUsd: 0,
      durationMs: 1,
      signaturesThisIter: [],
      summary,
    };
  },
});

const fpConfig = {
  ...defaultConfig,
  phases: { ...defaultConfig.phases, fpLedger: { enabled: true } },
};

describe("absorbPriorDecisions runs BEFORE the escalation preconditions (F-04)", () => {
  it("stuck-signatures escalation still absorbs the final iteration's FP/reputation signal", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXF04STUCK");
    // Two identical non-empty signature rows → the stuck-signatures precondition
    // fires (default stuckThreshold 2) before the iteration>0 block is reached.
    await state.update((cur) => ({
      ...cur,
      iteration: 2,
      signature_history: [["sig-stuck"], ["sig-stuck"]],
    }));
    writeDirty(repo);
    writePending(repo, "f04-stuck-sig");
    writeRejection(repo, 2); // the agent's decisions for the just-completed iter 2
    const ran = { value: false };
    const decision = await new LoopDriver({
      repoRoot: repo,
      config: fpConfig,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: neverRunStub(ran),
      stopHookActive: false,
    }).run();
    expect(ran.value).toBe(false); // escalated at the precondition, no new panel
    expect(decision.reason).toContain("ESCALATED");
    expect((await state.load()).escalation_reason).toBe("stuck-signatures");
    // THE REGRESSION ASSERTIONS — pre-fix both stores stayed empty because the
    // stuck-signatures early-return preceded the absorb call:
    const fpPath = join(repo, ".reviewgate", "learnings", "known_fp.jsonl");
    expect(existsSync(fpPath)).toBe(true);
    const fp = JSON.parse(readFileSync(fpPath, "utf8")) as {
      entries: Array<{ signature: string; rejects: Array<{ provider: string }> }>;
    };
    expect(fp.entries.length).toBeGreaterThan(0);
    expect(fp.entries[0]?.signature).toBe("f04-stuck-sig");
    expect(fp.entries[0]?.rejects[0]?.provider).toBe("opencode");
    const repPath = join(repo, ".reviewgate", "reputation.json");
    expect(existsSync(repPath)).toBe(true);
    const rep = JSON.parse(readFileSync(repPath, "utf8")) as {
      reviewers: Record<string, { wrong: unknown[] }>;
    };
    expect(rep.reviewers["opencode:security"]?.wrong.length).toBeGreaterThan(0);
  });

  it("cost-cap escalation still absorbs the final iteration's FP signal", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXF04COST");
    // Over the (default $1.50) cost cap → the cost-cap precondition fires first.
    await state.update((cur) => ({ ...cur, iteration: 1, cost_usd_so_far: 2 }));
    writeDirty(repo);
    writePending(repo, "f04-cost-sig");
    writeRejection(repo, 1);
    const ran = { value: false };
    const decision = await new LoopDriver({
      repoRoot: repo,
      config: fpConfig,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: neverRunStub(ran),
      stopHookActive: false,
    }).run();
    expect(ran.value).toBe(false);
    expect(decision.reason).toContain("ESCALATED");
    expect((await state.load()).escalation_reason).toBe("cost-cap");
    const fpPath = join(repo, ".reviewgate", "learnings", "known_fp.jsonl");
    expect(existsSync(fpPath)).toBe(true);
    const fp = JSON.parse(readFileSync(fpPath, "utf8")) as {
      entries: Array<{ signature: string }>;
    };
    expect(fp.entries[0]?.signature).toBe("f04-cost-sig");
  });

  it("max-iterations (hard cap) escalation still absorbs the final iteration's FP signal", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXF04MAXIT");
    // The hard backstop (2× maxIterations) escalates UNCONDITIONALLY — no
    // convergence grace — so it pins the max-iterations early-return
    // deterministically without constructing a non-progressing history.
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      signature_history: [["a"], ["b"], ["c"]], // distinct rows → not the stuck check
    }));
    writeDirty(repo);
    writePending(repo, "f04-maxit-sig");
    writeRejection(repo, 3);
    const ran = { value: false };
    const cfg = {
      ...fpConfig,
      loop: { ...fpConfig.loop, maxIterations: 1 }, // hard cap = 2 ≤ iteration 3
    };
    const decision = await new LoopDriver({
      repoRoot: repo,
      config: cfg,
      state,
      audit: new AuditLogger(auditDir(repo)),
      orchestrator: neverRunStub(ran),
      stopHookActive: false,
    }).run();
    expect(ran.value).toBe(false);
    expect(decision.reason).toContain("ESCALATED");
    expect((await state.load()).escalation_reason).toBe("max-iterations");
    const fpPath = join(repo, ".reviewgate", "learnings", "known_fp.jsonl");
    expect(existsSync(fpPath)).toBe(true);
    const fp = JSON.parse(readFileSync(fpPath, "utf8")) as {
      entries: Array<{ signature: string }>;
    };
    expect(fp.entries[0]?.signature).toBe("f04-maxit-sig");
  });
});
