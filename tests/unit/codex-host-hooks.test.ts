import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/cli/commands/init.ts";
import { anyHooksInstalled, hooksInstalled } from "../../src/hosts/hooks.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "rg-codex-host-"));
}

type Hooks = Record<
  string,
  Array<{
    matcher?: string;
    hooks: Array<{
      command: string;
      timeout?: number;
      async?: boolean;
      statusMessage?: string;
    }>;
  }>
>;

function codexHooks(repo: string): Hooks {
  return (
    JSON.parse(readFileSync(join(repo, ".codex", "hooks.json"), "utf8")) as {
      hooks: Hooks;
    }
  ).hooks;
}

describe("native Codex host hook installation", () => {
  it("installs Codex without implicitly installing Claude Code", async () => {
    const repo = tmp();
    const result = await runInit({ repoRoot: repo, mode: "agent-loop", host: "codex" });

    expect(result.installedHosts).toEqual(["codex"]);
    expect(existsSync(join(repo, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(repo, ".claude", "settings.json"))).toBe(false);
    expect(hooksInstalled(repo, "codex")).toBe(true);
    expect(hooksInstalled(repo, "claude")).toBe(false);
    expect(anyHooksInstalled(repo)).toBe(true);
  });

  it("uses Codex-native matchers and never writes an unsupported async command hook", async () => {
    const repo = tmp();
    await runInit({ repoRoot: repo, mode: "agent-loop", host: "codex" });
    const hooks = codexHooks(repo);

    expect(hooks.PostToolUse?.[0]?.matcher).toBe("Bash|apply_patch|Edit|Write");
    expect(hooks.PostToolUse?.[0]?.hooks[0]?.async).toBeUndefined();
    expect(hooks.Stop?.[0]?.matcher).toBeUndefined();
    expect(hooks.Stop?.[0]?.hooks[0]?.timeout).toBe(2400);
    expect(hooks.SessionStart?.[0]?.matcher).toBe("startup|resume|clear|compact");
  });

  it("runs from the repository root and fails closed before the shared Stop shim if it is missing", async () => {
    const repo = tmp();
    await runInit({ repoRoot: repo, mode: "agent-loop", host: "codex" });
    const hooks = codexHooks(repo);
    const command = hooks.Stop?.[0]?.hooks[0]?.command ?? "";

    expect(command).toContain("git rev-parse --show-toplevel");
    expect(command).toContain('cd "$ROOT"');
    expect(command).toContain('"$ROOT/.reviewgate/bin/gate"');
    expect(command).toContain("REVIEWGATE_AGENT_HOST=codex");
    expect(command).toContain('"decision":"block"');
    expect(command).toContain("Failing CLOSED");
  });

  it("executes a Codex hook from a subdirectory with repo-root cwd and stdin preserved", async () => {
    const repo = tmp();
    spawnSync("git", ["init", "-q"], { cwd: repo });
    await runInit({ repoRoot: repo, mode: "agent-loop", host: "codex" });
    const hooks = codexHooks(repo);
    const command = hooks.PostToolUse?.[0]?.hooks[0]?.command ?? "";
    const nested = join(repo, "packages", "api");
    const fakeBinDir = join(repo, "fake-bin");
    mkdirSync(nested, { recursive: true });
    mkdirSync(fakeBinDir, { recursive: true });
    const fakeReviewgate = join(fakeBinDir, "reviewgate");
    writeFileSync(
      fakeReviewgate,
      `#!/bin/sh\npwd > '${repo}/observed-cwd'\nprintf '%s' "$REVIEWGATE_AGENT_HOST" > '${repo}/observed-host'\ncat > '${repo}/observed-stdin'\n`,
    );
    chmodSync(fakeReviewgate, 0o755);
    const payload = '{"hook_event_name":"PostToolUse","tool_name":"Bash"}';
    const result = spawnSync("bash", ["-c", command], {
      cwd: nested,
      encoding: "utf8",
      input: payload,
      env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH ?? ""}` },
    });
    expect(result.status).toBe(0);
    expect(realpathSync(readFileSync(join(repo, "observed-cwd"), "utf8").trim())).toBe(
      realpathSync(repo),
    );
    expect(readFileSync(join(repo, "observed-stdin"), "utf8")).toBe(payload);
    expect(readFileSync(join(repo, "observed-host"), "utf8")).toBe("codex");
  });

  it("emits a valid block decision when the Codex Stop shim is missing", async () => {
    const repo = tmp();
    await runInit({ repoRoot: repo, mode: "agent-loop", host: "codex" });
    const command = codexHooks(repo).Stop?.[0]?.hooks[0]?.command ?? "";
    rmSync(join(repo, ".reviewgate", "bin", "gate"));
    const result = spawnSync("bash", ["-c", command], { cwd: repo, encoding: "utf8" });
    expect(result.status).toBe(0);
    const decision = JSON.parse(result.stdout);
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("Reviewgate's Codex Stop gate");
  });

  it("preserves foreign Codex hooks and is idempotent", async () => {
    const repo = tmp();
    mkdirSync(join(repo, ".codex"), { recursive: true });
    writeFileSync(
      join(repo, ".codex", "hooks.json"),
      JSON.stringify({
        custom: { keep: true },
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo foreign", timeout: 7 }] }],
        },
      }),
    );

    await runInit({ repoRoot: repo, mode: "agent-loop", host: "codex" });
    await runInit({ repoRoot: repo, mode: "agent-loop", host: "codex" });
    const document = JSON.parse(readFileSync(join(repo, ".codex", "hooks.json"), "utf8")) as {
      custom: { keep: boolean };
      hooks: Hooks;
    };

    expect(document.custom.keep).toBe(true);
    expect(
      document.hooks.Stop?.filter((group) => group.hooks[0]?.command === "echo foreign"),
    ).toHaveLength(1);
    expect(
      document.hooks.Stop?.filter((group) =>
        group.hooks.some((hook) => hook.command.includes(".reviewgate/bin/gate")),
      ),
    ).toHaveLength(1);
  });

  it("preserves a foreign command that shares a hook group with an older Reviewgate command", async () => {
    const repo = tmp();
    await runInit({ repoRoot: repo, mode: "agent-loop", host: "codex" });
    writeFileSync(
      join(repo, ".codex", "hooks.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                { type: "command", command: "echo foreign", timeout: 7 },
                { type: "command", command: "./.reviewgate/bin/old-gate", timeout: 9 },
              ],
            },
          ],
        },
      }),
    );

    await runInit({ repoRoot: repo, mode: "agent-loop", host: "codex" });
    const commands = codexHooks(repo).Stop?.flatMap((group) =>
      group.hooks.map((hook) => hook.command),
    );
    expect(commands).toContain("echo foreign");
    expect(commands).not.toContain("./.reviewgate/bin/old-gate");
    expect(commands?.filter((command) => command.includes(".reviewgate/bin/gate"))).toHaveLength(1);
  });

  it("validates both host documents before writing either one", async () => {
    const repo = tmp();
    mkdirSync(join(repo, ".codex"), { recursive: true });
    writeFileSync(join(repo, ".codex", "hooks.json"), "{ invalid");

    await expect(runInit({ repoRoot: repo, mode: "agent-loop", host: "both" })).rejects.toThrow(
      /\.codex.*hooks\.json.*backed up/i,
    );
    expect(existsSync(join(repo, ".codex", "hooks.json.bak"))).toBe(true);
    expect(existsSync(join(repo, ".claude", "settings.json"))).toBe(false);
  });

  it("preserves and warns about inline Codex TOML hooks instead of editing them", async () => {
    const repo = tmp();
    mkdirSync(join(repo, ".codex"), { recursive: true });
    const toml = '[[hooks.Stop]]\nmatcher = "anything"\n';
    writeFileSync(join(repo, ".codex", "config.toml"), toml);
    const result = await runInit({ repoRoot: repo, mode: "agent-loop", host: "codex" });
    expect(readFileSync(join(repo, ".codex", "config.toml"), "utf8")).toBe(toml);
    expect(result.warnings.join(" ")).toContain("merges");
  });
});
