// tests/e2e/triage-real.test.ts
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../../src/cli/commands/gate.ts";
import { runInit } from "../../src/cli/commands/init.ts";

const E2E = process.env.REVIEWGATE_E2E === "1";
const E2E_TIMEOUT_MS = 300_000;

(E2E ? describe : describe.skip)("e2e adaptive (triage + research)", () => {
  it(
    "runs review with a symbol-graph research.md for a code diff",
    async () => {
      const repo = mkdtempSync(join(tmpdir(), "rg-e2e-tri-"));
      spawnSync("git", ["init", "-q"], { cwd: repo });
      writeFileSync(
        join(repo, "token.ts"),
        "export function compareToken(a: string, b: string): boolean {\n  return a === b;\n}\n",
      );
      spawnSync("git", ["add", "."], { cwd: repo });
      spawnSync(
        "git",
        ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "-m", "init"],
        { cwd: repo },
      );
      writeFileSync(
        join(repo, "token.ts"),
        "export function compareToken(a: string, b: string): boolean {\n  return a == b;\n}\n",
      );
      await runInit({ repoRoot: repo, mode: "agent-loop" });
      await runGate({
        repoRoot: repo,
        hook: "trigger",
        hookStdinRaw: JSON.stringify({ tool: { name: "Edit", path: "token.ts" } }),
      });
      const stop = await runGate({ repoRoot: repo, hook: "stop", hookStdinRaw: "{}" });
      expect(stop.exitCode).toBe(0);
      expect(existsSync(join(repo, ".reviewgate", "research.md"))).toBe(true);
      const research = readFileSync(join(repo, ".reviewgate", "research.md"), "utf8");
      expect(research).toContain("Symbol graph");
      expect(research.toLowerCase()).toContain("comparetoken");
      expect(existsSync(join(repo, ".reviewgate", "pending.md"))).toBe(true);
    },
    E2E_TIMEOUT_MS,
  );
});
