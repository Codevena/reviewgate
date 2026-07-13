import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/cli/commands/init.ts";
import { runSetup } from "../../src/cli/commands/setup.ts";
import { controlPlaneStatePath } from "../../src/utils/paths.ts";

test("the full init preflight refuses a missing LKG before rewriting existing config", async () => {
  const repo = mkdtempSync(join(tmpdir(), "rg-init-preflight-"));
  await runInit({ repoRoot: repo, mode: "agent-loop", host: "codex" });
  const configPath = join(repo, "reviewgate.config.ts");
  const sentinel = "export default { loop: { maxIterations: 5 } };\n";
  writeFileSync(configPath, sentinel);
  rmSync(controlPlaneStatePath(repo));

  await expect(
    runSetup({
      repoRoot: repo,
      install: true,
      projectOnly: true,
      commandName: "reviewgate init",
      quick: true,
      host: "codex",
      skipDoctor: true,
    }),
  ).rejects.toThrow(/last-known-good policy state is missing/i);
  expect(readFileSync(configPath, "utf8")).toBe(sentinel);
});
