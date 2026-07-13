// tests/e2e/gemini-real.test.ts
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../../src/cli/commands/gate.ts";
import { runInit } from "../../src/cli/commands/init.ts";

const E2E = process.env.REVIEWGATE_E2E === "1";
const E2E_TIMEOUT_MS = 300_000;

(E2E ? describe : describe.skip)("e2e with real agy (gemini provider)", () => {
  it(
    "gemini reviewer flags the timing-unsafe compare",
    async () => {
      const repo = mkdtempSync(join(tmpdir(), "rg-e2e-gem-"));
      spawnSync("git", ["init", "-q"], { cwd: repo });
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
      writeFileSync(
        join(repo, "foo.ts"),
        "export function compareToken(a: string, b: string): boolean {\n  return a == b;\n}\n",
      );
      writeFileSync(
        join(repo, "reviewgate.config.ts"),
        'export default { providers: { gemini: { enabled: true, auth: "oauth", model: "agy-default", timeoutMs: 300000 } }, phases: { review: { reviewers: [{ provider: "gemini", persona: "security" }] } } };\n',
      );
      await runInit({ repoRoot: repo, mode: "agent-loop" });
      await runGate({
        repoRoot: repo,
        hook: "trigger",
        hookStdinRaw: JSON.stringify({ tool: { name: "Edit", path: "foo.ts" } }),
      });
      const stop = await runGate({ repoRoot: repo, hook: "stop", hookStdinRaw: "{}" });
      expect(stop.exitCode).toBe(0);
      expect(existsSync(join(repo, ".reviewgate", "pending.md"))).toBe(true);
      const md = readFileSync(join(repo, ".reviewgate", "pending.md"), "utf8");
      expect(md.toLowerCase()).toMatch(/timing|compare|=={2}|equal|token|coerc/);
    },
    E2E_TIMEOUT_MS,
  );
});
