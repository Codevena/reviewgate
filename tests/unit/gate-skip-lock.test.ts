// tests/unit/gate-skip-lock.test.ts
//
// M-A1 — On a stop with NOTHING to review (no dirty.flag AND HEAD has not advanced
// past the last reviewed sha AND the working tree is byte-identical to the last
// review, S1) the gate must short-circuit to allow_stop WITHOUT acquiring the
// global lock or doing the full pipeline work. This removes lock contention for
// pure read/analysis turns — the dominant multi-session pain. The HEAD-advance
// check is preserved so committed-via-Bash work is still reviewed; the S1
// tree-hash check additionally catches an uncommitted Bash-tool edit (see
// tests/unit/stop-fast-exit-tree-probe.test.ts for the dedicated S1 coverage).
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate, stopProbe } from "../../src/cli/commands/gate.ts";
import { StateStore } from "../../src/core/state-store.ts";
import { flock } from "../../src/utils/flock.ts";
import { gitHeadSha, workingTreeStateHash } from "../../src/utils/git.ts";
import { dirtyFlagPath, gateLockPath, reviewgateDir } from "../../src/utils/paths.ts";

function freshRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(reviewgateDir(repo), { recursive: true });
  return repo;
}

function gitRepo(prefix: string): string {
  const repo = freshRepo(prefix);
  const run = (...a: string[]) => execFileSync("git", a, { cwd: repo });
  run("init", "-q");
  run("config", "user.email", "t@t.t");
  run("config", "user.name", "t");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  run("add", "a.ts");
  run("commit", "-qm", "init");
  return repo;
}

describe("stopProbe", () => {
  it("'review' when no dirty flag and the repo was never reviewed (last sha null) — S1 closes the core-loop#2 hole", async () => {
    const repo = freshRepo("rg-skip-null-");
    await new StateStore(repo).initialise("01HSKIP001");
    expect(await stopProbe(repo, async () => "anysha")).toBe("review");
  });

  it("'skip-clean' when no dirty flag, HEAD unchanged, AND the tree hash matches the last review", async () => {
    const repo = freshRepo("rg-skip-same-");
    const state = new StateStore(repo);
    await state.initialise("01HSKIP002");
    await state.update((cur) => ({
      ...cur,
      last_reviewed_head_sha: "abc123",
      last_reviewed_tree_hash: "T",
    }));
    expect(
      await stopProbe(
        repo,
        async () => "abc123",
        async () => "T",
      ),
    ).toBe("skip-clean");
  });

  it("'review' when HEAD advanced past the last review (committed-via-Bash must still be reviewed)", async () => {
    const repo = freshRepo("rg-skip-adv-");
    const state = new StateStore(repo);
    await state.initialise("01HSKIP003");
    await state.update((cur) => ({ ...cur, last_reviewed_head_sha: "abc123" }));
    expect(await stopProbe(repo, async () => "def456")).toBe("review");
  });

  it("'review' when a dirty flag is present (there IS something to review)", async () => {
    const repo = freshRepo("rg-skip-dirty-");
    await new StateStore(repo).initialise("01HSKIP004");
    writeFileSync(
      dirtyFlagPath(repo),
      JSON.stringify({ diff_hash: "h", ts: new Date().toISOString() }),
    );
    expect(await stopProbe(repo, async () => "abc123")).toBe("review");
  });
});

describe("runGate — no-change stop skips the lock", () => {
  it("returns GATE OPEN without acquiring the lock even while it is held", async () => {
    // S1: the fast-exit now also requires a matching tree hash, so this
    // integration test needs a REAL git repo with the state seeded to the
    // repo's actual current HEAD/tree (runGate calls stopProbe with the real
    // gitHeadSha/workingTreeStateHash, not injected stubs).
    const repo = gitRepo("rg-skip-int-");
    const sha = await gitHeadSha(repo);
    const tree = await workingTreeStateHash(repo);
    const state = new StateStore(repo);
    await state.initialise("01HSKIP010");
    await state.update((cur) => ({
      ...cur,
      last_reviewed_head_sha: sha,
      last_reviewed_tree_hash: tree,
    }));
    // Hold the lock: if runGate TRIED to acquire it, contention would DEFER (M-A2,
    // also allow_stop but with a deferred.flag). A1 must skip the lock entirely
    // BEFORE that — no deferred.flag, plain "No code changes".
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
