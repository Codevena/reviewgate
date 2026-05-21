// tests/unit/git-file-contents.test.ts
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectChangedFileContents } from "../../src/utils/git.ts";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-git-fc-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "e@e"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "e"], { cwd: dir });
  return dir;
}

function commit(dir: string, msg = "init"): void {
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "-m", msg], {
    cwd: dir,
  });
}

describe("collectChangedFileContents", () => {
  it("includes changed tracked file's full content", () => {
    const dir = repo();
    writeFileSync(join(dir, "tracked.ts"), "export const original = 1;\n");
    commit(dir);
    writeFileSync(join(dir, "tracked.ts"), "export const modified = 2;\n");

    const result = collectChangedFileContents(dir);

    expect(result).toContain("### tracked.ts");
    expect(result).toContain("export const modified = 2;");
  });

  it("includes untracked new file's full content", () => {
    const dir = repo();
    writeFileSync(join(dir, "existing.ts"), "export const a = 1;\n");
    commit(dir);
    writeFileSync(join(dir, "untracked.ts"), "export const newSymbol = 42;\n");

    const result = collectChangedFileContents(dir);

    expect(result).toContain("### untracked.ts");
    expect(result).toContain("export const newSymbol = 42;");
  });

  it("excludes .reviewgate/ files", () => {
    const dir = repo();
    writeFileSync(join(dir, "real.ts"), "export const x = 1;\n");
    commit(dir);
    mkdirSync(join(dir, ".reviewgate"), { recursive: true });
    writeFileSync(join(dir, ".reviewgate", "pending.md"), "# pending\n");
    writeFileSync(join(dir, "real.ts"), "export const x = 2;\n");

    const result = collectChangedFileContents(dir);

    expect(result).toContain("### real.ts");
    expect(result).not.toContain(".reviewgate/pending.md");
    expect(result).not.toContain("# pending");
  });

  it("excludes reviewgate.config.ts", () => {
    const dir = repo();
    writeFileSync(join(dir, "src.ts"), "export const y = 1;\n");
    commit(dir);
    writeFileSync(join(dir, "reviewgate.config.ts"), "export default { providers: {} };\n");
    writeFileSync(join(dir, "src.ts"), "export const y = 2;\n");

    const result = collectChangedFileContents(dir);

    expect(result).toContain("### src.ts");
    expect(result).not.toContain("reviewgate.config.ts");
  });

  it("never follows a symlink (no leaking files outside the repo into prompts)", () => {
    const dir = repo();
    writeFileSync(join(dir, "real.ts"), "export const x = 1;\n");
    commit(dir);
    // A secret outside the repo + an untracked symlink pointing at it.
    const secret = mkdtempSync(join(tmpdir(), "rg-secret-"));
    writeFileSync(join(secret, "id_rsa"), "SUPER_SECRET_PRIVATE_KEY\n");
    symlinkSync(join(secret, "id_rsa"), join(dir, "leak.ts"));

    const result = collectChangedFileContents(dir);

    expect(result).not.toContain("SUPER_SECRET_PRIVATE_KEY");
    expect(result).not.toContain("### leak.ts");
  });

  it("triggers the (omitted — context budget exceeded) note for tiny maxBytes", () => {
    const dir = repo();
    writeFileSync(join(dir, "big.ts"), "export const lots = 'aaaaaaaaaaaaaaa';\n");
    commit(dir);
    writeFileSync(join(dir, "big.ts"), "export const lots = 'bbbbbbbbbbbbbbb';\n");

    // maxBytes so small that the file block exceeds it
    const result = collectChangedFileContents(dir, 10);

    expect(result).toContain("(omitted — context budget exceeded)");
  });
});
