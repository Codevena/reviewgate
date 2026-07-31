// tests/unit/config-approve-cli.test.ts — `reviewgate config approve`'s exit
// code is a security signal: 0 must mean "a policy baseline was written", since
// that is what any wrapping script reads as "the human approved the policy".
// Both refusal paths below used to exit 0 while writing nothing.
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runConfigApprove } from "../../src/cli/commands/config.ts";
import { controlPlaneStatus } from "../../src/config/control-plane.ts";
import { controlPlaneStatePath } from "../../src/utils/paths.ts";

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// Hermetic: empty env + an isolated home, so the machine's global reviewgate
// config can never leak into the effective policy under test.
function envFor(home: string) {
  return { env: {} as Record<string, string | undefined>, home };
}

function freshRepo(prefix: string): { repo: string; env: ReturnType<typeof envFor> } {
  const repo = temp(prefix);
  writeFileSync(
    join(repo, "reviewgate.config.ts"),
    "export default { loop: { maxIterations: 3 } };\n",
  );
  return { repo, env: envFor(temp(`${prefix}home-`)) };
}

describe("runConfigApprove exit codes", () => {
  it("exit 1 when the prompt closed without an answer — EOF must never read as approved", async () => {
    const { repo, env } = freshRepo("rg-cfg-approve-eof-");

    const result = await runConfigApprove(repo, null, env);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toLowerCase()).toContain("aborted");
    expect(existsSync(controlPlaneStatePath(repo))).toBe(false);
  });

  it("exit 1 on a wrong confirmation — the refusal must not escape as an uncaught throw", async () => {
    const { repo, env } = freshRepo("rg-cfg-approve-wrong-");

    const result = await runConfigApprove(repo, "APPROVE totallywrong", env);

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toLowerCase()).toContain("did not match");
    expect(existsSync(controlPlaneStatePath(repo))).toBe(false);
  });

  it("exit 0 only when the baseline is actually written", async () => {
    const { repo, env } = freshRepo("rg-cfg-approve-ok-");
    const status = await controlPlaneStatus(repo, env);
    expect(status.challenge).toBeTruthy();

    const result = await runConfigApprove(repo, status.challenge ?? "", env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Gate policy approved");
    expect(existsSync(controlPlaneStatePath(repo))).toBe(true);
  });
});
