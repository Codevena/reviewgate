import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/cli/commands/init.ts";

describe("init scaffolds .antigravitycli into .gitignore", () => {
  it("adds .antigravitycli (no trailing slash) idempotently", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-init-gi-"));
    spawnSync("git", ["init", "-q"], { cwd: repo });
    await runInit({ repoRoot: repo, mode: "agent-loop" });
    const gi1 = readFileSync(join(repo, ".gitignore"), "utf8");
    expect(gi1).toContain("\n.antigravitycli\n");
    await runInit({ repoRoot: repo, mode: "agent-loop" }); // idempotent
    const gi2 = readFileSync(join(repo, ".gitignore"), "utf8");
    expect(gi2.split("\n").filter((l) => l.trim() === ".antigravitycli").length).toBe(1);
  });
});
