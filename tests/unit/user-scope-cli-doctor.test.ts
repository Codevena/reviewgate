import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userScopeCheck, worktreeGatedCheck } from "../../src/cli/commands/doctor.ts";
import { resolveTemplateDir, runInitUser } from "../../src/cli/commands/init.ts";
import {
  installUserHooks,
  userClaudeSettingsPath,
  userShimPath,
} from "../../src/hosts/user-hooks.ts";

const TPL = resolveTemplateDir();
const BIN = "/opt/reviewgate/bin/reviewgate";

// A TEMP home, always — the user-scope checks read ~/.claude/settings.json, and a test
// pointed at the real one would report on (or rewrite) this machine's global hook config.
function home(): string {
  return mkdtempSync(join(tmpdir(), "rg-userscope-"));
}

describe("runInitUser", () => {
  test("installs into the given home and touches no repository", () => {
    const h = home();
    const cwd = mkdtempSync(join(tmpdir(), "rg-userscope-cwd-"));
    const before = process.cwd();
    process.chdir(cwd);
    try {
      expect(runInitUser({ home: h })).toBe(0);
    } finally {
      process.chdir(before);
    }
    expect(existsSync(userClaudeSettingsPath(h))).toBe(true);
    // User scope must never arm or write into a repo — that is what `init` is for.
    expect(existsSync(join(cwd, ".reviewgate"))).toBe(false);
    expect(existsSync(join(cwd, ".claude"))).toBe(false);
  });

  test("--remove takes the hooks and shims back out", () => {
    const h = home();
    runInitUser({ home: h });
    expect(runInitUser({ home: h, remove: true })).toBe(0);
    expect(existsSync(userShimPath(h, "gate"))).toBe(false);
  });
});

describe("doctor user-scope check", () => {
  test("silent when the user never opted in", () => {
    expect(userScopeCheck(home())).toBeNull();
  });

  test("ok when installed with a runnable Stop gate", () => {
    const h = home();
    installUserHooks(h, BIN, TPL);
    expect(userScopeCheck(h)?.status).toBe("ok");
  });

  test("FAILs when the settings reference shims that are gone", () => {
    // This fires in every repo the user opens and skips the review each time, so it is a
    // failure rather than a warning.
    const h = home();
    installUserHooks(h, BIN, TPL);
    rmSync(userShimPath(h, "gate"));
    const check = userScopeCheck(h);
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("gate");
  });

  test("WARNs when hooks exist but no runnable Stop gate is among them", () => {
    const h = home();
    installUserHooks(h, BIN, TPL);
    chmodSync(userShimPath(h, "gate"), 0o644); // present, not runnable
    expect(userScopeCheck(h)?.status).toBe("warn");
  });
});

describe("doctor worktree gating with user scope", () => {
  async function worktree(): Promise<string> {
    const main = mkdtempSync(join(tmpdir(), "rg-userscope-main-"));
    await Bun.$`git -C ${main} init -q`.quiet();
    await Bun.$`git -C ${main} -c user.email=t@t -c user.name=t commit -q --allow-empty -m i`.quiet();
    const wt = join(mkdtempSync(join(tmpdir(), "rg-userscope-wt-")), "wt");
    await Bun.$`git -C ${main} worktree add -q ${wt} -b feat`.quiet();
    return wt;
  }

  test("still FAILs in an un-gated worktree when user scope is not installed", async () => {
    const wt = await worktree();
    const check = await worktreeGatedCheck(wt, home());
    expect(check?.status).toBe("fail");
  });

  test("reports ok once user-scoped hooks gate it", async () => {
    const wt = await worktree();
    const h = home();
    installUserHooks(h, BIN, TPL);
    const check = await worktreeGatedCheck(wt, h);
    expect(check?.status).toBe("ok");
    expect(check?.detail).toContain("user-scoped");
  });

  test("does NOT report ok when only a non-Stop user hook remains", async () => {
    // The honesty guard: "gated" must mean a Stop gate that can actually run, not merely
    // that some Reviewgate entry exists somewhere in the user settings.
    const wt = await worktree();
    const h = home();
    installUserHooks(h, BIN, TPL);
    const parsed = JSON.parse(await Bun.file(userClaudeSettingsPath(h)).text());
    parsed.hooks.Stop = [];
    writeFileSync(userClaudeSettingsPath(h), JSON.stringify(parsed));
    const check = await worktreeGatedCheck(wt, h);
    expect(check?.status).toBe("fail");
  });

  test("returns null outside a linked worktree", async () => {
    const plain = mkdtempSync(join(tmpdir(), "rg-userscope-plain-"));
    mkdirSync(join(plain, "sub"), { recursive: true });
    expect(await worktreeGatedCheck(plain, home())).toBeNull();
  });
});
