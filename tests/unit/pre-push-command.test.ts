// tests/unit/pre-push-command.test.ts
// Rec #3 (deep half): the `reviewgate pre-push` command (warn-only) + parsePushedShas, and the
// init git-hook installer (conservative, no-clobber).
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installGitPrePushHook } from "../../src/cli/commands/init.ts";
import { parsePushedShas, runPrePush } from "../../src/cli/commands/pre-push.ts";
import { StateStore } from "../../src/core/state-store.ts";

const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const ZERO = "0".repeat(40);
const line = (localOid: string) => `refs/heads/main ${localOid} refs/heads/main ${OTHER}`;

function repo(): string {
  return mkdtempSync(join(tmpdir(), "rg-prepush-"));
}

describe("parsePushedShas", () => {
  it("extracts the local oid (field 2) per line, skipping deletes (all-zero) and blanks", () => {
    const stdin = `${line(SHA)}\n${line(ZERO)}\n\n${line(OTHER)}\n`;
    expect(parsePushedShas(stdin).sort()).toEqual([SHA, OTHER].sort());
  });
  it("returns [] for empty stdin", () => {
    expect(parsePushedShas("")).toEqual([]);
  });
});

describe("runPrePush (warn-only, always exit 0)", () => {
  async function withPass(dir: string, headSha: string): Promise<void> {
    const store = new StateStore(dir);
    await store.initialise("S");
    await store.update((s) => ({ ...s, iteration: 0, last_reviewed_head_sha: headSha }));
  }

  it("no warning when the pushed tip is the last reviewed clean HEAD", async () => {
    const dir = repo();
    await withPass(dir, SHA);
    const res = await runPrePush({ repoRoot: dir, stdinRaw: line(SHA) });
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
  });

  it("warns (exit 0) when pushing a tip the gate did not review", async () => {
    const dir = repo();
    await withPass(dir, SHA);
    const res = await runPrePush({ repoRoot: dir, stdinRaw: line(OTHER) });
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("Reviewgate pre-push");
    expect(res.stderr).toContain("not the last reviewed HEAD");
  });

  it("warns when there is no state at all (still exit 0)", async () => {
    const dir = repo();
    const res = await runPrePush({ repoRoot: dir, stdinRaw: line(SHA) });
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toContain("no Reviewgate state");
  });

  it("is silent when loop.prePushWarn is false", async () => {
    const dir = repo();
    writeFileSync(
      join(dir, "reviewgate.config.ts"),
      "export default { loop: { prePushWarn: false } };\n",
    );
    const res = await runPrePush({ repoRoot: dir, stdinRaw: line(OTHER) });
    expect(res.exitCode).toBe(0);
    expect(res.stderr).toBe("");
  });
});

describe("installGitPrePushHook (conservative, no-clobber)", () => {
  it("installs a warn-only hook into a real .git/hooks", () => {
    const dir = repo();
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    const r = installGitPrePushHook(dir, join(dir, ".reviewgate", "bin", "pre-push"));
    expect(r.installed).toBe(true);
    const hook = readFileSync(join(dir, ".git", "hooks", "pre-push"), "utf8");
    expect(hook).toContain("Reviewgate-managed git pre-push hook");
    expect(hook).toContain("exit 0"); // never blocks
  });

  it("does NOT clobber a foreign existing pre-push hook", () => {
    const dir = repo();
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    const hookPath = join(dir, ".git", "hooks", "pre-push");
    writeFileSync(hookPath, "#!/bin/sh\necho mine\n");
    const r = installGitPrePushHook(dir, join(dir, ".reviewgate", "bin", "pre-push"));
    expect(r.installed).toBe(false);
    expect(readFileSync(hookPath, "utf8")).toContain("echo mine"); // untouched
  });

  it("updates a previously Reviewgate-managed hook (idempotent)", () => {
    const dir = repo();
    mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
    const shim = join(dir, ".reviewgate", "bin", "pre-push");
    installGitPrePushHook(dir, shim);
    const r = installGitPrePushHook(dir, shim); // second run overwrites our own marker
    expect(r.installed).toBe(true);
  });

  it("skips when .git is not a plain directory (worktree/none)", () => {
    const dir = repo(); // no .git
    const r = installGitPrePushHook(dir, join(dir, ".reviewgate", "bin", "pre-push"));
    expect(r.installed).toBe(false);
    expect(existsSync(join(dir, ".git"))).toBe(false);
  });
});
