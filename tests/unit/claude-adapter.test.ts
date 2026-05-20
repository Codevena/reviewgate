// tests/unit/claude-adapter.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../../src/providers/claude.ts";

const FAKE = join(process.cwd(), "tests/fixtures/fake-claude.sh");

describe("ClaudeAdapter (mocked)", () => {
  it("parses findings + usage from the result envelope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-cl-"));
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "review this");
    const adapter = new ClaudeAdapter({ binPath: FAKE });
    const res = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "claude-sonnet-4-6", timeoutMs: 60_000 },
      reviewerId: "claude-adversarial",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "adversarial",
      diffPath: join(dir, "d.patch"),
    });
    expect(res.status).toBe("ok");
    expect(res.findings.length).toBe(1);
    expect(res.findings[0]?.reviewer.provider).toBe("claude-code");
    expect(res.usage.inputTokens).toBe(300);
    expect(res.usage.outputTokens).toBe(40);
  });
});
