// tests/unit/gate-skip-lock.test.ts
//
// M-A1 — On a stop with NOTHING to review (no dirty.flag AND HEAD has not advanced
// past the last reviewed sha) the gate must short-circuit to allow_stop WITHOUT
// acquiring the global lock or doing git/pipeline work. This removes lock
// contention for pure read/analysis turns — the dominant multi-session pain.
// The HEAD-advance check is preserved so committed-via-Bash work is still reviewed.
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate, stopHasNothingToReview } from "../../src/cli/commands/gate.ts";
import { StateStore } from "../../src/core/state-store.ts";
import { flock } from "../../src/utils/flock.ts";
import { dirtyFlagPath, gateLockPath, reviewgateDir } from "../../src/utils/paths.ts";

function freshRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(reviewgateDir(repo), { recursive: true });
  return repo;
}

describe("stopHasNothingToReview", () => {
  it("true when no dirty flag and the repo was never reviewed (last sha null)", async () => {
    const repo = freshRepo("rg-skip-null-");
    await new StateStore(repo).initialise("01HSKIP001");
    expect(await stopHasNothingToReview(repo, async () => "anysha")).toBe(true);
  });

  it("true when no dirty flag and HEAD is unchanged since the last review", async () => {
    const repo = freshRepo("rg-skip-same-");
    const state = new StateStore(repo);
    await state.initialise("01HSKIP002");
    await state.update((cur) => ({ ...cur, last_reviewed_head_sha: "abc123" }));
    expect(await stopHasNothingToReview(repo, async () => "abc123")).toBe(true);
  });

  it("false when HEAD advanced past the last review (committed-via-Bash must still be reviewed)", async () => {
    const repo = freshRepo("rg-skip-adv-");
    const state = new StateStore(repo);
    await state.initialise("01HSKIP003");
    await state.update((cur) => ({ ...cur, last_reviewed_head_sha: "abc123" }));
    expect(await stopHasNothingToReview(repo, async () => "def456")).toBe(false);
  });

  it("false when a dirty flag is present (there IS something to review)", async () => {
    const repo = freshRepo("rg-skip-dirty-");
    await new StateStore(repo).initialise("01HSKIP004");
    writeFileSync(
      dirtyFlagPath(repo),
      JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
    );
    expect(await stopHasNothingToReview(repo, async () => "abc123")).toBe(false);
  });
});

describe("runGate — no-change stop skips the lock", () => {
  it("returns GATE OPEN without acquiring the lock even while it is held", async () => {
    const repo = freshRepo("rg-skip-int-");
    await new StateStore(repo).initialise("01HSKIP010"); // last_reviewed_head_sha = null, no dirty flag
    // Hold the lock: if runGate TRIED to acquire it, it would fail CLOSED (block
    // "in progress") within lockTimeoutMs. A1 must skip the lock → allow_stop.
    const held = await flock(gateLockPath(repo));
    try {
      const out = await runGate({
        repoRoot: repo,
        hook: "stop",
        hookStdinRaw: "{}",
        lockTimeoutMs: 200,
      });
      expect(out.stdout).toBe(""); // no block decision emitted
      expect(out.stderr.toLowerCase()).toContain("no code changes");
    } finally {
      await held.release();
    }
  });
});
