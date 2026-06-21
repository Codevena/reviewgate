import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { worktreeGatedCheck } from "../../src/cli/commands/doctor.ts";
import { runInit } from "../../src/cli/commands/init.ts";
import { worktreeInfo } from "../../src/utils/git.ts";

function tmp() {
  return mkdtempSync(join(tmpdir(), "rg-wt-"));
}
function git(repo: string, args: string[]) {
  execFileSync("git", ["-c", "user.email=t@t.t", "-c", "user.name=t", ...args], { cwd: repo });
}
function mainRepo() {
  const main = tmp();
  git(main, ["init", "-q"]);
  git(main, ["commit", "--allow-empty", "-q", "-m", "init"]);
  return main;
}
function addWorktree(main: string) {
  const wt = join(tmp(), "wt");
  git(main, ["worktree", "add", "-q", wt, "-b", "feat"]);
  return wt;
}

describe("worktreeInfo (P8)", () => {
  it("reports isLinkedWorktree=false for a main checkout (git-dir == git-common-dir)", async () => {
    expect((await worktreeInfo(mainRepo())).isLinkedWorktree).toBe(false);
  });

  it("reports isLinkedWorktree=true inside a linked worktree (git-dir != git-common-dir)", async () => {
    const main = mainRepo();
    const wt = addWorktree(main);
    expect((await worktreeInfo(wt)).isLinkedWorktree).toBe(true);
  });

  it("reports isLinkedWorktree=false for a non-git dir (fail-safe: treat as a normal repo)", async () => {
    expect((await worktreeInfo(tmp())).isLinkedWorktree).toBe(false);
  });
});

describe("worktreeGatedCheck (P8)", () => {
  it("returns null when not inside a linked worktree (nothing to check)", async () => {
    expect(await worktreeGatedCheck(mainRepo())).toBeNull();
  });

  it("FAILs (exit-2 severity) inside a linked worktree with NO Reviewgate hooks", async () => {
    const c = await worktreeGatedCheck(addWorktree(mainRepo()));
    expect(c?.status).toBe("fail");
    expect(c?.detail.toLowerCase()).toContain("worktree");
    expect(c?.hint).toBeDefined();
  });

  it("is OK when the worktree itself has Reviewgate hooks installed", async () => {
    const wt = addWorktree(mainRepo());
    await runInit({ repoRoot: wt, mode: "agent-loop" });
    expect((await worktreeGatedCheck(wt))?.status).toBe("ok");
  });
});
