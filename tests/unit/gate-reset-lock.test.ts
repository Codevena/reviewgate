// tests/unit/gate-reset-lock.test.ts
// F-002(b): the reset (SessionStart) hook deletes state/decisions/pending. It must
// take the SAME gate lock the stop path uses, so it can't race a concurrent in-flight
// stop-gate and rmSync state out from under it (torn reads / corrupted review).
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../../src/cli/commands/gate.ts";
import { flock, readLockHolder } from "../../src/utils/flock.ts";
import {
  dirtyFlagPath,
  gateLockPath,
  reviewgateDir,
  stateJsonPath,
} from "../../src/utils/paths.ts";

function seedRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "rg-gate-reset-lock-"));
  mkdirSync(reviewgateDir(repo), { recursive: true });
  writeFileSync(
    dirtyFlagPath(repo),
    JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
  );
  writeFileSync(stateJsonPath(repo), JSON.stringify({ iteration: 3 }));
  return repo;
}

describe("gate reset hook locking", () => {
  it("acquires + releases the gate lock around the reset (no leftover lock)", async () => {
    const repo = seedRepo();
    const out = await runGate({ repoRoot: repo, hook: "reset", hookStdinRaw: "{}" });
    expect(out.exitCode).toBe(0);
    // State was cleared — S1: re-seeded fresh (not left absent), so the very
    // next Stop has an honest baseline instead of a last===null fast-exit
    // (core-loop#2). Assert it's the FRESH state, not the old iteration:3 stub.
    expect(existsSync(stateJsonPath(repo))).toBe(true);
    const st = JSON.parse(readFileSync(stateJsonPath(repo), "utf8"));
    expect(st.iteration).toBe(0);
    expect(existsSync(dirtyFlagPath(repo))).toBe(false);
    // Lock was released (not leaked) afterwards.
    expect(readLockHolder(gateLockPath(repo))).toBeNull();
  });

  it("falls back to an unlocked reset (with a warning) when the lock is held by a stop-gate", async () => {
    const repo = seedRepo();
    // Simulate an in-flight stop-gate holding the lock.
    const held = await flock(gateLockPath(repo));
    try {
      const out = await runGate({
        repoRoot: repo,
        hook: "reset",
        hookStdinRaw: "{}",
        lockTimeoutMs: 150, // give up quickly rather than stall session start
      });
      expect(out.exitCode).toBe(0);
      // It still re-armed (best-effort) and warned that it ran without the lock.
      expect(out.stderr.toLowerCase()).toContain("without the gate lock");
    } finally {
      await held.release();
    }
  });
});
