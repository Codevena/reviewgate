// tests/unit/orchestrator.test.ts
import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/config/defaults.ts";
import { Orchestrator } from "../../src/core/orchestrator.ts";
import { CodexAdapter } from "../../src/providers/codex.ts";

const FAKE_CODEX = join(process.cwd(), "tests/fixtures/fake-codex.sh");
const FAKE_CODEX_ERROR = join(process.cwd(), "tests/fixtures/fake-codex-error.sh");

function fakeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-orch-"));
  writeFileSync(join(dir, "foo.ts"), "function compare(a, b) { return a === b; }");
  return dir;
}

describe("Orchestrator", () => {
  it("runs one iteration end-to-end against a fake codex and writes pending.md", async () => {
    const repo = fakeRepo();
    const orch = new Orchestrator({
      repoRoot: repo,
      config: defaultConfig,
      providers: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
      sandboxMode: "off",
      hostTier: "opus",
      diff: "--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,1 @@\n-function compare(a, b) { return a == b; }\n+function compare(a, b) { return a === b; }\n",
      reasonOnFailEnabled: true,
    });
    const result = await orch.runIteration({ runId: "01HXQTEST", iter: 1 });
    expect(result.verdict).toMatch(/PASS|SOFT-PASS|FAIL/);
    expect(existsSync(join(repo, ".reviewgate", "pending.md"))).toBe(true);
    expect(existsSync(join(repo, ".reviewgate", "pending.json"))).toBe(true);
  });

  it("fails CLOSED (ERROR, never PASS) when the reviewer subprocess errors", async () => {
    const repo = fakeRepo();
    const orch = new Orchestrator({
      repoRoot: repo,
      config: defaultConfig,
      providers: { codex: new CodexAdapter({ binPath: FAKE_CODEX_ERROR }) },
      sandboxMode: "off",
      hostTier: "opus",
      diff: "--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n",
      reasonOnFailEnabled: true,
    });
    const result = await orch.runIteration({ runId: "01HXQERR", iter: 1 });
    // A failed reviewer must NOT be reported as PASS — that would silently
    // green-light the turn. It must surface as ERROR and write a FAIL report.
    expect(result.verdict).toBe("ERROR");
    const report = JSON.parse(readFileSync(join(repo, ".reviewgate", "pending.json"), "utf8")) as {
      verdict: string;
      reviewers: Array<{ status: string }>;
    };
    expect(report.verdict).toBe("FAIL");
    expect(report.reviewers[0]?.status).toBe("error");
  });

  it("fails CLOSED when a sandbox mode is requested but unavailable in M1", async () => {
    const repo = fakeRepo();
    const orch = new Orchestrator({
      repoRoot: repo,
      config: defaultConfig,
      providers: { codex: new CodexAdapter({ binPath: FAKE_CODEX }) },
      sandboxMode: "strict",
      hostTier: "opus",
      diff: "--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-a\n+b\n",
      reasonOnFailEnabled: true,
    });
    const result = await orch.runIteration({ runId: "01HXQSB", iter: 1 });
    // strict/permissive cannot be honored in M1, so the orchestrator must
    // refuse to review rather than silently run the reviewer unisolated.
    expect(result.verdict).toBe("ERROR");
  });
});
