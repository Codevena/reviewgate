// tests/unit/gate-dirty-flag-corrupt.test.ts
// F-002(a): a corrupt/unparseable dirty.flag must NOT silently narrow the review to
// the working tree only (which would DROP commit-per-task work landed mid-batch =
// fail-open). It must fail toward MORE coverage: fall back to the last reviewed sha
// as the review base. We capture the `base` argument passed to collectDiff to prove
// the wider base is used (a real git repo so resolveReviewBase keeps the ancestor).
import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../../src/cli/commands/gate.ts";
import { StateStore } from "../../src/core/state-store.ts";
import { dirtyFlagPath, reviewgateDir } from "../../src/utils/paths.ts";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};
function sh(repo: string, cmd: string): string {
  return execSync(cmd, { cwd: repo, env: GIT_ENV, stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
}

describe("gate with a corrupt dirty.flag", () => {
  it("falls back to the last reviewed sha as the base (fails toward MORE coverage)", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-gate-dirty-corrupt-"));
    sh(repo, "git init -q -b main");
    writeFileSync(join(repo, "a.txt"), "A\n");
    sh(repo, "git add -A && git commit -q -m A");
    const lastSha = sh(repo, "git rev-parse HEAD"); // a REAL ancestor of HEAD
    // Advance HEAD so the gate doesn't short-circuit as "nothing to review".
    writeFileSync(join(repo, "b.txt"), "B\n");
    sh(repo, "git add -A && git commit -q -m B");

    mkdirSync(reviewgateDir(repo), { recursive: true });
    const store = new StateStore(repo);
    await store.initialise("sess-1");
    await store.update((s) => ({ ...s, last_reviewed_head_sha: lastSha }));

    // A garbage (unparseable) dirty.flag — truncated / half-written.
    writeFileSync(dirtyFlagPath(repo), "{ not valid json,,,");

    const capturedBases: (string | null)[] = [];
    const out = await runGate({
      repoRoot: repo,
      hook: "stop",
      snapshotVerifyOpts: { dwellMs: 0 },
      hookStdinRaw: "{}",
      // Capture the base arg; return an empty diff so the panel triages to skip
      // (this test asserts on base SELECTION, not on the review itself).
      collectDiffFn: async (_repo, base) => {
        capturedBases.push(base ?? null);
        return "";
      },
    });

    // The corrupt flag must NOT have narrowed to working-tree-only (base = null).
    // It must use the last reviewed sha → committed mid-batch work is still covered.
    expect(capturedBases.length).toBeGreaterThan(0);
    expect(capturedBases).toContain(lastSha);
    expect(capturedBases).not.toContain(null);
    expect(out.exitCode).toBe(0);
  }, 20_000);
});
