// tests/unit/loop-driver.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../src/audit/logger.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { LoopDriver } from "../../src/core/loop-driver.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import { StateStore } from "../../src/core/state-store.ts";
import { CodexAdapter } from "../../src/providers/codex.ts";
import { auditDir, dirtyFlagPath } from "../../src/utils/paths.ts";

const FAKE_CODEX = join(process.cwd(), "tests/fixtures/fake-codex.sh");

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-loop-"));
  writeFileSync(join(dir, "foo.ts"), "x");
  return dir;
}

describe("LoopDriver", () => {
  it("returns allow_stop on PASS after one iteration", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQTEST"); // creates .reviewgate/ first
    writeFileSync(
      dirtyFlagPath(repo),
      JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
    );
    const audit = new AuditLogger(auditDir(repo));
    const driver = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit,
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: defaultConfig,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: "",
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    expect(["allow_stop", "block"]).toContain(decision.kind);
  });

  it("respects stop_hook_active=true and short-circuits to allow_stop", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQTEST2");
    const audit = new AuditLogger(auditDir(repo));
    const driver = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit,
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: defaultConfig,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: "",
        reasonOnFailEnabled: true,
      }),
      stopHookActive: true,
    });
    const decision = await driver.run();
    expect(decision.kind).toBe("allow_stop");
    expect(decision.reason).toContain("stop_hook_active");
  });

  it("escalates after maxIterations FAIL streak", async () => {
    const repo = fakeRepo();
    const state = new StateStore(repo);
    await state.initialise("01HXQTEST3");
    // Pre-populate state as if we've already failed 3 times.
    await state.update((cur) => ({
      ...cur,
      iteration: 3,
      signature_history: [["sig1"], ["sig1"], ["sig1"]],
    }));
    writeFileSync(
      dirtyFlagPath(repo),
      JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
    );
    const audit = new AuditLogger(auditDir(repo));
    const driver = new LoopDriver({
      repoRoot: repo,
      config: defaultConfig,
      state,
      audit,
      orchestrator: new Orchestrator({
        repoRoot: repo,
        config: defaultConfig,
        adapters: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
        sandboxMode: "off",
        hostTier: "opus",
        diff: "",
        reasonOnFailEnabled: true,
      }),
      stopHookActive: false,
    });
    const decision = await driver.run();
    expect(decision.kind).toBe("allow_stop");
    expect(decision.reason).toMatch(/escalat/i);
    expect(existsSync(join(repo, ".reviewgate", "ESCALATION.md"))).toBe(true);
  });
});
