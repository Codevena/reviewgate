// tests/unit/gate-treehash-snapshot.test.ts
//
// Dogfood F-001 (WARN, capture-window-drops-concurrent-flag): the driver's
// last_reviewed_tree_hash used to be computed FRESH at state-WRITE time — i.e.
// AFTER the multi-minute panel run. A concurrent session's mid-review Bash edit
// (no PostToolUse, no flag) then lands INSIDE the recorded "reviewed" fingerprint:
// on a PASS the state stores the post-edit tree as reviewed-through, and the next
// Stop's probe skip-cleans over code no panel ever saw.
//
// Fix: the gate memoizes the tree hash ONCE at DIFF-SNAPSHOT time (right after
// gatherReviewContext returns) and every driver write site (head-move record,
// post-review write, escalation announce) flows through that same snapshot via
// this.i.treeHash. Consequence pinned here end-to-end: a mid-review concurrent
// edit yields stored-hash ≠ post-edit tree → the next stop probe returns
// "review" — the concurrent work is caught even though F-005's compare-and-delete
// removes the dirty flag on PASS.
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate, stopProbe } from "../../src/cli/commands/gate.ts";
import { StateStore } from "../../src/core/state-store.ts";
import type { ProviderAdapter, ReviewResult } from "../../src/providers/adapter-base.ts";
import { workingTreeStateHash } from "../../src/utils/git.ts";
import { reviewgateDir } from "../../src/utils/paths.ts";

function gitRepo(prefix: string): string {
  const repo = mkdtempSync(join(tmpdir(), prefix));
  const run = (...a: string[]) => execFileSync("git", a, { cwd: repo });
  run("init", "-q");
  run("config", "user.email", "t@t.t");
  run("config", "user.name", "t");
  writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
  run("add", "a.ts");
  run("commit", "-qm", "init");
  mkdirSync(reviewgateDir(repo), { recursive: true });
  return repo;
}

// A PASSing reviewer whose review() fires a side effect — the stand-in for a
// CONCURRENT session's Bash edit landing while the panel is running.
function passingReviewerWithSideEffect(sideEffect: () => void): ProviderAdapter {
  return {
    id: "codex",
    async preflight() {
      return { available: true, version: "stub", authMode: "oauth", error: null };
    },
    async review(input): Promise<ReviewResult> {
      sideEffect();
      return {
        reviewerId: input.reviewerId,
        verdict: "PASS",
        findings: [],
        usage: { inputTokens: 100, outputTokens: 20, costUsd: 0, quotaUsedPct: null },
        durationMs: 1,
        exitCode: 0,
        rawEventsPath: "",
        status: "ok",
      };
    },
  };
}

describe("tree hash is recorded at diff-snapshot time, not state-write time (dogfood F-001)", () => {
  it("a mid-review concurrent edit is NOT blessed by a PASS: stored hash = snapshot, next stop reviews", async () => {
    const repo = gitRepo("rg-treehash-snap-");
    await new StateStore(repo).initialise("01TREEHASHSNAP");
    // The edit under review (uncommitted, Bash-style — the belt persists the flag).
    writeFileSync(join(repo, "sneaky.ts"), "export const s = 1;\n");
    // The tree exactly as the reviewed diff will see it (diff-snapshot state).
    const snapshotTree = await workingTreeStateHash(repo);
    expect(snapshotTree).not.toBeNull();

    const out = await runGate({
      repoRoot: repo,
      hook: "stop",
      snapshotVerifyOpts: { dwellMs: 0 },
      hookStdinRaw: "{}",
      providerOverrides: {
        codex: passingReviewerWithSideEffect(() => {
          // Concurrent session's mid-review Bash edit: no PostToolUse, no flag.
          writeFileSync(join(repo, "concurrent.ts"), "export const c = 2;\n");
        }),
      },
      sandboxModeOverride: "off",
    });

    expect(out.exitCode).toBe(0);
    expect(out.stdout).toBe(""); // PASS → allow_stop (the reviewed edit is clean)
    const st = await new StateStore(repo).load();
    // Pre-fix (write-time hashing): stored == post-edit tree (concurrent.ts
    // blessed as reviewed) and the next probe skip-cleans — fail-open. Post-fix:
    // stored is the DIFF-SNAPSHOT hash (without concurrent.ts) …
    expect(st.last_reviewed_tree_hash).toBe(snapshotTree);
    // … so the concurrent edit is still caught: stored ≠ current tree → review.
    expect(await stopProbe(repo)).toBe("review");
  }, 30_000);
});
