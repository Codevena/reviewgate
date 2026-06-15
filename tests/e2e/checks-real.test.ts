// tests/e2e/checks-real.test.ts
//
// Real-shell integration test for runChecks. No external services (no LLM CLI,
// no network) — runs unconditionally (no REVIEWGATE_E2E gate).
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChecks } from "../../src/core/checks/runner.ts";

describe("runChecks (real shell)", () => {
  it("passes a real green command and fails a real red one", async () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-checks-e2e-"));
    writeFileSync(join(repo, "ok.txt"), "1");
    const green = await runChecks({ repoRoot: repo, commands: [{ name: "ls", run: "ls ok.txt" }] });
    expect(green.ok).toBe(true);
    const red = await runChecks({ repoRoot: repo, commands: [{ name: "ls", run: "ls nope.txt" }] });
    expect(red.ok).toBe(false);
  });
});
