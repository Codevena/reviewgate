// tests/unit/git.test.ts
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectDiff, collectGitInfo } from "../../src/utils/git.ts";

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
