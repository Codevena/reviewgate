import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTemplateDir } from "../../src/cli/commands/init.ts";
import { installHostHookDocument, readHookDocument } from "../../src/hosts/hooks.ts";
import {
  installUserHooks,
  removeUserHooks,
  repoClaudeHookActive,
  repoClaudeStopGateActive,
  userClaudeSettingsPath,
  userCommand,
  userHooksInstalled,
  userShimPath,
  userStopGateInstalled,
} from "../../src/hosts/user-hooks.ts";

// A TEMP home, ALWAYS. Touching the real ~/.claude/settings.json would rewrite the global
// hook config of every Claude Code session on this machine, including this test run.
function home(): string {
  return mkdtempSync(join(tmpdir(), "rg-userhooks-"));
}

function repo(): string {
  return mkdtempSync(join(tmpdir(), "rg-userhooks-repo-"));
}

const BIN = "/opt/reviewgate/bin/reviewgate";
const TPL = resolveTemplateDir();

const FOREIGN = {
  hooks: {
    Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/my-linter", timeout: 10 }] }],
    PreToolUse: [{ hooks: [{ type: "command", command: "/usr/local/bin/audit", timeout: 5 }] }],
  },
  someUnrelatedSetting: { keepMe: true },
};

function writeStopSettings(root: string, command: string): void {
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(
    join(root, ".claude", "settings.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command, timeout: 2400 }] }] } }),
  );
}

function addRepoShim(root: string, name = "gate", executable = true): void {
  mkdirSync(join(root, ".reviewgate", "bin"), { recursive: true });
  const shim = join(root, ".reviewgate", "bin", name);
  writeFileSync(shim, "#!/bin/sh\n");
  if (executable) chmodSync(shim, 0o755);
}

describe("user-scoped hook install", () => {
  test("installs Stop/PostToolUse/SessionStart fully wired, plus the shims", () => {
    const h = home();
    installUserHooks(h, BIN, TPL);
    const doc = JSON.parse(readFileSync(userClaudeSettingsPath(h), "utf8"));
    expect(Object.keys(doc.hooks).sort()).toEqual(["PostToolUse", "SessionStart", "Stop"]);
    // Assert each event is really wired, not merely present: an empty or mis-pointed
    // group would otherwise pass.
    const stop = doc.hooks.Stop[0].hooks[0];
    expect(stop.command).toBe(userCommand(h, "gate"));
    expect(stop.timeout).toBe(2400);
    const post = doc.hooks.PostToolUse[0];
    expect(post.matcher).toBe("Edit|Write|MultiEdit|NotebookEdit");
    expect(post.hooks[0].command).toBe(userCommand(h, "trigger"));
    expect(post.hooks[0].timeout).toBe(5);
    expect(post.hooks[0].async).toBe(true);
    const start = doc.hooks.SessionStart[0].hooks[0];
    expect(start.command).toBe(userCommand(h, "reset"));
    expect(start.timeout).toBe(30);
    for (const shim of ["gate", "trigger", "reset"] as const) {
      expect(existsSync(userShimPath(h, shim))).toBe(true);
      // The binary path is baked in, exactly as the repo-local shims do it.
      expect(readFileSync(userShimPath(h, shim), "utf8")).toContain(BIN);
    }
    expect(userHooksInstalled(h)).toBe(true);
  });

  test("PRESERVES foreign entries and unrelated settings", () => {
    const h = home();
    mkdirSync(join(h, ".claude"), { recursive: true });
    writeFileSync(userClaudeSettingsPath(h), JSON.stringify(FOREIGN, null, 2));
    installUserHooks(h, BIN, TPL);
    const doc = JSON.parse(readFileSync(userClaudeSettingsPath(h), "utf8"));
    expect(doc.someUnrelatedSetting).toEqual({ keepMe: true });
    expect(doc.hooks.PreToolUse).toEqual(FOREIGN.hooks.PreToolUse);
    // The user's own Stop hook survives ALONGSIDE Reviewgate's.
    const stopCommands = doc.hooks.Stop.flatMap((g: { hooks: { command: string }[] }) =>
      g.hooks.map((x) => x.command),
    );
    expect(stopCommands).toContain("/usr/local/bin/my-linter");
    expect(stopCommands).toContain(userCommand(h, "gate"));
  });

  test("re-running is idempotent (the refresh path)", () => {
    const h = home();
    installUserHooks(h, BIN, TPL);
    const first = readFileSync(userClaudeSettingsPath(h), "utf8");
    installUserHooks(h, BIN, TPL);
    expect(readFileSync(userClaudeSettingsPath(h), "utf8")).toBe(first);
  });

  test("--remove restores the document to its pre-install shape", () => {
    const h = home();
    mkdirSync(join(h, ".claude"), { recursive: true });
    writeFileSync(userClaudeSettingsPath(h), JSON.stringify(FOREIGN, null, 2));
    installUserHooks(h, BIN, TPL);
    removeUserHooks(h);
    const doc = JSON.parse(readFileSync(userClaudeSettingsPath(h), "utf8"));
    expect(doc.someUnrelatedSetting).toEqual({ keepMe: true });
    expect(doc.hooks).toEqual(FOREIGN.hooks);
    expect(existsSync(userShimPath(h, "gate"))).toBe(false);
    expect(userHooksInstalled(h)).toBe(false);
  });

  test("refuses to overwrite a malformed settings file and backs it up", () => {
    const h = home();
    mkdirSync(join(h, ".claude"), { recursive: true });
    writeFileSync(userClaudeSettingsPath(h), "{ not json");
    expect(() => installUserHooks(h, BIN, TPL)).toThrow(/refuses to overwrite/);
    expect(existsSync(`${userClaudeSettingsPath(h)}.bak`)).toBe(true);
  });
});

// The shim tests (Task 3) use a fake binary, so they prove the shim USES the query — not
// that the query is right. These cases test the predicates directly. Every one of them is
// a shape a plan-gate round showed a looser rule would get wrong.
describe("hook-command quoting", () => {
  test("a home containing shell metacharacters cannot expand at hook time", () => {
    // The host evaluates hook command strings through a shell (the repo-local entries
    // rely on that to expand ${CLAUDE_PROJECT_DIR}). A double-quoted path would still
    // expand $(...) / backticks / ${var}; single quotes with POSIX escaping do not.
    const evil = "/tmp/rg$(id)`whoami`${HOME}";
    const cmd = userCommand(evil, "gate");
    expect(cmd.startsWith("'")).toBe(true);
    expect(cmd.endsWith("'")).toBe(true);
    // Everything dangerous sits INSIDE single quotes, where the shell does not expand it.
    expect(cmd).toBe(`'${evil}/.reviewgate/bin/gate'`);
  });

  test("an apostrophe in the home path is POSIX-escaped, not left to break the quoting", () => {
    const cmd = userCommand("/Users/we're", "gate");
    // ' -> '\'' — otherwise the quote would terminate the string and the remainder
    // would be evaluated as shell code, the exact hazard shSingleQuote exists for.
    expect(cmd).toBe(`'/Users/we'\\''re/.reviewgate/bin/gate'`);
    expect(cmd.includes("'\\''")).toBe(true);
  });
});

describe("repo-local activity predicate", () => {
  test("fully wired Claude Stop hook → active", () => {
    const r = repo();
    addRepoShim(r);
    installHostHookDocument(r, "claude", readHookDocument(r, "claude"));
    expect(repoClaudeStopGateActive(r)).toBe(true);
    expect(repoClaudeHookActive(r, "Stop")).toBe(true);
  });

  test("codex-only init (shared shim, no Claude settings) → NOT active", () => {
    // init writes .reviewgate/bin/ host-independently, so the shim exists here while no
    // Claude hook does. Treating this as active is the fail-open the user shim must avoid.
    const r = repo();
    addRepoShim(r);
    expect(repoClaudeStopGateActive(r)).toBe(false);
  });

  test("Claude hook configured but its shim is missing → NOT active", () => {
    const r = repo();
    installHostHookDocument(r, "claude", readHookDocument(r, "claude"));
    expect(repoClaudeStopGateActive(r)).toBe(false);
  });

  test("shim present but NOT executable → NOT active", () => {
    const r = repo();
    addRepoShim(r, "gate", false);
    installHostHookDocument(r, "claude", readHookDocument(r, "claude"));
    expect(repoClaudeStopGateActive(r)).toBe(false);
  });

  test("a foreign command that merely MENTIONS the path → NOT active", () => {
    // `includes(".reviewgate/bin/gate")` would accept this; exact matching does not.
    const r = repo();
    addRepoShim(r);
    writeStopSettings(r, "echo .reviewgate/bin/gate");
    expect(repoClaudeStopGateActive(r)).toBe(false);
  });

  test("the right command in the WRONG event → NOT active for Stop", () => {
    const r = repo();
    addRepoShim(r);
    mkdirSync(join(r, ".claude"), { recursive: true });
    writeFileSync(
      join(r, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: '"${CLAUDE_PROJECT_DIR}/.reviewgate/bin/gate"',
                  timeout: 2400,
                },
              ],
            },
          ],
        },
      }),
    );
    expect(repoClaudeStopGateActive(r)).toBe(false);
  });

  test("per-event mapping: PostToolUse→trigger, SessionStart→reset", () => {
    const r = repo();
    for (const name of ["gate", "trigger", "reset"]) addRepoShim(r, name);
    installHostHookDocument(r, "claude", readHookDocument(r, "claude"));
    expect(repoClaudeHookActive(r, "PostToolUse")).toBe(true);
    expect(repoClaudeHookActive(r, "SessionStart")).toBe(true);
  });

  test("unreadable settings are never evidence", () => {
    const r = repo();
    addRepoShim(r);
    mkdirSync(join(r, ".claude"), { recursive: true });
    writeFileSync(join(r, ".claude", "settings.json"), "{ not json");
    expect(repoClaudeStopGateActive(r)).toBe(false);
  });
});

describe("user-scope Stop-gate detector", () => {
  test("a full install → gated", () => {
    const h = home();
    installUserHooks(h, BIN, TPL);
    expect(userStopGateInstalled(h)).toBe(true);
  });

  test("PostToolUse only, no Stop gate → NOT gated", () => {
    const h = home();
    installUserHooks(h, BIN, TPL);
    const doc = JSON.parse(readFileSync(userClaudeSettingsPath(h), "utf8"));
    doc.hooks.Stop = [];
    writeFileSync(userClaudeSettingsPath(h), JSON.stringify(doc));
    // userHooksInstalled is the broader install-health signal and still sees the other
    // events; only the strict detector may answer "is this gated?".
    expect(userHooksInstalled(h)).toBe(true);
    expect(userStopGateInstalled(h)).toBe(false);
  });

  test("a Stop command pointing at a STALE shim path → NOT gated", () => {
    const h = home();
    installUserHooks(h, BIN, TPL);
    const doc = JSON.parse(readFileSync(userClaudeSettingsPath(h), "utf8"));
    doc.hooks.Stop = [
      {
        hooks: [{ type: "command", command: '"/old/home/.reviewgate/bin/gate"', timeout: 2400 }],
      },
    ];
    writeFileSync(userClaudeSettingsPath(h), JSON.stringify(doc));
    expect(userStopGateInstalled(h)).toBe(false);
  });

  test("shim removed from disk → NOT gated", () => {
    const h = home();
    installUserHooks(h, BIN, TPL);
    chmodSync(userShimPath(h, "gate"), 0o644); // present but not runnable
    expect(userStopGateInstalled(h)).toBe(false);
  });
});
