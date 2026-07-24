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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherReviewContext, runGate, stopProbe } from "../../src/cli/commands/gate.ts";
import { StateStore } from "../../src/core/state-store.ts";
import {
  collectDiff,
  collectGitInfo,
  gitHeadSha,
  workingTreeStateHash,
} from "../../src/utils/git.ts";
import { escalationMdPath, reviewgateDir } from "../../src/utils/paths.ts";

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
      false,
      { dwellMs: 0 },
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
      false,
      { dwellMs: 0 },
    );
    expect(ctx.reviewBase).toBeNull();
    expect(ctx.diff).toContain("sneaky2.ts");
  });
});

// S3b — the standing-down branch: an escalation handed the range to the human
// (ESCALATION.md written, escalated_head_sha/escalated_tree_hash recorded at
// announce). With NOTHING new since then (no dirty flag, HEAD unmoved, tree
// unmoved, the handoff artifact still present) the probe returns
// "skip-escalated" so the gate can print the loud 🟠 standing-down message
// instead of either the green "no changes" or re-running the lock path. Any
// uncertainty (HEAD moved, tree changed, a hash unknowable, the artifact
// missing, or a persistent-quota latch) fails toward "review".
describe("stopProbe — escalated standing-down branch (S3b)", () => {
  async function seedEscalated(
    repo: string,
    overrides: Record<string, unknown> = {},
  ): Promise<StateStore> {
    const state = new StateStore(repo);
    await state.initialise("01PROBEESC");
    await state.update((cur) => ({
      ...cur,
      escalated: true,
      escalation_announced: true,
      escalation_reason: "max-iterations" as const,
      last_reviewed_head_sha: "H0",
      escalated_head_sha: "H1",
      escalated_tree_hash: "T",
      ...overrides,
    }));
    return state;
  }

  test("escalated + HEAD unmoved + tree unmoved + no flag → 'skip-escalated' (S3b)", async () => {
    const repo = freshRepo("rg-probe-escalated-clean-");
    await seedEscalated(repo);
    writeFileSync(escalationMdPath(repo), "# ESCALATED\n");
    expect(
      await stopProbe(
        repo,
        async () => "H1",
        async () => "T",
      ),
    ).toBe("skip-escalated");
  });

  test("escalated + HEAD MOVED past escalated_head_sha → 'review' (lock path, Path A recovery)", async () => {
    const repo = freshRepo("rg-probe-escalated-headmoved-");
    await seedEscalated(repo);
    writeFileSync(escalationMdPath(repo), "# ESCALATED\n");
    expect(
      await stopProbe(
        repo,
        async () => "H2",
        async () => "T",
      ),
    ).toBe("review");
  });

  test("escalated + HEAD unmoved but TREE changed (post-escalation Bash edit) → 'review' (round-2 C1)", async () => {
    const repo = freshRepo("rg-probe-escalated-treechanged-");
    await seedEscalated(repo);
    writeFileSync(escalationMdPath(repo), "# ESCALATED\n");
    expect(
      await stopProbe(
        repo,
        async () => "H1",
        async () => "T-changed",
      ),
    ).toBe("review");
  });

  test("escalated + stored escalated_tree_hash null → 'review' (fail toward review)", async () => {
    const repo = freshRepo("rg-probe-escalated-storednull-");
    await seedEscalated(repo, { escalated_tree_hash: null });
    writeFileSync(escalationMdPath(repo), "# ESCALATED\n");
    expect(
      await stopProbe(
        repo,
        async () => "H1",
        async () => "T",
      ),
    ).toBe("review");
  });

  test("escalated + current tree hash null → 'review' (fail toward review)", async () => {
    const repo = freshRepo("rg-probe-escalated-curnull-");
    await seedEscalated(repo);
    writeFileSync(escalationMdPath(repo), "# ESCALATED\n");
    expect(
      await stopProbe(
        repo,
        async () => "H1",
        async () => null,
      ),
    ).toBe("review");
  });

  test("escalated but ESCALATION.md is missing → 'review', never a stand-down over a stale state bit (round-4 W1)", async () => {
    const repo = freshRepo("rg-probe-escalated-noartifact-");
    await seedEscalated(repo);
    rmSync(escalationMdPath(repo), { force: true }); // never written in this test
    expect(
      await stopProbe(
        repo,
        async () => "H1",
        async () => "T",
      ),
    ).toBe("review");
  });

  test("escalated + escalated_head_sha null (git error at announce) → 'review', NEVER the escalation-blind 'skip-clean'", async () => {
    // freshHeadSha resolving null at announce time records escalated_head_sha:null.
    // The probe must still CAPTURE the escalated state and fail toward "review" —
    // NOT skip the whole branch and fall through to the S1 comparison, which would
    // return "skip-clean" (🟢) on an escalated, announced, un-remediated range
    // whenever HEAD/tree happen to match the last CLEAN review. That fall-through
    // would also silently defeat the quota-latch and missing-ESCALATION.md guards,
    // which live inside the branch.
    const repo = freshRepo("rg-probe-escalated-nullsha-");
    await seedEscalated(repo, {
      escalated_head_sha: null,
      // Worst case for the fall-through: seed the S1 baseline so the
      // escalation-blind comparison WOULD fast-exit to "skip-clean".
      last_reviewed_head_sha: "H1",
      last_reviewed_tree_hash: "T",
    });
    writeFileSync(escalationMdPath(repo), "# ESCALATED\n");
    expect(
      await stopProbe(
        repo,
        async () => "H1",
        async () => "T",
      ),
    ).toBe("review");
  });

  test("escalated + quota-exhausted-persistent latch → 'review', NEVER stands down (round-13 W1)", async () => {
    const repo = freshRepo("rg-probe-escalated-quotalatch-");
    await seedEscalated(repo, { escalation_reason: "quota-exhausted-persistent" as const });
    writeFileSync(escalationMdPath(repo), "# ESCALATED\n");
    // Even with head/tree matching and the artifact present, the quota latch
    // must never stand down — every stop routes through the lock path.
    expect(
      await stopProbe(
        repo,
        async () => "H1",
        async () => "T",
      ),
    ).toBe("review");
  });

  test("runGate maps 'skip-escalated' to the loud standing-down message, NOT the green no-changes message", async () => {
    // Integration-level: runGate calls stopProbe with the REAL gitHeadSha/
    // workingTreeStateHash (no injected stubs), so this needs a real git repo
    // whose current HEAD/tree match the recorded announce-time values.
    const repo = gitRepo("rg-probe-escalated-rungate-");
    const sha = await gitHeadSha(repo);
    const tree = await workingTreeStateHash(repo);
    await seedEscalated(repo, { escalated_head_sha: sha, escalated_tree_hash: tree });
    writeFileSync(escalationMdPath(repo), "# ESCALATED\n");
    const out = await runGate({
      repoRoot: repo,
      hook: "stop",
      snapshotVerifyOpts: { dwellMs: 0 },
      hookStdinRaw: "{}",
    });
    expect(out.stdout).toBe(""); // no block decision emitted
    expect(out.stderr).toContain("ESCALATION.md");
    expect(out.stderr.toLowerCase()).not.toContain("no code changes since last review");
  });
});
