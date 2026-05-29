import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDiff } from "../../src/utils/git.ts";

function tmpRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "rg-agy-excl-"));
  spawnSync("git", ["init", "-q"], { cwd: repo });
  spawnSync(
    "git",
    ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "--allow-empty", "-m", "init"],
    { cwd: repo },
  );
  return repo;
}

describe("collectDiff excludes agy .antigravitycli artifacts", () => {
  it("excludes untracked .antigravitycli at root and in a subdir; keeps normal + .gemini files", async () => {
    const repo = tmpRepo();
    writeFileSync(join(repo, "foo.ts"), "export const a = 1;\n");
    mkdirSync(join(repo, ".antigravitycli"), { recursive: true });
    writeFileSync(join(repo, ".antigravitycli", "x"), "secret-ish\n");
    mkdirSync(join(repo, "sub", ".antigravitycli"), { recursive: true });
    writeFileSync(join(repo, "sub", ".antigravitycli", "y"), "secret-ish\n");
    mkdirSync(join(repo, ".gemini"), { recursive: true });
    writeFileSync(join(repo, ".gemini", "config.ts"), "export const g = 1;\n"); // legit user code
    const diff = await collectDiff(repo);
    expect(diff).toContain("foo.ts");
    expect(diff).toContain(".gemini/config.ts"); // NOT over-excluded
    expect(diff).not.toContain(".antigravitycli");
  });

  it("excludes a COMMITTED .antigravitycli via the tracked pathspec", async () => {
    const repo = tmpRepo();
    mkdirSync(join(repo, ".antigravitycli"), { recursive: true });
    writeFileSync(join(repo, ".antigravitycli", "z"), "x\n");
    writeFileSync(join(repo, "bar.ts"), "export const b = 2;\n");
    spawnSync("git", ["add", "-A"], { cwd: repo });
    spawnSync("git", ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "-m", "c"], {
      cwd: repo,
    });
    writeFileSync(join(repo, "bar.ts"), "export const b = 3;\n");
    writeFileSync(join(repo, ".antigravitycli", "z"), "y\n");
    const diff = await collectDiff(repo);
    expect(diff).toContain("bar.ts");
    expect(diff).not.toContain(".antigravitycli");
  });
});
