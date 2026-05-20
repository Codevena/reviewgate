// tests/unit/codex-adapter.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../../src/providers/codex.ts";

const PRETEND_CODEX_BIN = join(process.cwd(), "tests/fixtures/fake-codex.sh");

describe("CodexAdapter (mocked binary)", () => {
  it("parses findings and usage from a fake codex run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-codex-"));
    const promptFile = join(dir, "prompt.txt");
    const findingsPath = join(dir, "findings.md");
    const diffPath = join(dir, "diff.patch");
    writeFileSync(promptFile, "review this");
    writeFileSync(diffPath, "diff --git a/x b/x");

    const adapter = new CodexAdapter({ binPath: PRETEND_CODEX_BIN });
    const result = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "gpt-5.4", timeoutMs: 60_000 },
      reviewerId: "codex-security",
      promptFile,
      workingDir: dir,
      findingsPath,
      persona: "security",
      diffPath,
    });
    expect(result.status).toBe("ok");
    expect(result.findings.length).toBeGreaterThanOrEqual(1);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  });
});
