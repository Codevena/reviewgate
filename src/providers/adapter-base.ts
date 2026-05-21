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

export interface ProviderAdapter {
  readonly id: "codex" | "claude-code" | "gemini" | "openrouter" | "opencode";
  preflight(cfg: ProviderConfig): Promise<Preflight>;
  review(input: ReviewInput & { cfg: ProviderConfig; reviewerId: string }): Promise<ReviewResult>;
  /**
   * Optional free-form completion for LLM judges (curator accept/reject, FP↔Brain
   * contradiction). Implementers MUST NOT impose the review output-schema (that
   * would make a judge return review-shaped JSON instead of its verdict). Throws
   * on error so the caller can fall back to its default. Only the OpenRouter
   * adapter implements this today; judges no-op (use their default) when absent.
   */
  complete?(
    prompt: string,
    opts: { model: string; apiKeyEnv: string; timeoutMs?: number },
  ): Promise<string>;
}
