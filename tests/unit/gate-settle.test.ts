// tests/unit/gate-settle.test.ts
//
// Gate wiring: gatherReviewContext runs the settle-check when settleBeforeReview is
// on, and on a QUIESCENT working tree returns workspaceUnsettled: undefined (it
// settled and proceeded). With the toggle off it skips entirely.
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherReviewContext } from "../../src/cli/commands/gate.ts";
import { StateStore } from "../../src/core/state-store.ts";

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-gate-settle-"));
  const run = (...a: string[]) => execFileSync("git", a, { cwd: dir });
  run("init", "-q");
  run("config", "user.email", "t@t.t");
  run("config", "user.name", "t");
  writeFileSync(join(dir, "a.ts"), "x\n");
  run("add", "a.ts");
  run("commit", "-qm", "init");
  return dir;
}

const stubGitInfo = async () => ({
  sha: "0".repeat(40),
  branch: "main",
  dirty_files: [] as string[],
});
const stubDiff = async () => ""; // empty diff → nothing else to do

describe("gatherReviewContext settle wiring (#7)", () => {
  it("ON + quiescent tree → workspaceUnsettled undefined, proceeds", async () => {
    const dir = gitRepo();
    const state = new StateStore(dir);
    await state.initialise("01HXSETTLE01");
    const ctx = await gatherReviewContext(
      { repoRoot: dir } as never,
      state,
      stubGitInfo as never,
      stubDiff as never,
      true,
    );
    expect(ctx.workspaceUnsettled).toBeUndefined(); // clean tree → settled, no banner
  });

  it("OFF → settle skipped, workspaceUnsettled undefined", async () => {
    const dir = gitRepo();
    const state = new StateStore(dir);
    await state.initialise("01HXSETTLE02");
    const ctx = await gatherReviewContext(
      { repoRoot: dir } as never,
      state,
      stubGitInfo as never,
      stubDiff as never,
      false,
    );
    expect(ctx.workspaceUnsettled).toBeUndefined();
  });
});
