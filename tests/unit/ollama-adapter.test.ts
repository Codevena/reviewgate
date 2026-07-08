// tests/unit/ollama-adapter.test.ts
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OllamaAdapter,
  isLoopbackUrl,
  lastBalancedJsonObject,
  stripReasoningBlocks,
} from "../../src/providers/ollama.ts";

const ORIG_KEY = process.env.OLLAMA_API_KEY;
afterAll(() => {
  if (ORIG_KEY === undefined) Reflect.deleteProperty(process.env, "OLLAMA_API_KEY");
  else process.env.OLLAMA_API_KEY = ORIG_KEY;
});

const FINDING_JSON =
  '{"verdict":"FAIL","findings":[{"severity":"WARN","category":"quality","rule_id":"o-rule","file":"x.ts","line":1,"message":"ollama finding","details":"d","confidence":0.7}]}';

function okFetch(
  content: string,
  usage = { prompt_tokens: 150, completion_tokens: 25 },
): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function baseCfg(over: Record<string, unknown> = {}) {
  return {
    enabled: true,
    auth: "apikey",
    apiKeyEnv: "OLLAMA_API_KEY",
    model: "glm-5.2:cloud",
    timeoutMs: 60_000,
    ...over,
  } as never;
}
function reviewArgs(dir: string) {
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "review this");
  return {
    reviewerId: "ollama-security",
    promptFile,
    workingDir: dir,
    findingsPath: join(dir, "f.md"),
    persona: "security",
    diffPath: join(dir, "d.patch"),
  };
}

describe("stripReasoningBlocks", () => {
  it("removes paired <think> and <thinking> blocks", () => {
    expect(stripReasoningBlocks(`<think>reasoning {a:1}</think>\n${FINDING_JSON}`)).toBe(
      FINDING_JSON,
    );
    expect(stripReasoningBlocks(`<thinking>x</thinking>${FINDING_JSON}`)).toBe(FINDING_JSON);
  });
  it("strips an UNCLOSED <think> opener up to the JSON (truncated reasoning)", () => {
    expect(stripReasoningBlocks(`<think>let me review this diff carefully\n${FINDING_JSON}`)).toBe(
      FINDING_JSON,
    );
  });
});

describe("isLoopbackUrl", () => {
  it("detects localhost / 127.0.0.0/8 / ::1, rejects remote, 127-prefixed & out-of-range hosts", () => {
    expect(isLoopbackUrl("http://localhost:11434/v1")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLoopbackUrl("http://127.0.1.1:11434/v1")).toBe(true);
    expect(isLoopbackUrl("https://ollama.com/v1")).toBe(false);
    expect(isLoopbackUrl("http://127.evil/v1")).toBe(false); // NOT a numeric 127.0.0.0/8 addr
    expect(isLoopbackUrl("http://127.999.999.999/v1")).toBe(false); // octets out of 0-255 range
  });
});

describe("lastBalancedJsonObject", () => {
  it("returns the LAST top-level object, ignoring braces inside strings", () => {
    expect(lastBalancedJsonObject('reasoning {a: 1} then {"b":"}"}')).toBe('{"b":"}"}');
  });
  it("returns null when there is no balanced object", () => {
    expect(lastBalancedJsonObject("no json here {unclosed")).toBe(null);
  });
});

describe("OllamaAdapter.review (mocked fetch)", () => {
  it("maps a normal cloud response and sends Bearer + schema to /v1/chat/completions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-"));
    process.env.OLLAMA_API_KEY = "test-key";
    let url = "";
    let hdr: Record<string, string> = {};
    let sentBody: Record<string, unknown> = {};
    const fetchImpl = (async (
      u: string,
      init: { headers: Record<string, string>; body: string },
    ) => {
      url = u;
      hdr = init.headers;
      sentBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: FINDING_JSON } }],
          usage: { prompt_tokens: 150, completion_tokens: 25 },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const res = await new OllamaAdapter({ fetchImpl }).review({
      cfg: baseCfg(),
      ...reviewArgs(dir),
    });
    expect(res.status).toBe("ok");
    expect(res.findings.length).toBe(1);
    expect(res.findings[0]?.reviewer.model).toBe("glm-5.2:cloud");
    expect(res.usage.inputTokens).toBe(150);
    expect(url).toBe("https://ollama.com/v1/chat/completions");
    expect(hdr.Authorization).toBe("Bearer test-key");
    expect((sentBody.response_format as { type: string }).type).toBe("json_schema");
  });

  it("strips <think> before parsing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-think-"));
    process.env.OLLAMA_API_KEY = "k";
    const res = await new OllamaAdapter({
      fetchImpl: okFetch(`<think>let me look…</think>\n${FINDING_JSON}`),
    }).review({ cfg: baseCfg(), ...reviewArgs(dir) });
    expect(res.status).toBe("ok");
    expect(res.findings.length).toBe(1);
  });

  it("recovers the review JSON when an UNCLOSED <think> preamble contains braces", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-braces-"));
    process.env.OLLAMA_API_KEY = "k";
    // unclosed <think> + a brace in the reasoning → lastBalancedJsonObject fallback recovers the answer.
    const res = await new OllamaAdapter({
      fetchImpl: okFetch(`<think>the value {a: 1} looks off and\n${FINDING_JSON}`),
    }).review({ cfg: baseCfg(), ...reviewArgs(dir) });
    expect(res.status).toBe("ok");
    expect(res.findings.length).toBe(1);
  });

  it("returns ERROR when key missing + remote baseUrl", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-nokey-"));
    process.env.OLLAMA_API_KEY = "";
    const res = await new OllamaAdapter({ fetchImpl: okFetch(FINDING_JSON) }).review({
      cfg: baseCfg(),
      ...reviewArgs(dir),
    });
    expect(res.status).toBe("error");
    expect(res.verdict).toBe("ERROR");
  });

  it("proceeds WITHOUT auth header when key missing + localhost baseUrl", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-local-"));
    process.env.OLLAMA_API_KEY = "";
    let hdr: Record<string, string> = {};
    const fetchImpl = (async (_u: string, init: { headers: Record<string, string> }) => {
      hdr = init.headers;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: FINDING_JSON } }], usage: {} }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const res = await new OllamaAdapter({ fetchImpl }).review({
      cfg: baseCfg({ baseUrl: "http://localhost:11434/v1" }),
      ...reviewArgs(dir),
    });
    expect(res.status).toBe("ok");
    expect(hdr.Authorization).toBeUndefined();
  });

  it("normalizes a trailing slash in baseUrl", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-slash-"));
    process.env.OLLAMA_API_KEY = "k";
    let url = "";
    const fetchImpl = (async (u: string) => {
      url = u;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: FINDING_JSON } }], usage: {} }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    await new OllamaAdapter({ fetchImpl }).review({
      cfg: baseCfg({ baseUrl: "https://ollama.com/v1/" }),
      ...reviewArgs(dir),
    });
    expect(url).toBe("https://ollama.com/v1/chat/completions");
  });

  it("classifies a 429 as quota-exhausted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-429-"));
    process.env.OLLAMA_API_KEY = "k";
    const fetchImpl = (async () =>
      new Response("rate limit exceeded", { status: 429 })) as unknown as typeof fetch;
    const res = await new OllamaAdapter({ fetchImpl }).review({
      cfg: baseCfg(),
      ...reviewArgs(dir),
    });
    expect(res.status).toBe("quota-exhausted");
  });

  it("keeps a non-quota 500 as a plain error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-500-"));
    process.env.OLLAMA_API_KEY = "k";
    const fetchImpl = (async () =>
      new Response("internal", { status: 500 })) as unknown as typeof fetch;
    const res = await new OllamaAdapter({ fetchImpl }).review({
      cfg: baseCfg(),
      ...reviewArgs(dir),
    });
    expect(res.status).toBe("error");
  });

  it("fails closed on a 200 with empty content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-empty-"));
    process.env.OLLAMA_API_KEY = "k";
    const res = await new OllamaAdapter({ fetchImpl: okFetch("") }).review({
      cfg: baseCfg(),
      ...reviewArgs(dir),
    });
    expect(res.status).not.toBe("ok");
    expect(res.verdict).not.toBe("PASS");
  });

  it("fails closed when the response has no choices array", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-noch-"));
    process.env.OLLAMA_API_KEY = "k";
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ usage: {} }), { status: 200 })) as unknown as typeof fetch;
    const res = await new OllamaAdapter({ fetchImpl }).review({
      cfg: baseCfg(),
      ...reviewArgs(dir),
    });
    expect(res.status).not.toBe("ok");
    expect(res.verdict).not.toBe("PASS");
  });

  it("maps quota/usage-limit content in a 200 to quota-exhausted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-qc-"));
    process.env.OLLAMA_API_KEY = "k";
    const res = await new OllamaAdapter({
      fetchImpl: okFetch("You have reached your usage limit. Try again later."),
    }).review({ cfg: baseCfg(), ...reviewArgs(dir) });
    expect(res.status).toBe("quota-exhausted");
  });

  it("computes cost from costPerMTokensUsd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-cost-"));
    process.env.OLLAMA_API_KEY = "k";
    const res = await new OllamaAdapter({ fetchImpl: okFetch(FINDING_JSON) }).review({
      cfg: baseCfg({ costPerMTokensUsd: 2 }),
      ...reviewArgs(dir),
    });
    expect(res.usage.costUsd).toBeCloseTo((175 / 1_000_000) * 2, 9);
  });

  it("aborts the in-flight request on the external deadline signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-abort-"));
    process.env.OLLAMA_API_KEY = "k";
    const fetchImpl = ((_u: string, init: { signal?: AbortSignal }) =>
      new Promise<Response>((_res, rej) =>
        init.signal?.addEventListener("abort", () =>
          rej(new DOMException("aborted", "AbortError")),
        ),
      )) as unknown as typeof fetch;
    const ext = new AbortController();
    setTimeout(() => ext.abort(), 50);
    const start = Date.now();
    const res = await new OllamaAdapter({ fetchImpl }).review({
      cfg: baseCfg({ timeoutMs: 30_000 }),
      ...reviewArgs(dir),
      signal: ext.signal,
    });
    expect(Date.now() - start).toBeLessThan(3_000);
    expect(res.verdict).toBe("ERROR");
  });
});

describe("OllamaAdapter.complete", () => {
  it("does a free-form call WITHOUT response_format and returns content", async () => {
    process.env.OLLAMA_API_KEY = "k";
    let sentBody: { response_format?: unknown } = {};
    const fetchImpl = (async (_u: string, init: { body: string }) => {
      sentBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"accept":true}' } }], usage: {} }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const text = await new OllamaAdapter({ fetchImpl }).complete("judge this", {
      model: "glm-5.2:cloud",
    });
    expect(text).toBe('{"accept":true}');
    expect(sentBody.response_format).toBeUndefined();
  });

  it("throws on missing key + remote baseUrl", async () => {
    process.env.OLLAMA_API_KEY = "";
    await expect(
      new OllamaAdapter({ fetchImpl: okFetch("x") }).complete("x", { model: "m" }),
    ).rejects.toThrow();
  });

  it("strips <think> from complete() output (thinking-model judge safety)", async () => {
    process.env.OLLAMA_API_KEY = "k";
    const text = await new OllamaAdapter({
      fetchImpl: okFetch('<think>hmm</think>{"accept":true}'),
    }).complete("j", { model: "m" });
    expect(text).toBe('{"accept":true}');
  });

  it("proceeds without a key on a loopback baseUrl", async () => {
    process.env.OLLAMA_API_KEY = "";
    let hdr: Record<string, string> = {};
    const fetchImpl = (async (_u: string, init: { headers: Record<string, string> }) => {
      hdr = init.headers;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const text = await new OllamaAdapter({ fetchImpl }).complete("j", {
      model: "m",
      baseUrl: "http://localhost:11434/v1",
    });
    expect(text).toBe("ok");
    expect(hdr.Authorization).toBeUndefined();
  });
});
