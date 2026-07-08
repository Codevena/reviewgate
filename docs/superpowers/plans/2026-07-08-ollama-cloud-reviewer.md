# Ollama Cloud Reviewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `ollama` HTTP reviewer adapter targeting Ollama Cloud's OpenAI-compatible `/v1` endpoint, so the panel can run models like `glm-5.2:cloud` as a reviewer / fallback / critic.

**Architecture:** A near-clone of the OpenRouter HTTP adapter (`src/providers/openrouter.ts`) — POSTs to `${baseUrl}/chat/completions` with `response_format: json_schema`, maps the response through the shared `parseReviewOutput` / `mapReviewOutputToFindings`, classifies 429 as `quota-exhausted`, and wires the gate self-deadline signal into an `AbortController`. A configurable `baseUrl` (default Ollama Cloud) lets the same adapter hit a self-hosted/local daemon. It slots into the panel as an ordinary reviewer; `buildAdapters` auto-builds it once it is a consumed provider.

**Tech Stack:** Bun, TypeScript, zod (config schemas), `bun test`. No new dependencies.

## Global Constraints

- Runtime is **Bun**; use `bun`/`bunx`, `bun test` (never npm/node/jest). Copied verbatim from repo conventions.
- `bunx tsc --noEmit` AND `bun run lint` (biome) must be clean before any task is "done".
- Adapters MUST **fail closed**: a refusal / empty / non-JSON / quota response never becomes a zero-finding PASS (mirror OpenRouter's `!out` guard).
- `REVIEW_OUTPUT_SCHEMA` must stay OpenAI/codex strict-mode valid; it is used verbatim as the `response_format` schema — do NOT alter it.
- Default model tag: `glm-5.2:cloud`. Default endpoint: `https://ollama.com/v1`. Default key env: `OLLAMA_API_KEY`. Cost default: `costPerMTokensUsd: 0` (flat subscription).
- Never `git add -A` in this repo (it tracks `.reviewgate/` state); stage exact paths only.
- Verify provider changes against a **real** API call, not just stubs (Task 6 gates "done").

---

### Task 0: Pre-flight live smoke test (de-risk the structured-output wager)

**Rationale:** The cloud-direct `/v1` + `response_format: json_schema` path with `glm-5.2:cloud` is unverified (the field-report reliability was localhost-native + prompt-instructed). Run ONE real call before building the adapter around it, so we learn early whether strict schema is honored and whether `<think>` tokens contaminate `content`. This is a throwaway script (scratchpad, NOT committed).

**Files:**
- Create (uncommitted, deleted after): `scripts/ollama-smoke.ts` (inside the repo so the real-schema import resolves)

- [ ] **Step 1: Write the smoke script**

```ts
// scripts/ollama-smoke.ts (uncommitted; run from repo root, then delete)
// run: OLLAMA_API_KEY=… bun run scripts/ollama-smoke.ts
// Use the REAL REVIEW_OUTPUT_SCHEMA, never a simplified one — a simplified schema
// can be accepted while the real (deeper/stricter) schema is rejected, giving a
// FALSE GREEN (Plan-Gate INFO, GLM).
import { REVIEW_OUTPUT_SCHEMA } from "../src/providers/review-output.ts";
const key = process.env.OLLAMA_API_KEY;
if (!key) throw new Error("set OLLAMA_API_KEY");
const schema = REVIEW_OUTPUT_SCHEMA;
const body = {
  model: "glm-5.2:cloud",
  messages: [{ role: "user", content: "Review this diff. Return ONLY the review JSON.\n\n+ const x = 1 == '1';" }],
  response_format: { type: "json_schema", json_schema: { name: "review", strict: true, schema } },
};
const resp = await fetch("https://ollama.com/v1/chat/completions", {
  method: "POST",
  headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
console.log("HTTP", resp.status);
const json = await resp.json();
const content = json.choices?.[0]?.message?.content ?? "";
console.log("CONTENT:\n", content);
console.log("HAS <think>:", /<think/i.test(content));
try { console.log("PARSES:", !!JSON.parse(content)); } catch { console.log("PARSES: NO (needs strip/slice)"); }
```

- [ ] **Step 2: Run it**

Run: `OLLAMA_API_KEY=… bun run <scratchpad>/ollama-smoke.ts`
Expected: `HTTP 200`, `CONTENT` is (or contains) review-shaped JSON. Record: does it parse directly? Are there `<think>` tokens? Does `strict` schema hold?

- [ ] **Step 3: Decide + record**

- If JSON is clean and schema-valid → proceed with `/v1` + `response_format` (the plan's default).
- If `<think>` appears → confirms the `stripReasoningBlocks` need in Task 1 (already planned).
- If `response_format` strict is rejected/ignored AND output is unusable → switch the adapter to the native `/api/chat` fallback. This is NOT a drop-in: the request body uses `format: <schema>` (not `response_format`) and `stream:false`, and the RESPONSE SHAPE differs — the answer is at **`json.message.content`**, not `json.choices[0].message.content`. So Task 1's `ChatResponse` interface, the `endpointFrom` path (`/api/chat`, no `/chat/completions`), the request body, and the content-extraction line all change together. **Note this outcome in the Task 1 commit message** and adjust the Task 1 tests' mock response shape to match.

Delete `scripts/ollama-smoke.ts` after (no commit). This task has no automated test — it is a manual de-risking probe.

---

### Task 1: The `OllamaAdapter` (fetch-mocked, TDD)

**Files:**
- Create: `src/providers/ollama.ts`
- Modify: `src/providers/adapter-base.ts` (add `"ollama"` to `ProviderAdapter.id`; add `baseUrl?: string` to `ProviderConfig` and `CompleteOptions`)
- Test: `tests/unit/ollama-adapter.test.ts`

**Interfaces:**
- Consumes: `ProviderAdapter`, `ProviderConfig`, `CompleteOptions`, `Preflight`, `ReviewInput`, `ReviewResult`, `verdictFromFindings` (from `adapter-base.ts`); `isQuotaExhausted` (`quota-signals.ts`); `REVIEW_OUTPUT_SCHEMA`, `parseReviewOutput`, `mapReviewOutputToFindings` (`review-output.ts`).
- Produces: `class OllamaAdapter implements ProviderAdapter` with `readonly id = "ollama"`, constructor `{ fetchImpl?: typeof fetch }`, methods `preflight`, `review`, `complete`. Exported helpers `stripReasoningBlocks(text: string): string`, `isLoopbackUrl(url: string): boolean`, `lastBalancedJsonObject(text: string): string | null`, `estimateCostUsd(inputTokens, outputTokens, pricePerMTokensUsd?): number`.

- [ ] **Step 1: Extend `adapter-base.ts` types**

In `src/providers/adapter-base.ts`:

`ProviderAdapter.id` union — add `"ollama"`:
```ts
readonly id: "codex" | "claude-code" | "gemini" | "openrouter" | "opencode" | "ollama";
```
`ProviderConfig` — add after `openrouterProvider`:
```ts
  /** Ollama-only: OpenAI-compat base URL (default https://ollama.com/v1). Other providers ignore it. */
  baseUrl?: string;
```
`CompleteOptions` — add:
```ts
  /** Ollama-only: OpenAI-compat base URL for the completion (critic/judge on a non-cloud daemon). */
  baseUrl?: string;
```

- [ ] **Step 2: Write the failing tests**

Create `tests/unit/ollama-adapter.test.ts`:

```ts
// tests/unit/ollama-adapter.test.ts
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OllamaAdapter, stripReasoningBlocks, isLoopbackUrl, lastBalancedJsonObject } from "../../src/providers/ollama.ts";

const ORIG_KEY = process.env.OLLAMA_API_KEY;
afterAll(() => {
  if (ORIG_KEY === undefined) Reflect.deleteProperty(process.env, "OLLAMA_API_KEY");
  else process.env.OLLAMA_API_KEY = ORIG_KEY;
});

const FINDING_JSON =
  '{"verdict":"FAIL","findings":[{"severity":"WARN","category":"quality","rule_id":"o-rule","file":"x.ts","line":1,"message":"ollama finding","details":"d","confidence":0.7}]}';

function okFetch(content: string, usage = { prompt_tokens: 150, completion_tokens: 25 }): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

function baseCfg(over: Record<string, unknown> = {}) {
  return { enabled: true, auth: "apikey", apiKeyEnv: "OLLAMA_API_KEY", model: "glm-5.2:cloud", timeoutMs: 60_000, ...over } as never;
}
function reviewArgs(dir: string) {
  const promptFile = join(dir, "prompt.txt");
  writeFileSync(promptFile, "review this");
  return { reviewerId: "ollama-security", promptFile, workingDir: dir, findingsPath: join(dir, "f.md"), persona: "security", diffPath: join(dir, "d.patch") };
}

describe("stripReasoningBlocks", () => {
  it("removes paired <think> and <thinking> blocks", () => {
    expect(stripReasoningBlocks("<think>reasoning {a:1}</think>\n" + FINDING_JSON)).toBe(FINDING_JSON);
    expect(stripReasoningBlocks("<thinking>x</thinking>" + FINDING_JSON)).toBe(FINDING_JSON);
  });
  it("strips an UNCLOSED <think> opener up to the JSON (truncated reasoning)", () => {
    expect(stripReasoningBlocks("<think>let me review this diff carefully\n" + FINDING_JSON)).toBe(FINDING_JSON);
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
    let url = ""; let hdr: Record<string, string> = {}; let sentBody: Record<string, unknown> = {};
    const fetchImpl = (async (u: string, init: { headers: Record<string, string>; body: string }) => {
      url = u; hdr = init.headers; sentBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: FINDING_JSON } }], usage: { prompt_tokens: 150, completion_tokens: 25 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await new OllamaAdapter({ fetchImpl }).review({ cfg: baseCfg(), ...reviewArgs(dir) });
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
    const res = await new OllamaAdapter({ fetchImpl: okFetch("<think>let me look…</think>\n" + FINDING_JSON) }).review({ cfg: baseCfg(), ...reviewArgs(dir) });
    expect(res.status).toBe("ok");
    expect(res.findings.length).toBe(1);
  });

  it("recovers the review JSON when an UNCLOSED <think> preamble contains braces", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-braces-"));
    process.env.OLLAMA_API_KEY = "k";
    // unclosed <think> + a brace in the reasoning → lastBalancedJsonObject fallback recovers the answer.
    const res = await new OllamaAdapter({ fetchImpl: okFetch("<think>the value {a: 1} looks off and\n" + FINDING_JSON) }).review({ cfg: baseCfg(), ...reviewArgs(dir) });
    expect(res.status).toBe("ok");
    expect(res.findings.length).toBe(1);
  });

  it("returns ERROR when key missing + remote baseUrl", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-nokey-"));
    process.env.OLLAMA_API_KEY = "";
    const res = await new OllamaAdapter({ fetchImpl: okFetch(FINDING_JSON) }).review({ cfg: baseCfg(), ...reviewArgs(dir) });
    expect(res.status).toBe("error");
    expect(res.verdict).toBe("ERROR");
  });

  it("proceeds WITHOUT auth header when key missing + localhost baseUrl", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-local-"));
    process.env.OLLAMA_API_KEY = "";
    let hdr: Record<string, string> = {};
    const fetchImpl = (async (_u: string, init: { headers: Record<string, string> }) => {
      hdr = init.headers;
      return new Response(JSON.stringify({ choices: [{ message: { content: FINDING_JSON } }], usage: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const res = await new OllamaAdapter({ fetchImpl }).review({ cfg: baseCfg({ baseUrl: "http://localhost:11434/v1" }), ...reviewArgs(dir) });
    expect(res.status).toBe("ok");
    expect(hdr.Authorization).toBeUndefined();
  });

  it("normalizes a trailing slash in baseUrl", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-slash-"));
    process.env.OLLAMA_API_KEY = "k";
    let url = "";
    const fetchImpl = (async (u: string) => { url = u; return new Response(JSON.stringify({ choices: [{ message: { content: FINDING_JSON } }], usage: {} }), { status: 200 }); }) as unknown as typeof fetch;
    await new OllamaAdapter({ fetchImpl }).review({ cfg: baseCfg({ baseUrl: "https://ollama.com/v1/" }), ...reviewArgs(dir) });
    expect(url).toBe("https://ollama.com/v1/chat/completions");
  });

  it("classifies a 429 as quota-exhausted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-429-"));
    process.env.OLLAMA_API_KEY = "k";
    const fetchImpl = (async () => new Response("rate limit exceeded", { status: 429 })) as unknown as typeof fetch;
    const res = await new OllamaAdapter({ fetchImpl }).review({ cfg: baseCfg(), ...reviewArgs(dir) });
    expect(res.status).toBe("quota-exhausted");
  });

  it("keeps a non-quota 500 as a plain error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-500-"));
    process.env.OLLAMA_API_KEY = "k";
    const fetchImpl = (async () => new Response("internal", { status: 500 })) as unknown as typeof fetch;
    const res = await new OllamaAdapter({ fetchImpl }).review({ cfg: baseCfg(), ...reviewArgs(dir) });
    expect(res.status).toBe("error");
  });

  it("fails closed on a 200 with empty content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-empty-"));
    process.env.OLLAMA_API_KEY = "k";
    const res = await new OllamaAdapter({ fetchImpl: okFetch("") }).review({ cfg: baseCfg(), ...reviewArgs(dir) });
    expect(res.status).not.toBe("ok");
    expect(res.verdict).not.toBe("PASS");
  });

  it("fails closed when the response has no choices array", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-noch-"));
    process.env.OLLAMA_API_KEY = "k";
    const fetchImpl = (async () => new Response(JSON.stringify({ usage: {} }), { status: 200 })) as unknown as typeof fetch;
    const res = await new OllamaAdapter({ fetchImpl }).review({ cfg: baseCfg(), ...reviewArgs(dir) });
    expect(res.status).not.toBe("ok");
    expect(res.verdict).not.toBe("PASS");
  });

  it("maps quota/usage-limit content in a 200 to quota-exhausted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-qc-"));
    process.env.OLLAMA_API_KEY = "k";
    const res = await new OllamaAdapter({ fetchImpl: okFetch("You have reached your usage limit. Try again later.") }).review({ cfg: baseCfg(), ...reviewArgs(dir) });
    expect(res.status).toBe("quota-exhausted");
  });

  it("computes cost from costPerMTokensUsd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-cost-"));
    process.env.OLLAMA_API_KEY = "k";
    const res = await new OllamaAdapter({ fetchImpl: okFetch(FINDING_JSON) }).review({ cfg: baseCfg({ costPerMTokensUsd: 2 }), ...reviewArgs(dir) });
    expect(res.usage.costUsd).toBeCloseTo((175 / 1_000_000) * 2, 9);
  });

  it("aborts the in-flight request on the external deadline signal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rg-ol-abort-"));
    process.env.OLLAMA_API_KEY = "k";
    const fetchImpl = ((_u: string, init: { signal?: AbortSignal }) =>
      new Promise<Response>((_res, rej) => init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    const ext = new AbortController();
    setTimeout(() => ext.abort(), 50);
    const start = Date.now();
    const res = await new OllamaAdapter({ fetchImpl }).review({ cfg: baseCfg({ timeoutMs: 30_000 }), ...reviewArgs(dir), signal: ext.signal });
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
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"accept":true}' } }], usage: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const text = await new OllamaAdapter({ fetchImpl }).complete("judge this", { model: "glm-5.2:cloud" });
    expect(text).toBe('{"accept":true}');
    expect(sentBody.response_format).toBeUndefined();
  });

  it("throws on missing key + remote baseUrl", async () => {
    process.env.OLLAMA_API_KEY = "";
    await expect(new OllamaAdapter({ fetchImpl: okFetch("x") }).complete("x", { model: "m" })).rejects.toThrow();
  });

  it("strips <think> from complete() output (thinking-model judge safety)", async () => {
    process.env.OLLAMA_API_KEY = "k";
    const text = await new OllamaAdapter({ fetchImpl: okFetch('<think>hmm</think>{"accept":true}') }).complete("j", { model: "m" });
    expect(text).toBe('{"accept":true}');
  });

  it("proceeds without a key on a loopback baseUrl", async () => {
    process.env.OLLAMA_API_KEY = "";
    let hdr: Record<string, string> = {};
    const fetchImpl = (async (_u: string, init: { headers: Record<string, string> }) => {
      hdr = init.headers;
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: {} }), { status: 200 });
    }) as unknown as typeof fetch;
    const text = await new OllamaAdapter({ fetchImpl }).complete("j", { model: "m", baseUrl: "http://localhost:11434/v1" });
    expect(text).toBe("ok");
    expect(hdr.Authorization).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `bun test tests/unit/ollama-adapter.test.ts`
Expected: FAIL — `Cannot find module '../../src/providers/ollama.ts'`.

- [ ] **Step 4: Implement `src/providers/ollama.ts`**

```ts
// src/providers/ollama.ts
import { readFileSync } from "node:fs";
import type { Finding } from "../schemas/finding.ts";
import type {
  CompleteOptions,
  Preflight,
  ProviderAdapter,
  ProviderConfig,
  ReviewInput,
  ReviewResult,
} from "./adapter-base.ts";
import { verdictFromFindings } from "./adapter-base.ts";
import { isQuotaExhausted } from "./quota-signals.ts";
import { REVIEW_OUTPUT_SCHEMA, mapReviewOutputToFindings, parseReviewOutput } from "./review-output.ts";

const DEFAULT_BASE_URL = "https://ollama.com/v1";
const DEFAULT_API_KEY_ENV = "OLLAMA_API_KEY";
const COMPLETE_TIMEOUT_MS = 30_000;

export interface OllamaAdapterOptions {
  fetchImpl?: typeof fetch;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

// Ollama serves reasoning models (e.g. glm-5.2:cloud) that may prepend a
// <think>…</think> block to the JSON. parseReviewOutput already strips markdown
// fences and slices { … }, but a think block can carry braces that derail the
// slice — so remove think/thinking blocks BEFORE parsing. Also handle an UNCLOSED
// opener (a thinking model that truncates at its output-token limit never emits
// </think>): drop it up to the first "{" so the JSON answer still survives
// (Plan-Gate CRITICAL/WARN, both reviewers).
export function stripReasoningBlocks(text: string): string {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "") // paired blocks
    .replace(/<think(?:ing)?>[\s\S]*?(?=\{)/i, "") // unclosed leading opener → up to first "{"
    .trim();
}

// A local daemon (loopback) needs no API key; a remote endpoint (Ollama Cloud) does.
// Accept the whole 127.0.0.0/8 range (e.g. 127.0.1.1) but validate a NUMERIC IPv4 with
// in-range octets — a prefix match ("127.evil") or an out-of-range one ("127.999.999.999",
// which can DNS-resolve to a remote host) would bypass the remote-key requirement
// (Plan-Gate WARN, Codex).
export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    if (h === "localhost" || h === "::1") return true;
    const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return false;
    const o = m.slice(1).map(Number);
    return o[0] === 127 && o.every((n) => n <= 255);
  } catch {
    return false;
  }
}

// Extract the LAST balanced top-level {…} object from text (string-aware, so braces
// inside JSON string values don't miscount). A reasoning model emits its reasoning
// FIRST and its answer LAST, so the review JSON is the final top-level object — this
// recovers it even when an unclosed <think> preamble carries its own braces.
export function lastBalancedJsonObject(text: string): string | null {
  let start = -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  let last: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}" && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) last = text.slice(start, i + 1);
    }
  }
  return last;
}

function endpointFrom(baseUrl: string | undefined): string {
  return `${(baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "")}/chat/completions`;
}

export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  pricePerMTokensUsd: number | undefined,
): number {
  if (!pricePerMTokensUsd || pricePerMTokensUsd <= 0) return 0;
  return ((inputTokens + outputTokens) / 1_000_000) * pricePerMTokensUsd;
}

export class OllamaAdapter implements ProviderAdapter {
  readonly id = "ollama" as const;
  private readonly fetchImpl: typeof fetch;
  constructor(opts: OllamaAdapterOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async preflight(cfg: ProviderConfig): Promise<Preflight> {
    const key = process.env[cfg.apiKeyEnv ?? DEFAULT_API_KEY_ENV];
    if (!key && !isLoopbackUrl(cfg.baseUrl ?? DEFAULT_BASE_URL))
      return {
        available: false,
        version: null,
        authMode: "apikey",
        error: `env ${cfg.apiKeyEnv ?? DEFAULT_API_KEY_ENV} not set`,
      };
    return { available: true, version: "ollama-v1", authMode: "apikey", error: null };
  }

  async review(input: ReviewInput & { cfg: ProviderConfig; reviewerId: string }): Promise<ReviewResult> {
    const start = Date.now();
    const key = process.env[input.cfg.apiKeyEnv ?? DEFAULT_API_KEY_ENV];
    const baseUrl = input.cfg.baseUrl ?? DEFAULT_BASE_URL;
    const errorResult = (detail: string, httpStatus?: number): ReviewResult => ({
      reviewerId: input.reviewerId,
      verdict: "ERROR",
      findings: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
      durationMs: Date.now() - start,
      exitCode: -1,
      rawEventsPath: "",
      status: httpStatus === 429 || isQuotaExhausted(detail) ? "quota-exhausted" : "error",
      statusDetail: detail.slice(0, 1000),
    });
    if (!key && !isLoopbackUrl(baseUrl))
      return errorResult(`Ollama API key env '${input.cfg.apiKeyEnv ?? DEFAULT_API_KEY_ENV}' is not set`);

    const prompt = readFileSync(input.promptFile, "utf8");
    const body = {
      model: input.cfg.model,
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_schema", json_schema: { name: "review", strict: true, schema: REVIEW_OUTPUT_SCHEMA } },
    };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.cfg.timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (input.signal) {
      if (input.signal.aborted) controller.abort();
      else input.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    let json: ChatResponse;
    try {
      const resp = await this.fetchImpl(endpointFrom(baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) return errorResult(`Ollama HTTP ${resp.status}: ${(await resp.text()).slice(0, 500)}`, resp.status);
      json = (await resp.json()) as ChatResponse;
    } catch (err) {
      return errorResult(`Ollama request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onExternalAbort);
    }
    if (json.error?.message) return errorResult(`Ollama error: ${json.error.message}`);

    const content = json.choices?.[0]?.message?.content ?? "";
    let out = parseReviewOutput(stripReasoningBlocks(content));
    if (!out) {
      // Fallback for the pathological case: an UNCLOSED <think> whose reasoning
      // preamble itself contains braces — stripReasoningBlocks can only strip up to
      // the FIRST "{", leaving a stray brace ahead of the real JSON so
      // parseReviewOutput's first-{…last-} slice grabs the wrong object. The review
      // JSON is the model's ANSWER, which a reasoning model emits LAST, so recover
      // the last balanced top-level object (Plan-Gate CRITICAL, Codex).
      const last = lastBalancedJsonObject(content);
      if (last) out = parseReviewOutput(last);
    }
    if (!out) {
      return isQuotaExhausted(content)
        ? errorResult("Ollama returned quota/usage-limit content", 429)
        : errorResult("Ollama returned no valid review JSON (empty or unparseable response)");
    }
    const findings: Finding[] = mapReviewOutputToFindings(out, {
      provider: "ollama",
      model: input.cfg.model,
      persona: input.persona,
      workingDir: input.workingDir,
    });
    const inputTokens = json.usage?.prompt_tokens ?? 0;
    const outputTokens = json.usage?.completion_tokens ?? 0;
    return {
      reviewerId: input.reviewerId,
      verdict: verdictFromFindings(findings),
      findings,
      usage: {
        inputTokens,
        outputTokens,
        costUsd: estimateCostUsd(inputTokens, outputTokens, input.cfg.costPerMTokensUsd),
        quotaUsedPct: null,
      },
      durationMs: Date.now() - start,
      exitCode: 0,
      rawEventsPath: "",
      rawText: content,
      status: "ok",
    };
  }

  // Free-form completion (NO review schema) for LLM judges (critic / curator /
  // grounding). Forcing REVIEW_OUTPUT_SCHEMA here would make a judge return
  // review-shaped JSON and silently no-op. Throws on error so the caller falls
  // back to its default verdict.
  async complete(prompt: string, opts: CompleteOptions): Promise<string> {
    const key = process.env[opts.apiKeyEnv ?? DEFAULT_API_KEY_ENV];
    const baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    if (!key && !isLoopbackUrl(baseUrl))
      throw new Error(`Ollama complete: API key env '${opts.apiKeyEnv ?? DEFAULT_API_KEY_ENV}' is not set`);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (key) headers.Authorization = `Bearer ${key}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? COMPLETE_TIMEOUT_MS);
    const onExternalAbort = () => controller.abort();
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    let json: ChatResponse;
    try {
      const resp = await this.fetchImpl(endpointFrom(baseUrl), {
        method: "POST",
        headers,
        body: JSON.stringify({ model: opts.model, messages: [{ role: "user", content: prompt }] }),
        signal: controller.signal,
      });
      if (!resp.ok) throw new Error(`Ollama complete HTTP ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
      json = (await resp.json()) as ChatResponse;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onExternalAbort);
    }
    if (json.error?.message) throw new Error(`Ollama complete error: ${json.error.message}`);
    // GLM is a thinking model — strip <think> so a judge/critic never receives
    // reasoning-contaminated text (Plan-Gate WARN, GLM).
    return stripReasoningBlocks(json.choices?.[0]?.message?.content ?? "");
  }
}
```

- [ ] **Step 5: Run tests + gates to verify they pass**

Run: `bun test tests/unit/ollama-adapter.test.ts && bunx tsc --noEmit && bun run lint`
Expected: all tests PASS; tsc + biome clean.

- [ ] **Step 6: Commit**

```bash
git add src/providers/ollama.ts src/providers/adapter-base.ts tests/unit/ollama-adapter.test.ts
git commit -m "feat(ollama): OllamaAdapter for Ollama Cloud OpenAI-compat /v1 endpoint"
```

---

### Task 2: Wire `ollama` into config, registry, and availability

**Files:**
- Modify: `src/config/define-config.ts` (ProviderId enum; `baseUrl` in `ProviderConfigSchema`; `ollama` in `providers`)
- Modify: `src/config/defaults.ts` (`ollama` provider block; `| "ollama"` in the critic/triage/grounding/curator union annotations)
- Modify: `src/providers/registry.ts` (`ProviderId` union; import + `createAdapter` case)
- Modify: `src/providers/availability.ts` (`PROVIDER_BIN.ollama`; `isProviderAvailable` branch)
- Modify (ProviderId-derived, Step 6b): `src/schemas/audit-event.ts` (export + `ProviderIdEnum`), `src/schemas/cassette.ts` (`ProviderIdSchema`), `src/cli/setup/build-config.ts` (`DEFAULT_AUTH` Record + auth-type widen), `src/cli/setup/prefill.ts` (`MODEL_DEFAULT` Record). Setup-wizard integration (`setup.ts`) is DEFERRED — see Step 6b.
- Test: `tests/unit/ollama-wiring.test.ts`

**Interfaces:**
- Consumes: `OllamaAdapter` (Task 1), `createAdapter`, `isProviderAvailable`, `ConfigSchema`, `defaultConfig`.
- Produces: `ollama` is a valid `ProviderId` everywhere; `createAdapter("ollama")` returns an `OllamaAdapter`; `ConfigSchema` accepts a `providers.ollama` block with `baseUrl`; `defaultConfig.providers.ollama` exists (disabled); `isProviderAvailable("ollama", env)` keys off `OLLAMA_API_KEY`.

- [ ] **Step 1: Write the failing wiring tests**

Create `tests/unit/ollama-wiring.test.ts`:

```ts
// tests/unit/ollama-wiring.test.ts
import { describe, expect, it } from "bun:test";
import { ConfigSchema } from "../../src/config/define-config.ts";
import { defaultConfig } from "../../src/config/defaults.ts";
import { createAdapter } from "../../src/providers/registry.ts";
import { isProviderAvailable } from "../../src/providers/availability.ts";
import { OllamaAdapter } from "../../src/providers/ollama.ts";
import { ProviderIdEnum } from "../../src/schemas/audit-event.ts";

describe("ollama wiring", () => {
  it("the persisted audit ProviderIdEnum accepts 'ollama' (stats/audit records)", () => {
    // Guards the Step-6b gap: adding ollama to registry ProviderId without the
    // persisted enum makes RunSummarySchema.parse reject an ollama stat at runtime.
    expect(ProviderIdEnum.safeParse("ollama").success).toBe(true);
  });

  it("defaults include a disabled ollama provider pointing at glm-5.2:cloud + cloud baseUrl", () => {
    expect(defaultConfig.providers.ollama).toMatchObject({
      enabled: false,
      auth: "apikey",
      apiKeyEnv: "OLLAMA_API_KEY",
      model: "glm-5.2:cloud",
      baseUrl: "https://ollama.com/v1",
      costPerMTokensUsd: 0,
    });
  });

  it("ConfigSchema accepts an ollama provider with baseUrl and a reviewer using it", () => {
    const parsed = ConfigSchema.parse({
      version: 1,
      providers: {
        codex: { enabled: true, auth: "oauth", model: "gpt-5", timeoutMs: 1000 },
        ollama: { enabled: true, auth: "apikey", apiKeyEnv: "OLLAMA_API_KEY", model: "glm-5.2:cloud", baseUrl: "http://localhost:11434/v1", timeoutMs: 1000 },
      },
      phases: { review: { reviewers: [{ provider: "ollama", persona: "security" }] } },
    });
    expect(parsed.providers.ollama?.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("createAdapter('ollama') returns an OllamaAdapter", () => {
    expect(createAdapter("ollama")).toBeInstanceOf(OllamaAdapter);
  });

  it("isProviderAvailable('ollama') keys off the API key env", () => {
    expect(isProviderAvailable("ollama", "OLLAMA_API_KEY", { env: { OLLAMA_API_KEY: "x" } })).toBe(true);
    expect(isProviderAvailable("ollama", "OLLAMA_API_KEY", { env: {} })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/unit/ollama-wiring.test.ts`
Expected: FAIL (`defaultConfig.providers.ollama` undefined; `createAdapter` type/case error; etc.).

- [ ] **Step 3: Edit `src/providers/registry.ts`**

Add the import, extend the union, add the case:
```ts
import { OllamaAdapter } from "./ollama.ts";

export type ProviderId = "codex" | "gemini" | "claude-code" | "openrouter" | "opencode" | "ollama";
```
In `createAdapter`'s switch, add:
```ts
    case "ollama":
      return new OllamaAdapter();
```

- [ ] **Step 4: Edit `src/providers/availability.ts`**

In `PROVIDER_BIN`, add:
```ts
  ollama: null,
```
In `isProviderAvailable`, right after the existing `openrouter` branch (both key off the
function's local `const env = deps.env ?? process.env`, already declared above — this is the SAME
`env` the `openrouter` branch uses; the wiring test's `{ env: … }` third arg is an `AvailabilityDeps`,
NOT a bare env record, so `env[apiKeyEnv]` resolves correctly), add:
```ts
  if (id === "ollama") return Boolean(env[apiKeyEnv ?? "OLLAMA_API_KEY"]);
```

- [ ] **Step 5: Edit `src/config/define-config.ts`**

In `ProviderConfigSchema` (after `openrouterProvider`), add:
```ts
  // Ollama-only: OpenAI-compat base URL (default https://ollama.com/v1). Other providers ignore it.
  baseUrl: z.string().url().optional(),
```
Extend the `ProviderId` enum:
```ts
const ProviderId = z.enum(["codex", "gemini", "claude-code", "openrouter", "opencode", "ollama"]);
```
In the `providers` object, add:
```ts
    ollama: ProviderConfigSchema.optional(),
```

- [ ] **Step 6: Edit `src/config/defaults.ts`**

After the `opencode` provider block (inside `providers`), add:
```ts
    // Ollama Cloud reviewer (OpenAI-compat /v1). $0 within the subscription quota.
    // Point baseUrl at http://localhost:11434/v1 to use a local `ollama serve`
    // daemon instead (loopback needs no key; a placeholder OLLAMA_API_KEY still
    // registers it as available — availability is key-based, see availability.ts).
    ollama: {
      enabled: false,
      auth: "apikey" as const,
      apiKeyEnv: "OLLAMA_API_KEY",
      model: "glm-5.2:cloud",
      baseUrl: "https://ollama.com/v1",
      timeoutMs: 300_000,
      costPerMTokensUsd: 0,
    },
```
Then append `| "ollama"` to **every** provider-union type annotation — do NOT assume a fixed count (Plan-Gate WARN, GLM: the spec said "~5 sites incl. reputation / fp-ledger", the plan must not undercount). Find them all first:
```bash
grep -rn '"codex" | "gemini" | "claude-code" | "openrouter" | "opencode"' src/
```
Append `| "ollama"` to each hit. In `defaults.ts` these are `critic`, `triage`, `grounding`, and `brain.curator`; the grep surfaces any others (e.g. in reputation / fp-ledger / other modules) that a hardcoded list would miss. Leave any `provider: "openrouter"` LITERAL (e.g. `brain.embeddings.provider`) unchanged. `tsc` will NOT flag a missed annotation that is only compared at runtime, so the grep must be exhaustive — re-run it after editing and confirm zero un-extended hits remain.

- [ ] **Step 6b: Extend the ProviderId-DERIVED sites (Plan-Gate WARN, Claude reviewer)**

Adding `"ollama"` to the `ProviderId` union ALSO breaks sites that use `z.enum([...])` / `Record<ProviderId>` forms — which the Step-6 string-union grep CANNOT match. `bunx tsc --noEmit` (Step 7) catches the tsc ones, but fix them here (one needs a design decision). Verified against the real repo:

1. `src/schemas/audit-event.ts` — the persisted `ProviderIdEnum = z.enum([...])` (currently a private `const`): add `"ollama"` AND `export` it (the wiring test asserts it). Without the `"ollama"` value, `run-summary.ts` assigning a registry `ProviderId` into `ProviderStat.provider` is a **tsc error**, and `stats/load.ts`'s `RunSummarySchema.parse` would **reject a persisted ollama stat at runtime** (NOT tsc-caught).
2. `src/schemas/cassette.ts` — `ProviderIdSchema` (exported): add `"ollama"` so cassette record/replay validates an ollama reviewer.
3. `src/cli/setup/build-config.ts` — `DEFAULT_AUTH: Record<ProviderId, "oauth" | "openrouter">` requires an `ollama` key. **DESIGN DECISION:** the value type cannot express ollama's `"apikey"` auth → **widen the value type to `"oauth" | "openrouter" | "apikey"`** and add `ollama: "apikey"`. Do NOT use `ollama: "openrouter"` (path-of-least-resistance but semantically wrong — it would emit the wrong `auth` in a generated config).
4. `src/cli/setup/prefill.ts` — `MODEL_DEFAULT: Record<ProviderId, string>` requires `ollama: defaultConfig.providers.ollama.model` (`"glm-5.2:cloud"`).

**DEFERRED — full setup-wizard integration:** `src/cli/commands/setup.ts` uses an ARRAY provider list (no tsc break) plus `authFor(p): "oauth" | "openrouter"` (would need the same `"apikey"` widening) and an availability/hint branch. Offering `ollama` in the interactive wizard is a UX follow-up, not part of the core feature — for now ollama is enabled by editing `reviewgate.config.ts` directly (documented in Task 5). Do NOT add ollama to the wizard list in this task, or `authFor(ollama)` silently returns the wrong `"oauth"`.

Then run these to prove no OTHER tsc-breaking site is missed:
```bash
grep -rn 'Record<ProviderId\|z\.enum(\[' src/ | grep -iE 'provider'
bunx tsc --noEmit
```

- [ ] **Step 7: Run tests + gates**

Run: `bun test tests/unit/ollama-wiring.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS; clean. (tsc now forces the `createAdapter` case + `PROVIDER_BIN.ollama` — both present.)

- [ ] **Step 8: Run the FULL suite (schema/registry changes ripple widely)**

Run: `bun test`
Expected: green. If a snapshot of default config / provider counts fails, update it to include `ollama`.

- [ ] **Step 9: Commit**

```bash
git add src/config/define-config.ts src/config/defaults.ts src/providers/registry.ts src/providers/availability.ts \
  src/schemas/audit-event.ts src/schemas/cassette.ts src/cli/setup/build-config.ts src/cli/setup/prefill.ts \
  tests/unit/ollama-wiring.test.ts
git commit -m "feat(ollama): wire ollama into config schema, defaults, registry, availability, audit/cassette/setup-prefill"
```

---

### Task 3: Orchestrator — sandbox skip for the subprocess-less adapter

**Files:**
- Modify: `src/providers/registry.ts` (export `SUBPROCESSLESS_PROVIDERS`)
- Modify: `src/core/orchestrator.ts` (use it in the sandbox-skip condition)
- Test: `tests/unit/subprocessless-providers.test.ts`

**Interfaces:**
- Produces: `export const SUBPROCESSLESS_PROVIDERS: ReadonlySet<string>` = `{ "openrouter", "ollama" }`.
- Consumes: it, in the orchestrator sandbox decision.

**Policy note (no code change):** `ollama` is deliberately NOT added to `LAST_RESORT_ORDER` (orchestrator ~511). That auto-recruits only OAuth/$0 providers as last-resort reviewers; `openrouter` is excluded because it is paid-per-token. Ollama is $0-within-subscription, but whether the plan hard-caps (429 only) or bills overage is unconfirmed — so it stays **explicit-only** like `openrouter` (usable as a reviewer/fallback/critic only when a user lists it). As a critic it is enabled purely by config (`phases.critic.provider = "ollama"`, type-allowed via Task 2's union annotations) with no code change. Flag both facts for the Plan-Gate; revisit `LAST_RESORT_ORDER` inclusion once hard-cap behavior is confirmed.

**Known limitation (documented, no wiring — Plan-Gate WARN, Codex; decision: document):** `complete()` accepts `opts.baseUrl`, but the critic / curator / grounding call sites that invoke `adapter.complete()` are NOT changed to pass `cfg.providers.ollama.baseUrl` — so an Ollama used in those `complete()`-based roles hits the **cloud** default endpoint regardless of a configured localhost `baseUrl`. A **localhost-only** Ollama should therefore be used as a **reviewer** (which honors `baseUrl`), not as a critic/curator/grounding judge. Failure mode is fail-safe: a keyless cloud call throws → the judge falls back to its default (critic is demote-only → no demotion), never a wrong verdict. Wiring `opts.baseUrl` at those call sites is a deferred one-liner per site.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/subprocessless-providers.test.ts`:
```ts
import { describe, expect, it } from "bun:test";
import { SUBPROCESSLESS_PROVIDERS } from "../../src/providers/registry.ts";

describe("SUBPROCESSLESS_PROVIDERS", () => {
  it("contains the HTTP adapters (openrouter, ollama) and not the CLI ones", () => {
    expect(SUBPROCESSLESS_PROVIDERS.has("openrouter")).toBe(true);
    expect(SUBPROCESSLESS_PROVIDERS.has("ollama")).toBe(true);
    expect(SUBPROCESSLESS_PROVIDERS.has("codex")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/unit/subprocessless-providers.test.ts`
Expected: FAIL — `SUBPROCESSLESS_PROVIDERS` not exported.

- [ ] **Step 3: Add the export in `src/providers/registry.ts`**

```ts
// HTTP-API adapters with no local subprocess to sandbox (sandbox-exec/bwrap wrap
// a spawned CLI, which these don't have). The orchestrator skips the sandbox for them.
export const SUBPROCESSLESS_PROVIDERS: ReadonlySet<string> = new Set(["openrouter", "ollama"]);
```

- [ ] **Step 4: Use it in `src/core/orchestrator.ts`**

Import it:
```ts
import { SUBPROCESSLESS_PROVIDERS } from "../providers/registry.ts";
```
Change the sandbox-skip condition (~line 1374) from:
```ts
        this.input.sandboxMode === "off" || provider === "openrouter"
```
to:
```ts
        this.input.sandboxMode === "off" || SUBPROCESSLESS_PROVIDERS.has(provider)
```
Update the adjacent comment (~1369) to name both HTTP adapters: `openrouter AND ollama are HTTP-API adapters (no local subprocess), so sandbox-exec/bwrap — which wrap a spawned CLI — do not apply; they get no sandbox key.`

- [ ] **Step 4b: Audit the OTHER `openrouter` runtime sites (SPEC Feature 5 — Plan-Gate WARN, GLM)**

The spec's Feature 5 flags `provider === "openrouter"` / `"openrouter"` sites at orchestrator ~1675 and ~1958 beyond the sandbox skip. Enumerate ALL of them and decide each:
```bash
grep -n '"openrouter"' src/core/orchestrator.ts
```
For each hit that is NOT the sandbox-skip just changed:
- **Comment-only** (e.g. the review schema-forcing note ~1958, the fallback note ~1675): if the prose names the HTTP adapters, add "ollama"; no runtime effect.
- **Runtime `provider === "openrouter"` comparison gating HTTP-specific behavior** (a subprocess-less distinction like the sandbox one): replace with `SUBPROCESSLESS_PROVIDERS.has(provider)` so `ollama` gets the same handling. `tsc` will NOT catch a missed runtime string compare — this audit is the only guard.
- **Deliberately openrouter-only** — `LAST_RESORT_ORDER` (~511, paid-exclusion policy) and `this.input.adapters.openrouter` (~2475, brain-embeddings lookup): confirm and leave unchanged.
Record in the commit message which sites you found and how each was resolved.

- [ ] **Step 5: Run test + gates + full suite**

Run: `bun test tests/unit/subprocessless-providers.test.ts && bunx tsc --noEmit && bun run lint && bun test`
Expected: PASS; clean; suite green.

- [ ] **Step 6: Commit**

```bash
git add src/providers/registry.ts src/core/orchestrator.ts tests/unit/subprocessless-providers.test.ts
git commit -m "feat(ollama): skip reviewer sandbox for subprocess-less HTTP adapters (openrouter, ollama)"
```

---

### Task 4: `doctor` — ollama-aware availability hints

**Files:**
- Modify: `src/cli/commands/doctor.ts` (extend the `id === "openrouter" ? …` hint conditionals to also handle `"ollama"`)
- Test: `tests/unit/doctor-ollama.test.ts` (or extend an existing doctor test)

**Interfaces:**
- Consumes: the existing curator/critic/grounding availability checks (they already route `ollama` through `isProviderAvailable`).
- Produces: when an unavailable `ollama` provider is configured as critic/curator/grounding, the hint names `OLLAMA_API_KEY` instead of `OPENROUTER_API_KEY`.

**Note:** The generic "reviewer providers enabled" and availability checks already cover `ollama` (they key off `isProviderAvailable`). This task only fixes the provider-specific HINT text so it does not misdirect an Ollama user to `OPENROUTER_API_KEY`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/doctor-ollama.test.ts` — assert that a doctor run with an `ollama` critic (whose key is unset) yields a hint mentioning `OLLAMA_API_KEY`. Model it on the existing critic-check test (find it with `grep -rln "critic provider" tests/`); reuse that harness, swapping the provider to `ollama`. Concretely, the assertion is:
```ts
expect(result.hint).toContain("OLLAMA_API_KEY");
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test tests/unit/doctor-ollama.test.ts`
Expected: FAIL — hint still says `OPENROUTER_API_KEY` (or generic).

- [ ] **Step 3: Edit `src/cli/commands/doctor.ts`**

For each of the three hint ternaries (curator, critic, grounding) that currently read:
```ts
        id === "openrouter"
          ? "Set OPENROUTER_API_KEY in your environment…"
          : `…the CLI hint…`,
```
add an `ollama` arm, e.g.:
```ts
        id === "openrouter"
          ? "Set OPENROUTER_API_KEY in your environment…"
          : id === "ollama"
            ? "Set OLLAMA_API_KEY in your environment (Ollama Cloud), or point providers.ollama.baseUrl at a local daemon."
            : `…the CLI hint…`,
```
Keep each existing message body verbatim; only insert the new `ollama` arm.

- [ ] **Step 4: Run test + gates**

Run: `bun test tests/unit/doctor-ollama.test.ts && bunx tsc --noEmit && bun run lint`
Expected: PASS; clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/doctor.ts tests/unit/doctor-ollama.test.ts
git commit -m "feat(ollama): doctor hints name OLLAMA_API_KEY for ollama providers"
```

---

### Task 5: Documentation

**Files:**
- Modify: `README.md` (or the provider/setup docs — locate the OpenRouter setup section first)
- Modify: `CLAUDE.md` (Architecture map — the `src/providers/` line listing adapters)

- [ ] **Step 1: Locate the provider-setup doc section**

Run: `grep -rln "OPENROUTER_API_KEY\|openrouter" README.md docs/*.md 2>/dev/null`
Read the section that documents adding OpenRouter as a reviewer — mirror its shape.

- [ ] **Step 2: Add an Ollama Cloud setup example**

Document, next to the OpenRouter example:
- `export OLLAMA_API_KEY=…` (from ollama.com → Account → API Keys).
- A `reviewgate.config.ts` snippet enabling `ollama` and adding it as a reviewer/fallback:
  ```ts
  providers: {
    ollama: { enabled: true, auth: "apikey", apiKeyEnv: "OLLAMA_API_KEY", model: "glm-5.2:cloud", baseUrl: "https://ollama.com/v1", timeoutMs: 300_000 },
  },
  phases: { review: { reviewers: [{ provider: "codex", persona: "security", fallback: ["ollama"] }] } },
  ```
- The self-hosted variant: `baseUrl: "http://localhost:11434/v1"` with a running `ollama serve` (+ `ollama signin` for cloud models); note the placeholder-`OLLAMA_API_KEY` availability caveat.

- [ ] **Step 3: Update `CLAUDE.md` Architecture map**

In the `src/providers/` bullet, add `ollama.ts` to the adapter list: `one adapter per reviewer CLI (codex.ts, gemini.ts, claude.ts, openrouter.ts, ollama.ts)` and note ollama is HTTP like openrouter.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md docs/ 2>/dev/null; git commit -m "docs(ollama): setup example + architecture-map entry for the ollama provider"
```

---

### Task 6: Live verification (acceptance gate — mandatory before "done")

**Files:** none committed (scratchpad).

- [ ] **Step 1: Real end-to-end review via the adapter**

Write a scratchpad script that constructs a real `OllamaAdapter` (default `fetch`), writes a small prompt file containing a diff with a planted bug, and calls `adapter.review({ cfg: { enabled:true, auth:"apikey", apiKeyEnv:"OLLAMA_API_KEY", model:"glm-5.2:cloud", timeoutMs:120000 }, … })` with a real `OLLAMA_API_KEY` set.

Run: `OLLAMA_API_KEY=… bun run <scratchpad>/ollama-live.ts`

- [ ] **Step 2: Assert the observable behavior**

Confirm: `res.status === "ok"`, at least one finding maps, `res.findings[0].reviewer.model === "glm-5.2:cloud"`. If `response_format` strict was NOT honored (empty/garbled), confirm the `stripReasoningBlocks` + brace-slice path still recovered valid JSON; if it did NOT, switch the request body to native `/api/chat` + `format: <schema>` (adjust Task 1) and re-verify.

- [ ] **Step 3: Record the outcome**

Note in the final commit / PR description: endpoint path used (`/v1` vs native), whether `<think>` tokens appeared, and the observed latency/reliability. This closes the "verifiable wager" from the spec.

---

## Self-Review

**1. Spec coverage** (`docs/superpowers/specs/2026-07-08-ollama-cloud-reviewer-design.md`):
- Feature 1 adapter → Task 1. Feature 2 config → Task 2 (Steps 5–6). Feature 3 registry/adapter-base → Tasks 1 (Step 1) + 2 (Step 3). Feature 4 availability → Task 2 (Step 4). Feature 5 sandbox skip → Task 3; critic policy → Task 3 policy note. Feature 6 doctor → Task 4. Structured-output wager / live verification → Task 0 (pre-flight) + Task 6 (acceptance). `<think>` stripping → Task 1 (`stripReasoningBlocks`). `complete()` no `embed()` → Task 1. Docs → Task 5. No spec section is unaddressed.

**2. Placeholder scan:** No "TBD/TODO/handle edge cases". Task 4 Step 1 points the implementer at an existing test harness to reuse rather than inventing one blind — the assertion string is given verbatim.

**3. Type consistency:** `OllamaAdapter`, `stripReasoningBlocks`, `isLoopbackUrl`, `lastBalancedJsonObject`, `estimateCostUsd`, `SUBPROCESSLESS_PROVIDERS` are named identically at definition (Tasks 1, 3) and use (Tasks 2, 3 tests). `ProviderId` gains `"ollama"` in both the zod enum (define-config) and the registry union in the same task (Task 2) so `consumedProviders` typechecks. **`ProviderId` is ALSO consumed by `z.enum([...])`/`Record<ProviderId>` sites that the string-union grep can't see — `audit-event.ts` `ProviderIdEnum`, `cassette.ts` `ProviderIdSchema`, `build-config.ts` `DEFAULT_AUTH`, `prefill.ts` `MODEL_DEFAULT` — all enumerated and fixed in Task 2 Step 6b (with the `DEFAULT_AUTH` value-type widened to include `"apikey"`); the setup wizard is deliberately deferred (Plan-Gate WARN, Claude reviewer).** `ProviderConfig.baseUrl` (adapter-base, Task 1) and the zod `baseUrl` (define-config, Task 2) share the name. Default model `glm-5.2:cloud`, key `OLLAMA_API_KEY`, base `https://ollama.com/v1` are consistent across adapter defaults, config defaults, tests, and docs.
