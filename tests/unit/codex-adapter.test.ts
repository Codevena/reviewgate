// tests/unit/codex-adapter.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAdapter } from "../../src/providers/codex.ts";

const PRETEND_CODEX_BIN = join(process.cwd(), "tests/fixtures/fake-codex.sh");
const FAKE_CODEX_COMPLETE = join(process.cwd(), "tests/fixtures/fake-codex-complete.sh");

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

describe("CodexAdapter.complete (judge completion)", () => {
  it("returns the last-message text and passes NO --output-schema", async () => {
    // If complete() wrongly passed --output-schema, the fake exits 3 -> throw.
    const adapter = new CodexAdapter({ binPath: FAKE_CODEX_COMPLETE });
    const text = await adapter.complete("judge this", { model: "gpt-x", auth: "oauth" });
    expect(text).toContain('"contradicts":false');
  });

  it("remaps apiKeyEnv -> OPENAI_API_KEY only under auth=apikey", async () => {
    const prev = process.env.OPENAI_API_KEY;
    Reflect.deleteProperty(process.env, "OPENAI_API_KEY");
    process.env.RG_TEST_CDX_KEY = "sentinel-cdx";
    const adapter = new CodexAdapter({ binPath: FAKE_CODEX_COMPLETE });
    const apikey = await adapter.complete("p", {
      model: "m",
      apiKeyEnv: "RG_TEST_CDX_KEY",
      auth: "apikey",
    });
    expect(apikey).toContain("k=sentinel-cdx");
    const oauth = await adapter.complete("p", {
      model: "m",
      apiKeyEnv: "RG_TEST_CDX_KEY",
      auth: "oauth",
    });
    expect(oauth).toContain("k=NONE");
    Reflect.deleteProperty(process.env, "RG_TEST_CDX_KEY");
    if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
  });

  it("throws on non-zero exit", async () => {
    process.env.RG_FAKE_FAIL = "1";
    const adapter = new CodexAdapter({ binPath: FAKE_CODEX_COMPLETE });
    await expect(adapter.complete("p", { model: "m", auth: "oauth" })).rejects.toThrow();
    Reflect.deleteProperty(process.env, "RG_FAKE_FAIL");
  });

  it("returns '' on an empty last-message file (no throw)", async () => {
    process.env.RG_FAKE_EMPTY = "1";
    const adapter = new CodexAdapter({ binPath: FAKE_CODEX_COMPLETE });
    const text = await adapter.complete("p", { model: "m", auth: "oauth" });
    expect(text).toBe("");
    Reflect.deleteProperty(process.env, "RG_FAKE_EMPTY");
  });
});
