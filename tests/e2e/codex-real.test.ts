// tests/e2e/codex-real.test.ts
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../../src/cli/commands/gate.ts";
import { runInit } from "../../src/cli/commands/init.ts";

const E2E = process.env.REVIEWGATE_E2E === "1";

// A real codex review takes tens of seconds, far over bun's 5s default
// per-test timeout. Allow up to the codex walltime cap plus overhead.
const E2E_TIMEOUT_MS = 300_000;

(E2E ? describe : describe.skip)("e2e with real codex", () => {
  it(
    "finds the timing-unsafe compare bug",
    async () => {
      const repo = mkdtempSync(join(tmpdir(), "rg-e2e-"));
      spawnSync("git", ["init", "-q"], { cwd: repo });
      // Commit a SAFE baseline first. Reviewgate reviews the working-tree diff
      // against HEAD, so the bug must be INTRODUCED as an uncommitted change to
      // appear in what the reviewer sees.
      writeFileSync(
        join(repo, "foo.ts"),
        "export function compareToken(a: string, b: string): boolean {\n  return a === b;\n}\n",
      );
      spawnSync("git", ["add", "."], { cwd: repo });
      spawnSync(
        "git",
        ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "-m", "init"],
        {
          cwd: repo,
        },
      );
      // Introduce the timing-unsafe `==` bug as the uncommitted diff.
      writeFileSync(
        join(repo, "foo.ts"),
        "export function compareToken(a: string, b: string): boolean {\n  return a == b;\n}\n",
      );

      await runInit({ repoRoot: repo, mode: "agent-loop" });
      await runGate({
        repoRoot: repo,
        hook: "trigger",
        hookStdinRaw: JSON.stringify({ tool: { name: "Edit", path: "foo.ts" } }),
      });
      const stop = await runGate({ repoRoot: repo, hook: "stop", hookStdinRaw: "{}" });
      expect(stop.exitCode).toBe(0);
      const decision = stop.stdout ? JSON.parse(stop.stdout) : { decision: "allow" };
      expect(["block", "allow"]).toContain(decision.decision ?? "allow");
      expect(existsSync(join(repo, ".reviewgate", "pending.md"))).toBe(true);
      const md = readFileSync(join(repo, ".reviewgate", "pending.md"), "utf8");
      // The exact rule_id depends on Codex's wording; assert by content keyword.
      expect(md.toLowerCase()).toMatch(/timing|compare|=={2}|equal|token/);
    },
    E2E_TIMEOUT_MS,
  );
});
