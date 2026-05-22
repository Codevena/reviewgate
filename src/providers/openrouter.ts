// src/providers/openrouter.ts
import { readFileSync } from "node:fs";
import type { EmbedOptions } from "../core/brain/embeddings.ts";
import type { Finding } from "../schemas/finding.ts";
import type {
  CompleteOptions,
  Preflight,
  ProviderAdapter,
  ProviderConfig,
  ReviewInput,
  ReviewResult,
} from "./adapter-base.ts";
import {
  REVIEW_OUTPUT_SCHEMA,
  mapReviewOutputToFindings,
  parseReviewOutput,
} from "./review-output.ts";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const EMBEDDINGS_ENDPOINT = "https://openrouter.ai/api/v1/embeddings";

/** Default embeddings request timeout (ms) when EmbedOptions.timeoutMs is unset. */
const EMBED_TIMEOUT_MS = 30_000;

export interface OpenRouterAdapterOptions {
  fetchImpl?: typeof fetch;
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export function estimateCostUsd(
  inputTokens: number,
  outputTokens: number,
  pricePerMTokensUsd: number | undefined,
): number {
  if (!pricePerMTokensUsd || pricePerMTokensUsd <= 0) return 0;
  return ((inputTokens + outputTokens) / 1_000_000) * pricePerMTokensUsd;
}

export class OpenRouterAdapter implements ProviderAdapter {
  readonly id = "openrouter" as const;
  private readonly fetchImpl: typeof fetch;
  constructor(opts: OpenRouterAdapterOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async preflight(cfg: ProviderConfig): Promise<Preflight> {
    const key = cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined;
    if (!key)
      return {
        available: false,
        version: null,
        authMode: "openrouter",
        error: `env ${cfg.apiKeyEnv} not set`,
      };
    return { available: true, version: "openrouter-v1", authMode: "openrouter", error: null };
  }

  async review(
    input: ReviewInput & { cfg: ProviderConfig; reviewerId: string },
  ): Promise<ReviewResult> {
    const start = Date.now();
    const key = input.cfg.apiKeyEnv ? process.env[input.cfg.apiKeyEnv] : undefined;
    const errorResult = (detail: string): ReviewResult => ({
      reviewerId: input.reviewerId,
      verdict: "ERROR",
      findings: [],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, quotaUsedPct: null },
      durationMs: Date.now() - start,
      exitCode: -1,
      rawEventsPath: "",
      status: "error",
      statusDetail: detail.slice(0, 1000),
    });
    if (!key) return errorResult(`OpenRouter API key env '${input.cfg.apiKeyEnv}' is not set`);

    const prompt = readFileSync(input.promptFile, "utf8");
    const body = {
      model: input.cfg.model,
      messages: [{ role: "user", content: prompt }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "review", strict: true, schema: REVIEW_OUTPUT_SCHEMA },
      },
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), input.cfg.timeoutMs);
    let json: ChatResponse;
    try {
      const resp = await this.fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok)
        return errorResult(`OpenRouter HTTP ${resp.status}: ${(await resp.text()).slice(0, 500)}`);
      json = (await resp.json()) as ChatResponse;
    } catch (err) {
      return errorResult(`OpenRouter request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (json.error?.message) return errorResult(`OpenRouter error: ${json.error.message}`);

    const content = json.choices?.[0]?.message?.content ?? "";
    const out = parseReviewOutput(content);
    const findings: Finding[] = out
      ? mapReviewOutputToFindings(out, {
          provider: "openrouter",
          model: input.cfg.model,
          persona: input.persona,
          workingDir: input.workingDir,
        })
      : [];
    const inputTokens = json.usage?.prompt_tokens ?? 0;
    const outputTokens = json.usage?.completion_tokens ?? 0;
    return {
      reviewerId: input.reviewerId,
      verdict: findings.some((f) => f.severity === "CRITICAL" || f.severity === "WARN")
        ? "FAIL"
        : "PASS",
      findings,
      usage: {
        inputTokens,
        outputTokens,
        costUsd: estimateCostUsd(
          inputTokens,
          outputTokens,
          (input.cfg as { costPerMTokensUsd?: number }).costPerMTokensUsd,
        ),
        quotaUsedPct: null,
      },
      durationMs: Date.now() - start,
      exitCode: 0,
      rawEventsPath: "",
      rawText: content,
      status: "ok",
    };
  }

  /**
   * Produce an embedding vector for `text` via the OpenRouter embeddings API.
   * Fails-closed: throws on any error, missing key, HTTP failure, or empty vector
   * so callers can treat any exception as "dedup check unavailable".
   */
  async embed(text: string, opts: EmbedOptions): Promise<number[]> {
    const key = opts.apiKeyEnv ? process.env[opts.apiKeyEnv] : undefined;
    if (!key) {
      throw new Error(`OpenRouter embed: API key env '${opts.apiKeyEnv}' is not set`);
    }

    const body = {
      model: opts.model,
      input: text,
    };

    interface EmbedResponse {
      data?: Array<{ embedding?: number[]; index?: number }>;
      error?: { message?: string };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? EMBED_TIMEOUT_MS);
    let json: EmbedResponse;
    try {
      const resp = await this.fetchImpl(EMBEDDINGS_ENDPOINT, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const errText = (await resp.text()).slice(0, 500);
        throw new Error(`OpenRouter embed HTTP ${resp.status}: ${errText}`);
      }

      json = (await resp.json()) as EmbedResponse;
    } finally {
      clearTimeout(timer);
    }
    if (json.error?.message) {
      throw new Error(`OpenRouter embed error: ${json.error.message}`);
    }

    const vector = json.data?.[0]?.embedding;
    if (!vector || vector.length === 0) {
      throw new Error("OpenRouter embed: received empty or missing embedding vector");
    }
    return vector;
  }

  /**
   * Free-form chat completion (NO review output-schema), for LLM judges (the
   * curator accept/reject hybrid + the FP↔Brain contradiction check). review()
   * forces the strict `review` json_schema response_format, so a judge routed
   * through it gets review-shaped JSON instead of its own {accept|contradicts}
   * verdict — making the judge a silent no-op. Judges MUST use this raw path.
   * Throws on any error so callers can fall back to their default verdict.
   */
  async complete(prompt: string, opts: CompleteOptions): Promise<string> {
    const apiKeyEnv = opts.apiKeyEnv ?? "OPENROUTER_API_KEY";
    const key = process.env[apiKeyEnv];
    if (!key) {
      throw new Error(`OpenRouter complete: API key env '${apiKeyEnv}' is not set`);
    }
    const body = { model: opts.model, messages: [{ role: "user", content: prompt }] };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? EMBED_TIMEOUT_MS);
    let json: ChatResponse;
    try {
      const resp = await this.fetchImpl(ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!resp.ok) {
        throw new Error(
          `OpenRouter complete HTTP ${resp.status}: ${(await resp.text()).slice(0, 500)}`,
        );
      }
      json = (await resp.json()) as ChatResponse;
    } finally {
      clearTimeout(timer);
    }
    if (json.error?.message) {
      throw new Error(`OpenRouter complete error: ${json.error.message}`);
    }
    return json.choices?.[0]?.message?.content ?? "";
  }
}
