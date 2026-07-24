// tests/unit/gate-setup-budget.test.ts
//
// M-A0.2 — The PRE-deadline setup work (collectGitInfo + collectDiff) runs
// OUTSIDE the loop self-deadline (runTimeoutMs). Under git index.lock contention
// from parallel sessions it can run minutes and get the gate OS-killed mid-run
// with empty stdout = silent fail-OPEN ("stop hook 2/3 then disappears"). The
// setup must be bounded: on overrun, fail CLOSED with a clear block instead.
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate, runGateSafe } from "../../src/cli/commands/gate.ts";
import { defineConfig } from "../../src/config/define-config.ts";
import { dirtyFlagPath, reviewgateDir } from "../../src/utils/paths.ts";

const resolvedConfig = defineConfig({});

describe("gate setup budget", () => {
  it("fails CLOSED when review setup (git/diff) exceeds the setup budget", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-setup-budget-"));
    mkdirSync(reviewgateDir(repo), { recursive: true });
    writeFileSync(
      dirtyFlagPath(repo),
      JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
    );
    const out = await runGate({
      repoRoot: repo,
      hook: "stop",
      snapshotVerifyOpts: { dwellMs: 0 },
      hookStdinRaw: "{}",
      setupBudgetMs: 60, // tiny so the test is fast
      // Keep this test scoped to the intended git/diff phase. A real control-plane
      // load can consume the deliberately tiny budget on a saturated CI host and
      // turn this into a config-load test instead.
      loadConfigFn: async () => resolvedConfig,
      // collectGitInfo that never resolves → simulates a git op wedged on index.lock.
      collectGitInfoFn: () => new Promise<never>(() => {}),
    });
    const parsed = JSON.parse(out.stdout || "{}") as { decision?: string; reason?: string };
    expect(parsed.decision).toBe("block");
    expect(parsed.reason?.toLowerCase()).toContain("setup");
  }, 5_000);

  it("fails CLOSED when config load hangs (bound loadEffectiveConfig — codex CRITICAL fix)", async () => {
    // loadEffectiveConfig runs BEFORE the lock + setup budget. A hanging config
    // import (or stuck fs read) must not leave the stop hook alive with empty
    // stdout (fail-open). runGateSafe converts the bounded timeout into a block.
    const repo = mkdtempSync(join(tmpdir(), "rg-cfg-hang-"));
    const out = await runGateSafe({
      repoRoot: repo,
      hook: "stop",
      snapshotVerifyOpts: { dwellMs: 0 },
      hookStdinRaw: "{}",
      setupBudgetMs: 60,
      loadConfigFn: () => new Promise<never>(() => {}), // config import wedged
    });
    const parsed = JSON.parse(out.stdout || "{}") as { decision?: string; reason?: string };
    expect(parsed.decision).toBe("block");
  }, 5_000);

  it("config + git setup SHARE one setup deadline (sum bounded, not per-phase) — codex CRITICAL fix", async () => {
    // The phases must not each get the FULL budget (their sum would exceed the OS
    // Stop-hook timeout → fail-open). With a 300ms budget and a config that takes
    // 200ms, the hanging git setup must time out on the REMAINING ~100ms (total
    // ≈300ms), NOT on a fresh 300ms (total ≈500ms).
    const repo = mkdtempSync(join(tmpdir(), "rg-setup-shared-"));
    mkdirSync(reviewgateDir(repo), { recursive: true });
    writeFileSync(
      dirtyFlagPath(repo),
      JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
    );
    const start = Date.now();
    const out = await runGateSafe({
      repoRoot: repo,
      hook: "stop",
      snapshotVerifyOpts: { dwellMs: 0 },
      hookStdinRaw: "{}",
      setupBudgetMs: 300,
      loadConfigFn: async (o) => {
        await new Promise((r) => setTimeout(r, 200));
        void o;
        return resolvedConfig;
      },
      collectGitInfoFn: () => new Promise<never>(() => {}), // git setup hangs
    });
    const elapsed = Date.now() - start;
    const parsed = JSON.parse(out.stdout || "{}") as { decision?: string };
    expect(parsed.decision).toBe("block");
    // Shared budget ⇒ ≈300ms total; per-phase (unshared) would be ≈500ms.
    expect(elapsed).toBeLessThan(420);
  }, 5_000);
});
