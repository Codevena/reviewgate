// src/providers/adapter-base.ts
import type { Finding } from "../schemas/finding.ts";

export interface ProviderConfig {
  enabled: boolean;
  auth: "oauth" | "apikey" | "openrouter";
  apiKeyEnv?: string;
  model: string;
  reasoningEffort?: "low" | "medium" | "high";
  maxTokens?: number;
  timeoutMs: number;
  costPerMTokensUsd?: number;
}

export interface Preflight {
  available: boolean;
  version: string | null;
  authMode: "oauth" | "apikey" | "openrouter";
  error: string | null;
}

export interface ReviewInput {
  promptFile: string;
  workingDir: string;
  findingsPath: string;
  persona: string;
  diffPath: string;
  schemaPath?: string;
}

export type ReviewStatus = "ok" | "error" | "abstain" | "timeout" | "quota-exhausted";

export interface ReviewResult {
  reviewerId: string;
  verdict: "PASS" | "FAIL" | "ERROR";
  findings: Finding[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
    costUsd: number;
    quotaUsedPct: number | null;
  };
  durationMs: number;
  exitCode: number;
  rawEventsPath: string;
  // The unwrapped inner model text (the assistant's answer), already extracted
  // from each provider's CLI/API envelope. Used by non-review calls such as the
  // critic phase, which needs the raw model JSON ({verdicts:[...]}) rather than
  // the mapped findings. Absent when the call errored.
  rawText?: string;
  status: ReviewStatus;
  statusDetail?: string;
}

/**
 * Options for the free-form judge completion. Distinct from EmbedOptions:
 * `apiKeyEnv` is OPTIONAL (CLI providers in oauth mode have none) and `auth`
 * selects per-provider auth handling. OpenRouter ignores `auth` and defaults a
 * missing `apiKeyEnv` to "OPENROUTER_API_KEY". CLI adapters (added in later tasks)
 * will use `auth` to decide key remapping and treat a missing `apiKeyEnv` as
 * "use the CLI's own credentials".
 */
export interface CompleteOptions {
  model: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  auth?: "oauth" | "apikey" | "openrouter";
}

export interface ProviderAdapter {
  readonly id: "codex" | "claude-code" | "gemini" | "openrouter" | "opencode";
  preflight(cfg: ProviderConfig): Promise<Preflight>;
  review(input: ReviewInput & { cfg: ProviderConfig; reviewerId: string }): Promise<ReviewResult>;
  /**
   * Optional free-form completion for LLM judges (curator accept/reject, FP↔Brain
   * contradiction). Implementers MUST NOT impose the review output-schema (that
   * would make a judge return review-shaped JSON instead of its verdict). Throws
   * on error so the caller can fall back to its default. Implemented by the
   * OpenRouter and all four CLI adapters (codex/claude-code/gemini/opencode);
   * judges no-op (use their default) when an adapter leaves it absent.
   */
  complete?(prompt: string, opts: CompleteOptions): Promise<string>;
}
