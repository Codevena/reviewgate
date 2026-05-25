// tests/unit/gate-lock.test.ts
//
// The stop-hook gate run is serialized by a gate lock so two stop-hooks on the
// same checkout can't run reviews in parallel and interleave writes to
// pending.*, decisions, and the dirty flag. On lock-acquire contention the gate
// FAILS CLOSED (block "in progress — re-run") rather than running unsynchronized
// or letting an unreviewed turn through.
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../../src/cli/commands/gate.ts";
import { flock } from "../../src/utils/flock.ts";
import { dirtyFlagPath, gateLockPath, reviewgateDir } from "../../src/utils/paths.ts";

describe("gate stop-hook lock", () => {
  it("fails CLOSED (block) when the gate lock is already held", async () => {
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
        hookStdinRaw: "{}",
        lockTimeoutMs: 200, // fail closed fast while the lock is held
      });
      const parsed = JSON.parse(out.stdout || "{}") as { decision?: string; reason?: string };
      expect(parsed.decision).toBe("block");
      expect(parsed.reason).toContain("in progress");
    } finally {
      await held.release();
    }
  });
});
