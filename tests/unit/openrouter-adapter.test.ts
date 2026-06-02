// tests/unit/openrouter-adapter.test.ts
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenRouterAdapter } from "../../src/providers/openrouter.ts";

// These tests mutate the GLOBAL process.env.OPENROUTER_API_KEY. Restore it after
// the file so the leak can't flip an OPENROUTER_API_KEY-dependent assertion in a
// later test file (bun runs all test files in one process) — an order-dependent flake.
const ORIG_OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
afterAll(() => {
  if (ORIG_OPENROUTER_API_KEY === undefined)
    Reflect.deleteProperty(process.env, "OPENROUTER_API_KEY");
  else process.env.OPENROUTER_API_KEY = ORIG_OPENROUTER_API_KEY;
});

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

describe("OpenRouterAdapter.complete (raw judge completion)", () => {
  it("does a free-form chat call WITHOUT the review json_schema, returns the content", async () => {
    process.env.OR_JUDGE_KEY = "k";
    let capturedBody: { response_format?: unknown; messages?: { content: string }[] } = {};
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      capturedBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '{"contradicts":true,"reason":"conflicts B-1"}' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const adapter = new OpenRouterAdapter({ fetchImpl });
    const text = await adapter.complete("judge this", { model: "m", apiKeyEnv: "OR_JUDGE_KEY" });
    expect(text).toBe('{"contradicts":true,"reason":"conflicts B-1"}');
    // THE point: a judge must NOT be forced into the review output schema.
    expect(capturedBody.response_format).toBeUndefined();
    expect(capturedBody.messages?.[0]?.content).toBe("judge this");
  });

  it("throws on a missing API key (caller falls back to its default verdict)", async () => {
    const adapter = new OpenRouterAdapter({ fetchImpl: fakeFetch() });
    await expect(
      adapter.complete("x", { model: "m", apiKeyEnv: "OR_NEVER_SET_KEY_XYZ" }),
    ).rejects.toThrow();
  });

  it("defaults a missing apiKeyEnv to OPENROUTER_API_KEY (fallback relocated from call-site)", async () => {
    process.env.OPENROUTER_API_KEY = "default-key";
    let authHeader = "";
    const fetchImpl = (async (
      _url: string,
      init: { headers: Record<string, string>; body: string },
    ) => {
      authHeader = init.headers.Authorization ?? "";
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"accept":true}' } }], usage: {} }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const adapter = new OpenRouterAdapter({ fetchImpl });
    // apiKeyEnv intentionally OMITTED — must fall back to OPENROUTER_API_KEY.
    const text = await adapter.complete("judge this", { model: "m" });
    expect(text).toBe('{"accept":true}');
    expect(authHeader).toBe("Bearer default-key");
    Reflect.deleteProperty(process.env, "OPENROUTER_API_KEY");
  });
});

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

  it("computes usage.costUsd from cfg.costPerMTokensUsd via the typed ProviderConfig field (F-070)", async () => {
    // Guards against the dead inline-cast on input.cfg.costPerMTokensUsd: the
    // field is read directly off the typed ProviderConfig, so a rename in the
    // schema breaks compilation rather than silently zeroing cost (cost-cap
    // escalation would never fire). 150 + 25 = 175 tokens @ 2 USD/Mtok.
    const dir = mkdtempSync(join(tmpdir(), "rg-or-cost-"));
    writeFileSync(join(dir, "prompt.txt"), "review this");
    process.env.OPENROUTER_API_KEY = "test-key";
    const adapter = new OpenRouterAdapter({ fetchImpl: fakeFetch() });
    const res = await adapter.review({
      cfg: {
        enabled: true,
        auth: "openrouter",
        apiKeyEnv: "OPENROUTER_API_KEY",
        model: "x/y",
        timeoutMs: 60_000,
        costPerMTokensUsd: 2,
      },
      reviewerId: "openrouter-security",
      promptFile: join(dir, "prompt.txt"),
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "security",
      diffPath: join(dir, "d.patch"),
    });
    expect(res.status).toBe("ok");
    expect(res.usage.costUsd).toBeCloseTo((175 / 1_000_000) * 2, 9);
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

  const reviewWith = async (status: number, bodyText: string) => {
    const dir = mkdtempSync(join(tmpdir(), "rg-or-q-"));
    writeFileSync(join(dir, "prompt.txt"), "review this");
    process.env.OPENROUTER_API_KEY = "test-key";
    const fetchImpl = (async () => new Response(bodyText, { status })) as unknown as typeof fetch;
    const adapter = new OpenRouterAdapter({ fetchImpl });
    return adapter.review({
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
  };

  it("classifies a 429 as quota-exhausted (so the orchestrator cools it down + fails over)", async () => {
    const res = await reviewWith(429, "rate limit exceeded");
    expect(res.status).toBe("quota-exhausted");
  });

  it("keeps a non-quota HTTP error as a plain error", async () => {
    const res = await reviewWith(500, "internal server error");
    expect(res.status).toBe("error");
  });

  it("fails closed on a 200 with empty content (no silent zero-finding PASS)", async () => {
    // A content-filtered / refusal / empty response parses to null. Every other
    // adapter (codex/claude/gemini/opencode) guards `!out` and returns an error
    // run so it is EXCLUDED from okRuns. OpenRouter must do the same — otherwise
    // it enters okRuns as a 0-finding PASS and contributes a false PASS.
    const res = await reviewWith(200, JSON.stringify({ choices: [{ message: { content: "" } }] }));
    expect(res.status).not.toBe("ok");
    expect(res.verdict).not.toBe("PASS");
  });

  it("maps quota/usage-limit content in a 200 body to quota-exhausted", async () => {
    const res = await reviewWith(
      200,
      JSON.stringify({
        choices: [{ message: { content: "You have reached your usage limit. Try again later." } }],
      }),
    );
    expect(res.status).toBe("quota-exhausted");
  });
});

describe("OpenRouterAdapter.review (gate self-deadline abort)", () => {
  it("aborts the in-flight request when the external deadline signal fires", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-or-abort-"));
    writeFileSync(join(dir, "prompt.txt"), "review this");
    process.env.OPENROUTER_API_KEY = "test-key";
    // A request that only settles when ITS signal aborts (models a hung call).
    const fetchImpl = ((_url: string, init: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;
    const adapter = new OpenRouterAdapter({ fetchImpl });
    const ext = new AbortController();
    setTimeout(() => ext.abort(), 50);
    const start = Date.now();
    const res = await adapter.review({
      cfg: {
        enabled: true,
        auth: "openrouter",
        apiKeyEnv: "OPENROUTER_API_KEY",
        model: "x/y",
        timeoutMs: 30_000,
      },
      reviewerId: "openrouter-security",
      promptFile: join(dir, "prompt.txt"),
      workingDir: dir,
      findingsPath: join(dir, "f.md"),
      persona: "security",
      diffPath: join(dir, "d.patch"),
      signal: ext.signal,
    });
    // Returned via the external abort, NOT the 30s per-request timeout.
    expect(Date.now() - start).toBeLessThan(3_000);
    expect(res.verdict).toBe("ERROR");
  });
});
