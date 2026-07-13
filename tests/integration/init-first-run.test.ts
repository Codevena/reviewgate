import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "index.ts");

function repo(): string {
  return mkdtempSync(join(tmpdir(), "rg-first-run-"));
}

describe("reviewgate init first-run orchestration", () => {
  it("rejects an unknown host before writing setup files", () => {
    const cwd = repo();
    const result = spawnSync("bun", [CLI, "init", "--quick", "--host", "other"], {
      cwd,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("expected claude, codex, or both");
    expect(existsSync(join(cwd, ".reviewgate"))).toBe(false);
  });

  it("configures policy, installs both hosts and records the initial LKG in one command", () => {
    const cwd = repo();
    const result = spawnSync("bun", [CLI, "init", "--quick", "--host", "both", "--skip-doctor"], {
      cwd,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(existsSync(join(cwd, "reviewgate.config.ts"))).toBe(true);
    expect(existsSync(join(cwd, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(cwd, ".codex", "hooks.json"))).toBe(true);
    expect(existsSync(join(cwd, ".reviewgate", "control-plane.json"))).toBe(true);

    const policy = JSON.parse(
      readFileSync(join(cwd, ".reviewgate", "control-plane.json"), "utf8"),
    ) as { approved_config?: unknown; pending?: unknown };
    expect(policy.approved_config).toBeDefined();
    expect(policy.pending).toBeNull();
    expect(result.stdout).toContain("gate armed for claude + codex");
    expect(result.stdout).toContain("/hooks");
  });

  it("supports a hooks-only repair without rewriting an existing config", () => {
    const cwd = repo();
    const first = spawnSync("bun", [CLI, "init", "--quick", "--host", "codex", "--skip-doctor"], {
      cwd,
      encoding: "utf8",
    });
    expect(first.status).toBe(0);
    const before = readFileSync(join(cwd, "reviewgate.config.ts"), "utf8");

    const repair = spawnSync("bun", [CLI, "init", "--hooks-only", "--host", "both"], {
      cwd,
      encoding: "utf8",
    });
    expect(repair.status).toBe(0);
    expect(readFileSync(join(cwd, "reviewgate.config.ts"), "utf8")).toBe(before);
    expect(existsSync(join(cwd, ".claude", "settings.json"))).toBe(true);
    expect(existsSync(join(cwd, ".codex", "hooks.json"))).toBe(true);
  }, 15_000);
});
