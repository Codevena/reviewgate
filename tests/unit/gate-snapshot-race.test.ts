// tests/unit/gate-snapshot-race.test.ts
//
// Snapshot race (Dealbarg field incident 2026-07): the Stop-hook's diff capture
// read the live working tree while a PARALLEL agent had transiently mutated a
// file in place (mutation test: apply → run test → restore). The panel reviewed
// a tree state that never corresponded to any commit and produced a phantom
// CRITICAL on the transient content. The fix: paired verify rounds in
// gatherReviewContext — re-read diff + tree hash until two consecutive rounds
// agree (bounded, with a dwell), so a capture poisoned by a transient mutation
// is re-captured after the restore instead of shipped to reviewers.
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherReviewContext } from "../../src/cli/commands/gate.ts";
import type { SnapshotFileEntry } from "../../src/core/reviewed-snapshot.ts";
import { StateStore } from "../../src/core/state-store.ts";
import {
  DIFF_INCOMPLETE_MARKER,
  type GitInfo,
  collectDiff,
  collectGitInfo,
} from "../../src/utils/git.ts";

const LATCH_ORIGINAL = [
  "export function handle(state: { latched: boolean }, doWork: () => void) {",
  "  if (state.latched) return;",
  "  state.latched = true;",
  "  doWork();",
  "  state.latched = false; // re-arm the latch",
  "}",
  "",
].join("\n");

const LATCH_MUTATED = LATCH_ORIGINAL.replace(
  "  state.latched = false; // re-arm the latch",
  "  // MUTATION A: latch re-arm removed",
);

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-snap-race-"));
  const run = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  run("init", "-q");
  run("config", "user.email", "t@t.t");
  run("config", "user.name", "t");
  writeFileSync(join(dir, "latch.ts"), LATCH_ORIGINAL);
  run("add", "latch.ts");
  run("commit", "-qm", "init");
  return dir;
}

const STUB_GIT_INFO: GitInfo = {
  sha: "a".repeat(40),
  branch: "main",
  dirtyFiles: [],
};

async function gatherWithSequences(input: {
  diffs: string[];
  hashes: Array<string | null>;
  maxRounds?: number;
  deadlineAt?: number | null;
  now?: () => number;
  manifests?: Array<Record<string, SnapshotFileEntry>>;
}) {
  const dir = gitRepo();
  const state = new StateStore(dir);
  await state.initialise("01HXSNAPSEQ");
  let diffReads = 0;
  let hashReads = 0;
  let manifestReads = 0;
  const ctx = await gatherReviewContext(
    { repoRoot: dir } as never,
    state,
    (async () => STUB_GIT_INFO) as never,
    (async () => input.diffs[Math.min(diffReads++, input.diffs.length - 1)] ?? "") as never,
    false,
    false,
    {
      treeHashFn: (async () =>
        input.hashes[Math.min(hashReads++, input.hashes.length - 1)] ?? null) as never,
      snapshotFilesFn: () =>
        input.manifests?.[Math.min(manifestReads++, input.manifests.length - 1)] ??
        Object.create(null),
      sleep: async () => {},
      dwellMs: 0,
      maxRounds: input.maxRounds ?? 3,
      deadlineAt: input.deadlineAt ?? null,
      ...(input.now ? { now: input.now } : {}),
    } as never,
  );
  return { ctx, diffReads, hashReads, manifestReads };
}

describe("gatherReviewContext snapshot race (transient concurrent mutation)", () => {
  it("a snapshot read while the tree is transiently mutated must NOT ship the transient content", async () => {
    const dir = gitRepo();
    // The turn's REAL change (untracked new file — the common review case).
    writeFileSync(join(dir, "feature.ts"), "export const feature = 1;\n");
    const latchPath = join(dir, "latch.ts");

    // Simulate the incident's interleaving exactly: a parallel mutation-test
    // writer applies the mutation, the gate's snapshot read lands INSIDE the
    // [apply, restore] window, the writer restores. Only the FIRST capture is
    // poisoned; the tree is back to its true state before any later read.
    let calls = 0;
    const wrappedDiff: typeof collectDiff = async (...args) => {
      calls++;
      if (calls === 1) {
        writeFileSync(latchPath, LATCH_MUTATED);
        const poisoned = await collectDiff(...args);
        writeFileSync(latchPath, LATCH_ORIGINAL);
        return poisoned;
      }
      return collectDiff(...args);
    };

    const state = new StateStore(dir);
    await state.initialise("01HXSNAPRACE1");
    const ctx = await gatherReviewContext(
      { repoRoot: dir } as never,
      state,
      collectGitInfo as never,
      wrappedDiff as never,
      false, // settle off — it is pre-capture only and irrelevant here
      false,
      // REAL sleep semantics but a short dwell: the mutate→capture→restore
      // interleaving is orchestrated by call COUNT above, not wall time, so the
      // production 2s dwell adds nothing here — it only pushed this test past
      // bun's 5s per-test cap (claude review CRITICAL). Everything else is the
      // real production path (real repo, real collectDiff, real hash+manifest).
      { dwellMs: 25 },
    );

    // The real change must be reviewed…
    expect(ctx.diff).toContain("feature.ts");
    // …but the transient mutation — content that existed for one read only and
    // never corresponded to any commit — must not reach the reviewer panel.
    expect(ctx.diff).not.toContain("MUTATION A");
  }, 15_000); // headroom for real git work on a loaded CI machine

  it("documents the inherent limit: a mutation held across both agreeing reads is treated as real", async () => {
    const poisoned = "diff --git a/latch.ts b/latch.ts\n+// MUTATION A\n";
    const { ctx, diffReads, hashReads } = await gatherWithSequences({
      diffs: [poisoned, poisoned],
      hashes: ["poisoned-tree", "poisoned-tree"],
    });

    expect(ctx.diff).toContain("MUTATION A");
    expect(ctx.snapshotUnstable).toBeUndefined();
    expect(diffReads).toBe(2);
    expect(hashReads).toBe(2);
  });

  it("accepts a stable tree after exactly two paired reads", async () => {
    const stable = "diff --git a/feature.ts b/feature.ts\n+stable\n";
    const { ctx, diffReads, hashReads } = await gatherWithSequences({
      diffs: [stable, stable],
      hashes: ["stable-tree", "stable-tree"],
    });

    expect(ctx.diff).toBe(stable);
    expect(ctx.snapshotTree).toBe("stable-tree");
    expect(ctx.snapshotUnstable).toBeUndefined();
    expect(diffReads).toBe(2);
    expect(hashReads).toBe(2);
  });

  it("ships the latest same-round pair and marks persistent churn unstable", async () => {
    const { ctx, diffReads, hashReads } = await gatherWithSequences({
      diffs: ["round-0", "round-1", "round-2", "round-3"],
      hashes: ["tree-0", "tree-1", "tree-2", "tree-3"],
      maxRounds: 3,
    });

    expect(ctx.diff).toBe("round-3");
    // C2 (codex step-2): with ZERO agreement evidence the final hash may
    // fingerprint a different state than the shipped diff — never bless it.
    expect(ctx.snapshotTree).toBeNull();
    expect(ctx.snapshotUnstable).toEqual({ recaptures: 3 });
    expect(ctx.capturedSnapshotFiles).toBeNull();
    expect(diffReads).toBe(4);
    expect(hashReads).toBe(4);
  });

  it("does not accept a diff/tree pair when its later live-file manifest belongs to another state", async () => {
    const manifestA = {
      "feature.ts": { status: "present" as const, hash: "file-a" },
    };
    const manifestB = {
      "feature.ts": { status: "present" as const, hash: "file-b" },
    };
    const { ctx, diffReads, hashReads, manifestReads } = await gatherWithSequences({
      // Boundary race: round 1's diff+tree still see A, then the live manifest
      // sees B. A diff/tree-only verifier would incorrectly accept round 1.
      diffs: ["state-a", "state-a", "state-b", "state-b"],
      hashes: ["tree-a", "tree-a", "tree-b", "tree-b"],
      manifests: [manifestA, manifestB, manifestB, manifestB],
    });

    expect(ctx.diff).toBe("state-b");
    expect(ctx.snapshotTree).toBe("tree-b");
    expect(ctx.capturedSnapshotFiles).toEqual(manifestB);
    expect(ctx.snapshotUnstable).toBeUndefined();
    expect(diffReads).toBe(4);
    expect(hashReads).toBe(4);
    expect(manifestReads).toBe(4);
  });

  it("clamps an invalid non-positive maxRounds seam to one recapture", async () => {
    const { ctx, diffReads, hashReads } = await gatherWithSequences({
      diffs: ["round-0", "round-1"],
      hashes: ["tree-0", "tree-1"],
      maxRounds: 0,
    });

    expect(ctx.diff).toBe("round-1");
    expect(ctx.snapshotTree).toBeNull(); // C2: unstable never blesses a hash
    expect(ctx.snapshotUnstable).toEqual({ recaptures: 1 });
    expect(diffReads).toBe(2);
    expect(hashReads).toBe(2);
  });

  it("W1: a budget exit AFTER an observed mismatch takes the unstable path, not the silent one", async () => {
    let nowCall = 0;
    // now sequence: round0 start=0, round0 end=10 (round0Ms=10) → iter-1 budget
    // check at 20 (80 remaining ≥ 20 → proceed, mismatch observed) → iter-2
    // budget check at 90 (10 remaining < 20 → exit with churn already seen).
    const { ctx, diffReads } = await gatherWithSequences({
      diffs: ["state-a", "state-b"],
      hashes: ["tree-a", "tree-b"],
      deadlineAt: 100,
      now: () => [0, 10, 20, 90][Math.min(nowCall++, 3)] ?? 90,
    });

    expect(ctx.snapshotUnstable).toEqual({ recaptures: 1 });
    expect(ctx.snapshotTree).toBeNull();
    expect(ctx.capturedSnapshotFiles).toBeNull();
    expect(diffReads).toBe(2);
  });

  it("W2: a re-capture that comes back incomplete ends verification silently, never as a churn banner", async () => {
    const incomplete = `diff --git a/x.ts b/x.ts\n+x\n\n${DIFF_INCOMPLETE_MARKER}\n`;
    const { ctx, diffReads } = await gatherWithSequences({
      diffs: ["state-a", incomplete],
      hashes: ["tree-a", "tree-b"],
      maxRounds: 1,
    });

    // Collection jitter (the truncation trailer appearing mid-verification) is
    // NOT evidence of a concurrent writer — silent unverified, trust-limited
    // downstream by the diffIncomplete path instead.
    expect(ctx.snapshotUnstable).toBeUndefined();
    expect(ctx.diff).toBe(incomplete);
    expect(diffReads).toBe(2);
  });

  it("re-captures an empty-to-dirty flip instead of accepting the empty read", async () => {
    const dirty = "diff --git a/feature.ts b/feature.ts\n+dirty\n";
    const { ctx, diffReads, hashReads } = await gatherWithSequences({
      diffs: ["", dirty, dirty],
      hashes: ["tree-empty", "tree-dirty", "tree-dirty"],
    });

    expect(ctx.diff).toBe(dirty);
    expect(ctx.snapshotTree).toBe("tree-dirty");
    expect(ctx.snapshotUnstable).toBeUndefined();
    expect(diffReads).toBe(3);
    expect(hashReads).toBe(3);
  });

  it("verifies a stable empty diff with two paired reads", async () => {
    const { ctx, diffReads, hashReads } = await gatherWithSequences({
      diffs: ["", ""],
      hashes: ["clean-tree", "clean-tree"],
    });

    expect(ctx.diff).toBe("");
    expect(ctx.snapshotUnstable).toBeUndefined();
    expect(diffReads).toBe(2);
    expect(hashReads).toBe(2);
  });

  it("treats the incompleteness marker positionally, not when it appears in file content", async () => {
    const complete = `diff --git a/src/utils/git.ts b/src/utils/git.ts\n+const marker = "${DIFF_INCOMPLETE_MARKER}";\n`;
    const completeResult = await gatherWithSequences({
      diffs: [complete, complete],
      hashes: ["tree", "tree"],
    });
    expect(completeResult.diffReads).toBe(2);
    expect(completeResult.ctx.snapshotUnstable).toBeUndefined();

    const incomplete = `${complete}\n${DIFF_INCOMPLETE_MARKER}\n`;
    const incompleteResult = await gatherWithSequences({
      diffs: [incomplete],
      hashes: ["tree"],
    });
    expect(incompleteResult.diffReads).toBe(1);
    expect(incompleteResult.hashReads).toBe(1);
    expect(incompleteResult.ctx.snapshotUnstable).toBeUndefined();
    expect(incompleteResult.ctx.capturedSnapshotFiles).toBeNull();
  });

  it("stops silently before a verify read that cannot fit the remaining setup budget", async () => {
    let nowCall = 0;
    const { ctx, diffReads, hashReads } = await gatherWithSequences({
      diffs: ["latest"],
      hashes: ["tree"],
      deadlineAt: 25,
      now: () => [0, 10, 20][Math.min(nowCall++, 2)] ?? 20,
    });

    expect(ctx.diff).toBe("latest");
    expect(ctx.snapshotTree).toBe("tree");
    expect(ctx.snapshotUnstable).toBeUndefined();
    expect(ctx.capturedSnapshotFiles).toBeNull();
    expect(diffReads).toBe(1);
    expect(hashReads).toBe(1);
  });

  it("charges a reused HEAD-advanced precompute against the verify budget estimate", async () => {
    const dir = gitRepo();
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const state = new StateStore(dir);
    await state.initialise("01HXSNAPPRE");
    await state.update((current) => ({ ...current, last_reviewed_head_sha: head }));
    let diffReads = 0;
    let hashReads = 0;
    const ctx = await gatherReviewContext(
      { repoRoot: dir } as never,
      state,
      (async () => ({ ...STUB_GIT_INFO, sha: head })) as never,
      (async () => {
        diffReads++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return "precomputed-diff";
      }) as never,
      false,
      false,
      {
        treeHashFn: (async () => {
          hashReads++;
          return "tree";
        }) as never,
        sleep: async () => {},
        now: () => 0,
        dwellMs: 0,
        deadlineAt: 40,
      },
    );

    expect(ctx.diff).toBe("precomputed-diff");
    expect(ctx.snapshotUnstable).toBeUndefined();
    expect(diffReads).toBe(1);
    expect(hashReads).toBe(1);
  });

  it("routes agreeing diffs with indeterminate fingerprints to silent unverified", async () => {
    const { ctx, diffReads, hashReads } = await gatherWithSequences({
      diffs: ["same", "same"],
      hashes: [null, null],
    });

    expect(ctx.diff).toBe("same");
    expect(ctx.snapshotTree).toBeNull();
    expect(ctx.snapshotUnstable).toBeUndefined();
    expect(ctx.capturedSnapshotFiles).toBeNull();
    expect(diffReads).toBe(2);
    expect(hashReads).toBe(2);
  });
});
