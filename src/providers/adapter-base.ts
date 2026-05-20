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
  status: ReviewStatus;
  statusDetail?: string;
}

export interface ProviderAdapter {
  readonly id: "codex" | "claude-code" | "gemini" | "openrouter";
  preflight(cfg: ProviderConfig): Promise<Preflight>;
  review(input: ReviewInput & { cfg: ProviderConfig; reviewerId: string }): Promise<ReviewResult>;
}
