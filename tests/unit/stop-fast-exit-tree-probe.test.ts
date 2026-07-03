// tests/unit/stop-fast-exit-tree-probe.test.ts
//
// S1 — closes the Bash-mutation bypass: the old HEAD-only Stop fast-exit
// (stopHasNothingToReview) skipped an uncommitted shell edit (sed -i / tee /
// git apply, ...) entirely — no dirty.flag, no HEAD move, so the change
// shipped unreviewed (core-loop#2). stopProbe additionally compares a
// content-true working-tree fingerprint (workingTreeStateHash, Task 1)
// recorded at the last review against the CURRENT one; only an exact match
// on BOTH HEAD and tree fast-exits ("skip-clean"). Any mismatch or unknown
// (null) hash fails toward "review" (lock path).
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherReviewContext, stopProbe } from "../../src/cli/commands/gate.ts";
import { StateStore } from "../../src/core/state-store.ts";
import {
  collectDiff,
  collectGitInfo,
  gitHeadSha,
  workingTreeStateHash,
} from "../../src/utils/git.ts";
import { reviewgateDir } from "../../src/utils/paths.ts";

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

describe("stopProbe — working-tree probe (S1)", () => {
  test("no flag + HEAD unchanged + tree hash unchanged → skip-clean (fast exit)", async () => {
    const repo = freshRepo("rg-probe-clean-");
    const state = new StateStore(repo);
    await state.initialise("01PROBECLEAN");
    await state.update((cur) => ({
      ...cur,
      last_reviewed_head_sha: "H",
      last_reviewed_tree_hash: "T",
    }));
    expect(
      await stopProbe(
        repo,
        async () => "H",
        async () => "T",
      ),
    ).toBe("skip-clean");
  });

  test("no flag + HEAD unchanged + tree hash DIFFERS → review (Bash edit)", async () => {
    const repo = freshRepo("rg-probe-differs-");
    const state = new StateStore(repo);
    await state.initialise("01PROBEDIFFERS");
    await state.update((cur) => ({
      ...cur,
      last_reviewed_head_sha: "H",
      last_reviewed_tree_hash: "T",
    }));
    expect(
      await stopProbe(
        repo,
        async () => "H",
        async () => "T2",
      ),
    ).toBe("review");
  });

  test("no flag + HEAD unchanged + current hash null → review (fail toward review)", async () => {
    const repo = freshRepo("rg-probe-curnull-");
    const state = new StateStore(repo);
    await state.initialise("01PROBECURNULL");
    await state.update((cur) => ({
      ...cur,
      last_reviewed_head_sha: "H",
      last_reviewed_tree_hash: "T",
    }));
    expect(
      await stopProbe(
        repo,
        async () => "H",
        async () => null,
      ),
    ).toBe("review");
  });

  test("no flag + stored hash null (pre-migration state) → review", async () => {
    const repo = freshRepo("rg-probe-storednull-");
    const state = new StateStore(repo);
    await state.initialise("01PROBESTOREDNULL");
    await state.update((cur) => ({
      ...cur,
      last_reviewed_head_sha: "H",
      last_reviewed_tree_hash: null,
    }));
    expect(
      await stopProbe(
        repo,
        async () => "H",
        async () => "T",
      ),
    ).toBe("review");
  });

  test("no flag + last_reviewed_head_sha null → review (was the core-loop#2 hole)", async () => {
    const repo = freshRepo("rg-probe-lastnull-");
    await new StateStore(repo).initialise("01PROBELASTNULL"); // last_reviewed_head_sha = null default
    expect(
      await stopProbe(
        repo,
        async () => "H",
        async () => "T",
      ),
    ).toBe("review");
  });
});

describe("stopProbe / gatherReviewContext — S1 end-to-end", () => {
  test("Bash-created UNTRACKED file with unchanged HEAD reaches review (S1 end-to-end)", async () => {
    const repo = gitRepo("rg-probe-e2e-untracked-");
    const sha = await gitHeadSha(repo);
    const tree = await workingTreeStateHash(repo);
    const state = new StateStore(repo);
    await state.initialise("01PROBEE2EUT");
    await state.update((cur) => ({
      ...cur,
      last_reviewed_head_sha: sha,
      last_reviewed_tree_hash: tree,
    }));
    // Simulated Bash edit: a brand-new untracked file, no dirty.flag, HEAD unmoved.
    writeFileSync(join(repo, "sneaky.ts"), "export const evil = 1;\n");
    expect(await stopProbe(repo)).toBe("review"); // probe catches it (real git, no injected fns)
    const ctx = await gatherReviewContext(
      { repoRoot: repo, hookStdinRaw: "{}" } as never,
      state,
      collectGitInfo,
      collectDiff,
      false,
    );
    expect(ctx.diff).toContain("sneaky.ts"); // synthesis reviewed the untracked file
  });

  // round-13 C1 originally read this as proof the null-`last` fallthrough is
  // reviewed — WRONG in one respect: `ctx.diff` being correctly populated here is
  // necessary but NOT sufficient. `gatherReviewContext` alone never persists a
  // dirty.flag on this branch (`sinceLast` short-circuits to "" before that write
  // is reached), and `LoopDriver.run()` independently RE-READS the flag FROM DISK
  // — finding none, it green-allows ("No code changes since last review") WITHOUT
  // ever consulting `ctx.diff`, so the change shipped unreviewed despite this
  // assertion holding (S1-C1, codex CRITICAL, reviewed 2026-07-03). The actual
  // persist-or-fail-closed invariant is enforced by a BELT in `runStopGate`, not
  // here — see the full `runGate({hook:"stop"})` end-to-end coverage in
  // tests/unit/gate-stop-diff-always-flagged.test.ts (case a), which is what would
  // have caught this. This test still pins the narrower, still-true fact that
  // `gatherReviewContext` computes the right diff on this branch.
  test("last=null + no flag + uncommitted Bash edit → gatherReviewContext computes the right diff (round-13 C1; flag persistence is NOT proven here)", async () => {
    const repo = gitRepo("rg-probe-e2e-nulllast-");
    const state = new StateStore(repo);
    await state.initialise("01PROBEE2ENULL"); // last_reviewed_head_sha = null default; no dirty flag
    writeFileSync(join(repo, "sneaky2.ts"), "export const x = 1;\n");
    const ctx = await gatherReviewContext(
      { repoRoot: repo, hookStdinRaw: "{}" } as never,
      state,
      collectGitInfo,
      collectDiff,
      false,
    );
    expect(ctx.reviewBase).toBeNull();
    expect(ctx.diff).toContain("sneaky2.ts");
  });
});
