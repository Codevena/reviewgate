// tests/unit/working-tree-dirty-files.test.ts
import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workingTreeDirtyFiles } from "../../src/utils/git.ts";

function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-wtdf-"));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir });
  run("init", "-q");
  run("config", "user.email", "t@t.t");
  run("config", "user.name", "t");
  writeFileSync(join(dir, "committed.ts"), "const a = 1;\n");
  run("add", "committed.ts");
  run("commit", "-qm", "init");
  return dir;
}

describe("workingTreeDirtyFiles", () => {
  it("lists a tracked uncommitted change and an untracked file, not a clean committed file", async () => {
    const dir = gitRepo();
    writeFileSync(join(dir, "committed.ts"), "const a = 2;\n"); // tracked change
    writeFileSync(join(dir, "new.ts"), "const b = 3;\n"); // untracked
    const files = await workingTreeDirtyFiles(dir);
    expect(files).toContain("committed.ts");
    expect(files).toContain("new.ts");
  });

  it("returns an empty array for a clean working tree", async () => {
    const dir = gitRepo();
    expect(await workingTreeDirtyFiles(dir)).toEqual([]);
  });

  it("returns an empty array (best-effort) for a non-git directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-wtdf-nogit-"));
    expect(await workingTreeDirtyFiles(dir)).toEqual([]);
  });
});
