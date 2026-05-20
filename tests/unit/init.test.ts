import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/cli/commands/init.ts";

function tmp() {
  return mkdtempSync(join(tmpdir(), "rg-init-"));
}

describe("runInit", () => {
  it("creates .claude/settings.json with Reviewgate hooks merged in", async () => {
    const repo = tmp();
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    const s = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    expect(s.hooks).toBeDefined();
    expect(Array.isArray(s.hooks.PostToolUse)).toBe(true);
    expect(Array.isArray(s.hooks.Stop)).toBe(true);
    expect(Array.isArray(s.hooks.SessionStart)).toBe(true);
    expect(JSON.stringify(s.hooks).includes(".reviewgate/bin/")).toBe(true);
  });

  it("copies bin templates to .reviewgate/bin/ and makes them executable", async () => {
    const repo = tmp();
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    for (const f of ["trigger", "gate", "reset"]) {
      const p = join(repo, ".reviewgate", "bin", f);
      expect(existsSync(p)).toBe(true);
      const stat = await (await import("node:fs/promises")).stat(p);
      // Owner-exec bit set
      expect(stat.mode & 0o100).toBeGreaterThan(0);
    }
  });

  it("appends Reviewgate entries to .gitignore without duplicating existing lines", async () => {
    const repo = tmp();
    // Pre-existing .gitignore with one of our lines
    await Bun.write(join(repo, ".gitignore"), "node_modules\n.reviewgate/audit/\n");
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    const gi = readFileSync(join(repo, ".gitignore"), "utf8");
    expect((gi.match(/\.reviewgate\/audit\//g) ?? []).length).toBe(1);
    expect(gi).toContain(".reviewgate/state.json");
  });

  it("is idempotent: running twice does not duplicate hooks", async () => {
    const repo = tmp();
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    const s = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
    expect(s.hooks.Stop.length).toBe(1);
    expect(s.hooks.PostToolUse.length).toBe(1);
  });
});
