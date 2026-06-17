// tests/unit/loop-driver-location-recurrence.test.ts
//
// Non-convergence (field report 2026-06-17): a file:line REGION re-raised as a blocking finding
// across maxLocationRecurrence consecutive iterations escalates (location-recurrence), even when
// the SIGNATURE churns each round (so signature-recurrence does NOT fire). The field gold-case:
// install-prompt.tsx:72-73 raised 4 rounds under 4 different rule_ids with opposite actions.
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import type { IterationResult } from "../../src/core/orchestrator.ts";
import { StateStore } from "../../src/core/state-store.ts";
import type { RunSummary } from "../../src/schemas/audit-event.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import { auditDir, dirtyFlagPath, pendingJsonPath } from "../../src/utils/paths.ts";

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-locrecur-"));
  writeFileSync(join(dir, "foo.ts"), "x");
  return dir;
}
function writeDirty(repo: string): void {
  writeFileSync(
    dirtyFlagPath(repo),
    JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
  );
}
// A blocking finding on foo.ts:72 (region "foo.ts:70") with a CHURNING signature each round.
function finding(signature: string, severity: Finding["severity"] = "WARN"): Finding {
  return {
    id: "F-001",
    signature,
    severity,
    category: "quality",
    rule_id: signature, // different rule_id each round = the churn
    file: "foo.ts",
    line_start: 72,
    line_end: 73,
    message: "m",
    details: "d",
    reviewer: { provider: "claude-code", model: "m", persona: "security" },
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
        warn: findings.filter((f) => f.severity === "WARN").length,
        info: findings.filter((f) => f.severity === "INFO").length,
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
// maxIterations 10 so the cap/convergence check never fires (isolates location-recurrence).
const CFG = { ...defaultConfig, loop: { ...defaultConfig.loop, maxIterations: 10 } };
const REGION = "foo.ts:70"; // locationKey("foo.ts", 72)

describe("location-recurrence escalation", () => {
  it("escalates when a region recurs across the threshold under CHURNING signatures (sig-recurrence does NOT fire)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXLR000001");
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      // signatures all DIFFERENT (no signature-recurrence, no whole-set stuck)…
      signature_history: [["s1"], ["s2"], ["s3"]],
      // …but the SAME region every round → location-recurrence.
      location_history: [[REGION], [REGION], [REGION]],
    }));
    writePending(repo, [finding("s4")]); // a 4th distinct signature on the same region
    writeDirty(repo);

    const decision = await driver(repo, state, CFG).run();
    expect(decision.kind).toBe("block");
    expect(decision.reason).toMatch(/ESCALATED/);
    expect(decision.reason).toMatch(/location-recurrence/);
    expect(existsSync(escMd(repo))).toBe(true);
    expect((await state.load()).escalation_reason).toBe("location-recurrence");
  });

  it("does NOT escalate below the threshold (only 2 recurring rows)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXLR000002");
    await state.update((cur) => ({
      ...cur,
      iteration: 2,
      signature_history: [["s1"], ["s2"]],
      location_history: [[REGION], [REGION]],
    }));
    writePending(repo, [finding("s3")]);
    writeDirty(repo);
    await driver(repo, state, CFG).run();
    expect(existsSync(escMd(repo))).toBe(false);
  });

  it("does NOT escalate when the recurring region's finding is only INFO (not blocking)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXLR000003");
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      signature_history: [["s1"], ["s2"], ["s3"]],
      location_history: [[REGION], [REGION], [REGION]],
    }));
    writePending(repo, [finding("s4", "INFO")]); // region present but not blocking
    writeDirty(repo);
    await driver(repo, state, CFG).run();
    expect(existsSync(escMd(repo))).toBe(false);
  });

  it("does NOT escalate when maxLocationRecurrence is 0 (disabled)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXLR000004");
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      signature_history: [["s1"], ["s2"], ["s3"]],
      location_history: [[REGION], [REGION], [REGION]],
    }));
    writePending(repo, [finding("s4")]);
    writeDirty(repo);
    const cfg = {
      ...defaultConfig,
      loop: { ...defaultConfig.loop, maxIterations: 10, maxLocationRecurrence: 0 },
    };
    await driver(repo, state, cfg).run();
    expect(existsSync(escMd(repo))).toBe(false);
  });
});
