// tests/unit/openrouter-adapter.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenRouterAdapter } from "../../src/providers/openrouter.ts";

function fakeFetch(): typeof fetch {
  return (async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content:
                '{"verdict":"FAIL","findings":[{"severity":"WARN","category":"quality","rule_id":"or-rule","file":"x.ts","line":1,"message":"or finding","details":"d","confidence":0.7}]}',
            },
          },
        ],
        usage: { prompt_tokens: 150, completion_tokens: 25 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch;
}

describe("OpenRouterAdapter (mocked fetch)", () => {
  it("sends model + schema and maps the response", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-or-"));
    const promptFile = join(dir, "prompt.txt");
    writeFileSync(promptFile, "review this");
    process.env.OPENROUTER_API_KEY = "test-key";
    const adapter = new OpenRouterAdapter({ fetchImpl: fakeFetch() });
    const res = await adapter.review({
      cfg: {
        enabled: true,
        auth: "openrouter",
        apiKeyEnv: "OPENROUTER_API_KEY",
        model: "google/gemini-3.5-flash",
        timeoutMs: 60_000,
      },
      reviewerId: "openrouter-security",
      promptFile,
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "security",
      diffPath: join(dir, "d.patch"),
    });
    expect(res.status).toBe("ok");
    expect(res.findings.length).toBe(1);
    expect(res.findings[0]?.reviewer.model).toBe("google/gemini-3.5-flash");
    expect(res.usage.inputTokens).toBe(150);
    expect(res.usage.outputTokens).toBe(25);
  });

  it("returns ERROR when the API key env is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-or2-"));
    writeFileSync(join(dir, "prompt.txt"), "x");
    process.env.OPENROUTER_API_KEY = "";
    const adapter = new OpenRouterAdapter({ fetchImpl: fakeFetch() });
    const res = await adapter.review({
      cfg: {
        enabled: true,
        auth: "openrouter",
        apiKeyEnv: "OPENROUTER_API_KEY",
        model: "x/y",
        timeoutMs: 1000,
      },
      reviewerId: "openrouter-security",
      promptFile: join(dir, "prompt.txt"),
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "security",
      diffPath: join(dir, "d.patch"),
    });
    expect(res.status).toBe("error");
    expect(res.verdict).toBe("ERROR");
  });
});
