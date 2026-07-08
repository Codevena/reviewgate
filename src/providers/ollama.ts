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
import {
  REVIEW_OUTPUT_SCHEMA,
  mapReviewOutputToFindings,
  parseReviewOutput,
} from "./review-output.ts";

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

  async review(
    input: ReviewInput & { cfg: ProviderConfig; reviewerId: string },
  ): Promise<ReviewResult> {
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
      return errorResult(
        `Ollama API key env '${input.cfg.apiKeyEnv ?? DEFAULT_API_KEY_ENV}' is not set`,
      );

    const prompt = readFileSync(input.promptFile, "utf8");
    const body = {
      model: input.cfg.model,
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "review", strict: true, schema: REVIEW_OUTPUT_SCHEMA },
      },
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
      if (!resp.ok)
        return errorResult(
          `Ollama HTTP ${resp.status}: ${(await resp.text()).slice(0, 500)}`,
          resp.status,
        );
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
      throw new Error(
        `Ollama complete: API key env '${opts.apiKeyEnv ?? DEFAULT_API_KEY_ENV}' is not set`,
      );
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
      if (!resp.ok)
        throw new Error(
          `Ollama complete HTTP ${resp.status}: ${(await resp.text()).slice(0, 500)}`,
        );
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
