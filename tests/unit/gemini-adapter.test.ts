// tests/unit/gemini-adapter.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GeminiAdapter } from "../../src/providers/gemini.ts";

const FAKE = join(process.cwd(), "tests/fixtures/fake-gemini.sh");
const FAKE_COMPLETE = join(process.cwd(), "tests/fixtures/fake-gemini-complete.sh");

describe("GeminiAdapter (mocked)", () => {
  it("parses findings + usage from the response envelope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-gem-"));
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "review this");
    const adapter = new GeminiAdapter({ binPath: FAKE });
    const res = await adapter.review({
      cfg: { enabled: true, auth: "oauth", model: "gemini-3-pro", timeoutMs: 60_000 },
      reviewerId: "gemini-architecture",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "architecture",
      diffPath: join(dir, "d.patch"),
    });
    expect(res.status).toBe("ok");
    expect(res.findings.length).toBe(1);
    expect(res.findings[0]?.reviewer.provider).toBe("gemini");
    expect(res.usage.inputTokens).toBe(200);
    expect(res.usage.outputTokens).toBe(30);
  });
});

describe("GeminiAdapter.complete (judge completion)", () => {
  it("returns the raw model text containing the judge JSON", async () => {
    const adapter = new GeminiAdapter({ binPath: FAKE_COMPLETE });
    const text = await adapter.complete("judge this", { model: "gemini-3-pro", auth: "oauth" });
    expect(text).toContain('"contradicts":false');
  });

  it("remaps apiKeyEnv -> GEMINI_API_KEY only under auth=apikey", async () => {
    const prev = process.env.GEMINI_API_KEY;
    Reflect.deleteProperty(process.env, "GEMINI_API_KEY");
    process.env.RG_TEST_GEM_KEY = "sentinel-gem";
    const adapter = new GeminiAdapter({ binPath: FAKE_COMPLETE });
    const apikey = await adapter.complete("p", {
      model: "m",
      apiKeyEnv: "RG_TEST_GEM_KEY",
      auth: "apikey",
    });
    expect(apikey).toContain("k=sentinel-gem");
    const oauth = await adapter.complete("p", {
      model: "m",
      apiKeyEnv: "RG_TEST_GEM_KEY",
      auth: "oauth",
    });
    expect(oauth).toContain("k=NONE");
    Reflect.deleteProperty(process.env, "RG_TEST_GEM_KEY");
    if (prev !== undefined) process.env.GEMINI_API_KEY = prev;
  });

  it("throws on non-zero exit", async () => {
    process.env.RG_FAKE_FAIL = "1";
    const adapter = new GeminiAdapter({ binPath: FAKE_COMPLETE });
    await expect(adapter.complete("p", { model: "m", auth: "oauth" })).rejects.toThrow();
    Reflect.deleteProperty(process.env, "RG_FAKE_FAIL");
  });

  it("returns '' on a response-less envelope (no throw)", async () => {
    process.env.RG_FAKE_EMPTY = "1";
    const adapter = new GeminiAdapter({ binPath: FAKE_COMPLETE });
    const text = await adapter.complete("p", { model: "m", auth: "oauth" });
    expect(text).toBe("");
    Reflect.deleteProperty(process.env, "RG_FAKE_EMPTY");
  });
});
