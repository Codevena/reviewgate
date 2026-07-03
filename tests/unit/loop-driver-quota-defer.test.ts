// tests/unit/loop-driver-quota-defer.test.ts
//
// #10: don't escalate the "give-up" reasons (soft max-iterations, stuck-signatures)
// while the reviewer panel is quota-degraded — DEFER (bounded) instead. cost-cap,
// the hard-cap max-iterations backstop, decisions-unaddressed, etc. still escalate.
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import type { ReviewgateConfig } from "../../src/config/define-config.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import type { IterationResult } from "../../src/core/orchestrator.ts";
import { QuotaCooldownStore } from "../../src/core/quota-cooldown.ts";
import { StateStore } from "../../src/core/state-store.ts";
import { auditDir, dirtyFlagPath } from "../../src/utils/paths.ts";

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-quota-defer-"));
  writeFileSync(join(dir, "foo.ts"), "x");
  return dir;
}

function writeDirty(repo: string): void {
  writeFileSync(
    dirtyFlagPath(repo),
    JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
  );
}

// The escalation preconditions early-return before any panel runs; this stub
// proves runIteration is never reached on the defer/escalate paths.
const neverRuns = {
  runIteration: async (): Promise<IterationResult> => {
    throw new Error(
      "orchestrator.runIteration must not run on the precondition defer/escalate path",
    );
  },
};

// Cap defaultConfig's sole reviewer provider ("codex") so quotaDegradationNote is non-null.
function capCodex(repo: string): void {
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  new QuotaCooldownStore(repo).record("codex", future, new Date());
}

function driver(repo: string, state: StateStore, config: ReviewgateConfig): LoopDriver {
  return new LoopDriver({
    repoRoot: repo,
    config,
    state,
    audit: new AuditLogger(auditDir(repo)),
    orchestrator: neverRuns,
    stopHookActive: false,
    freshHeadSha: async () => null, // S3b: unused stub for pre-existing fixtures
  });
}

const escPath = (repo: string) => join(repo, ".reviewgate", "ESCALATION.md");

describe("#10 quota-degraded escalation defer", () => {
  it("DEFERS the soft max-iterations escalation when the panel is degraded", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQD000001");
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      signature_history: [["s1"], ["s1"], ["s1"]],
    }));
    capCodex(repo);
    writeDirty(repo);

    const decision = await driver(repo, state, defaultConfig).run();

    expect(decision.kind).toBe("allow_stop");
    expect(decision.reason).toMatch(/DEFERRED/);
    expect(decision.reason).toMatch(/cooldown/i);
    const st = await state.load();
    expect(st.consecutive_quota_defers).toBe(1);
    expect(st.iteration).toBe(3);
    expect(st.escalated).toBe(false);
    expect(existsSync(dirtyFlagPath(repo))).toBe(true);
    expect(existsSync(escPath(repo))).toBe(false);
  });

  it("DEFERS the stuck-signatures escalation when the panel is degraded", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQD000002");
    await state.update((cur) => ({ ...cur, iteration: 2, signature_history: [["s1"], ["s1"]] }));
    capCodex(repo);
    writeDirty(repo);

    const decision = await driver(repo, state, defaultConfig).run();

    expect(decision.kind).toBe("allow_stop");
    expect(decision.reason).toMatch(/DEFERRED/);
    const st = await state.load();
    expect(st.consecutive_quota_defers).toBe(1);
    expect(st.iteration).toBe(2);
    expect(existsSync(escPath(repo))).toBe(false);
  });

  it("ESCALATES once the defer cap is exhausted (fail-closed backstop), with the degraded note", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQD000003");
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      signature_history: [["s1"], ["s1"], ["s1"]],
      consecutive_quota_defers: 3,
    }));
    capCodex(repo);
    writeDirty(repo);

    const decision = await driver(repo, state, defaultConfig).run();

    expect(decision.kind).toBe("block");
    expect(decision.reason).toMatch(/ESCALATED/);
    expect(decision.reason).toMatch(/degraded panel/);
    expect(existsSync(escPath(repo))).toBe(true);
    const st = await state.load();
    expect(st.escalated).toBe(true);
    expect(st.consecutive_quota_defers).toBe(0);
  });

  it("ESCALATES immediately when quotaDeferMaxConsecutive is 0 (defer disabled)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQD000004");
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      signature_history: [["s1"], ["s1"], ["s1"]],
    }));
    capCodex(repo);
    writeDirty(repo);
    const config = {
      ...defaultConfig,
      loop: { ...defaultConfig.loop, quotaDeferMaxConsecutive: 0 },
    };

    const decision = await driver(repo, state, config).run();

    expect(decision.kind).toBe("block");
    expect(decision.reason).toMatch(/ESCALATED/);
    expect(existsSync(escPath(repo))).toBe(true);
  });

  it("ESCALATES normally when the panel is NOT degraded (no cooldown)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQD000005");
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      signature_history: [["s1"], ["s1"], ["s1"]],
    }));
    writeDirty(repo);

    const decision = await driver(repo, state, defaultConfig).run();

    expect(decision.kind).toBe("block");
    expect(decision.reason).toMatch(/ESCALATED/);
    const st = await state.load();
    expect(st.consecutive_quota_defers).toBe(0);
  });

  it("does NOT defer cost-cap even when degraded (non-deferable)", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQD000006");
    await state.update((cur) => ({ ...cur, iteration: 1, cost_usd_so_far: 2 }));
    capCodex(repo);
    writeDirty(repo);
    const config = { ...defaultConfig, loop: { ...defaultConfig.loop, costCapUsd: 1 } };

    const decision = await driver(repo, state, config).run();

    expect(decision.reason).toMatch(/ESCALATED/);
    expect(existsSync(escPath(repo))).toBe(true);
    const st = await state.load();
    expect(st.consecutive_quota_defers).toBe(0);
  });

  it("does NOT defer the hard-cap max-iterations backstop even when degraded", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQD000007");
    await state.update((cur) => ({
      ...cur,
      iteration: 6,
      signature_history: [["s1"], ["s1"], ["s1"]],
    }));
    capCodex(repo);
    writeDirty(repo);

    const decision = await driver(repo, state, defaultConfig).run();

    expect(decision.reason).toMatch(/ESCALATED/);
    expect(existsSync(escPath(repo))).toBe(true);
    const st = await state.load();
    expect(st.consecutive_quota_defers).toBe(0);
  });
});
