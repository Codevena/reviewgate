// tests/unit/gate-lock.test.ts
//
// The stop-hook gate run is serialized by a gate lock so two stop-hooks on the
// same checkout can't run reviews in parallel and interleave writes to pending.*,
// decisions, and the dirty flag. M-A2 (D-1 fail-safe-degrade): on lock-acquire
// CONTENTION the gate no longer fails closed (block) — that busy-looped every
// parallel session. It now DEFERS: allow_stop + a deferred.flag so the change is
// still reviewed on the next turn. (Detailed defer behavior: gate-defer.test.ts.)
import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../../src/cli/commands/gate.ts";
import { flock } from "../../src/utils/flock.ts";
import {
  deferredFlagPath,
  dirtyFlagPath,
  gateLockPath,
  reviewgateDir,
} from "../../src/utils/paths.ts";

describe("gate stop-hook lock", () => {
  it("DEFERS (allow_stop, not block) when the gate lock is already held", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-gate-lock-"));
    mkdirSync(reviewgateDir(repo), { recursive: true });
    writeFileSync(
      dirtyFlagPath(repo),
      JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
    );
    // Hold the lock so runGate cannot acquire it within its short test timeout.
    const held = await flock(gateLockPath(repo));
    try {
      const out = await runGate({
        repoRoot: repo,
        hook: "stop",
        snapshotVerifyOpts: { dwellMs: 0 },
        hookStdinRaw: "{}",
        lockTimeoutMs: 200, // defer fast while the lock is held
      });
      // allow_stop (empty stdout, no block decision) + a deferred.flag, NOT a block.
      expect(out.stdout).toBe("");
      expect(out.stderr.toLowerCase()).toContain("deferred");
      expect(existsSync(deferredFlagPath(repo))).toBe(true);
    } finally {
      await held.release();
    }
  });
});
