// tests/unit/git.test.ts
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDiff, collectGitInfo, gitHeadSha } from "../../src/utils/git.ts";

function commitAll(dir: string, msg: string): void {
  spawnSync("git", ["add", "-A"], { cwd: dir });
  spawnSync("git", ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "-m", msg], {
    cwd: dir,
  });
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-git-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "existing.ts"), "export const a = 1;\n");
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "-m", "init"], {
    cwd: dir,
  });
  return dir;
}

describe("collectDiff", () => {
  it("includes BOTH a tracked modification and an untracked new file", () => {
    const dir = repo();
    writeFileSync(join(dir, "existing.ts"), "export const a = 2;\n"); // tracked change
    writeFileSync(join(dir, "newmod.ts"), "export const SECRET = 'x';\n"); // untracked new file
    const diff = collectDiff(dir);
    expect(diff).toContain("diff --git a/existing.ts b/existing.ts");
    expect(diff).toContain("diff --git a/newmod.ts b/newmod.ts"); // the bug-1 fix
    expect(diff).toContain("SECRET"); // new-file content is present for the reviewer
  });

  it("reviews COMMITTED changes since a base SHA (commit-per-task), not just the working tree", () => {
    const dir = repo();
    const base = gitHeadSha(dir); // pre-batch HEAD
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    // Agent edits AND commits (commit-per-task) → working tree is now clean.
    writeFileSync(join(dir, "feature.ts"), "export const FEATURE = 'shipped';\n");
    commitAll(dir, "feat: add feature");

    // Default (HEAD) sees NOTHING — the working tree is clean (the gap).
    expect(collectDiff(dir)).toBe("");
    // Diffing against the pre-batch base captures the committed change.
    const sinceBase = collectDiff(dir, base);
    expect(sinceBase).toContain("diff --git a/feature.ts b/feature.ts");
    expect(sinceBase).toContain("FEATURE");
  });

  it("includes committed AND uncommitted changes since the base", () => {
    const dir = repo();
    const base = gitHeadSha(dir);
    writeFileSync(join(dir, "committed.ts"), "export const C = 1;\n");
    commitAll(dir, "feat: committed");
    writeFileSync(join(dir, "wip.ts"), "export const W = 2;\n"); // uncommitted (untracked)
    const diff = collectDiff(dir, base);
    expect(diff).toContain("committed.ts");
    expect(diff).toContain("wip.ts");
  });

  it("falls back to HEAD when the base SHA is invalid/stale", () => {
    const dir = repo();
    writeFileSync(join(dir, "existing.ts"), "export const a = 9;\n"); // working-tree change
    const diff = collectDiff(dir, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"); // nonexistent sha
    expect(diff).toContain("diff --git a/existing.ts b/existing.ts"); // still got the WT diff
  });

  it("excludes gitignored files (no diff header for the ignored file)", () => {
    const dir = repo();
    writeFileSync(join(dir, ".gitignore"), "ignored.ts\n");
    writeFileSync(join(dir, "ignored.ts"), "export const SHOULD_NOT_APPEAR = 1;\n");
    const diff = collectDiff(dir);
    // The ignored file is never reviewed: no diff block for it, and its content
    // is absent. (The .gitignore file itself IS reviewed, which is fine.)
    expect(diff).not.toContain("diff --git a/ignored.ts b/ignored.ts");
    expect(diff).not.toContain("SHOULD_NOT_APPEAR");
  });

  it("never reviews Reviewgate's own managed files (no self-review loop)", () => {
    const { mkdirSync } = require("node:fs") as typeof import("node:fs");
    const dir = repo();
    // Reviewgate scaffolding that sits permanently in the working tree:
    writeFileSync(join(dir, "reviewgate.config.ts"), "export default { providers: {} };\n");
    mkdirSync(join(dir, ".reviewgate", "bin"), { recursive: true });
    writeFileSync(join(dir, ".reviewgate", "bin", "gate"), "#!/usr/bin/env bash\n");
    // A real user file that MUST still be reviewed:
    writeFileSync(join(dir, "real.ts"), "export const x = 1;\n");
    const diff = collectDiff(dir);
    expect(diff).toContain("diff --git a/real.ts b/real.ts"); // real file reviewed
    expect(diff).not.toContain("reviewgate.config.ts"); // own config excluded
    expect(diff).not.toContain(".reviewgate/bin/gate"); // own scaffolding excluded
  });
});

describe("collectGitInfo", () => {
  it("returns the real sha, branch, and dirty files", () => {
    const dir = repo();
    writeFileSync(join(dir, "existing.ts"), "export const a = 2;\n");
    writeFileSync(join(dir, "newmod.ts"), "x");
    const info = collectGitInfo(dir);
    expect(info.sha).toMatch(/^[0-9a-f]{40}$/); // real sha, not 000…
    expect(info.branch.length).toBeGreaterThan(0);
    expect(info.dirtyFiles).toContain("existing.ts");
    expect(info.dirtyFiles).toContain("newmod.ts");
  });
});
