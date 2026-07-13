// tests/e2e/openrouter-real.test.ts
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGate } from "../../src/cli/commands/gate.ts";
import { runInit } from "../../src/cli/commands/init.ts";

// Needs both the e2e gate AND an OpenRouter key (read from the env, never committed).
const E2E = process.env.REVIEWGATE_E2E === "1" && Boolean(process.env.OPENROUTER_API_KEY);
const E2E_TIMEOUT_MS = 300_000;

(E2E ? describe : describe.skip)("e2e with real openrouter", () => {
  it(
    "an OpenRouter model (by name) flags the timing-unsafe compare",
    async () => {
      const repo = mkdtempSync(join(tmpdir(), "rg-e2e-or-"));
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
        'export default { providers: { openrouter: { enabled: true, auth: "openrouter", apiKeyEnv: "OPENROUTER_API_KEY", model: "google/gemini-2.0-flash-001", timeoutMs: 120000 } }, phases: { review: { reviewers: [{ provider: "openrouter", persona: "security" }] } } };\n',
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
      expect(md.toLowerCase()).toMatch(/timing|compare|=={2}|equal|coerc|eqeq/);
    },
    E2E_TIMEOUT_MS,
  );
});
