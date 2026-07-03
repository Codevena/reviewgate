// src/providers/adapter-base.ts
import type { SandboxProfile } from "../sandbox/profile-builder.ts";
import type { Finding } from "../schemas/finding.ts";

// The single source of truth for "does this set of findings block?" — a finding
// is blocking iff its severity is CRITICAL or WARN (INFO is advisory). Shared by
// every adapter's review() so the blocking-severity rule lives in ONE place
// instead of five identical copies (F-067).
export function verdictFromFindings(findings: Finding[]): "PASS" | "FAIL" {
  return findings.some((f) => f.severity === "CRITICAL" || f.severity === "WARN") ? "FAIL" : "PASS";
}

// OpenRouter upstream-provider routing (its request-body `provider` field). Pins
// which upstream actually serves the model — e.g. `deepseek/deepseek-v4` should be
// served by the `deepseek` upstream, not a worse/quantized OpenRouter alternative.
// Maps to OpenRouter's `provider`: only/order verbatim, allowFallbacks →
// allow_fallbacks. Ignored by non-OpenRouter providers.
export interface OpenRouterProviderRouting {
  // `| undefined` (not bare optional) so this accepts zod-inferred config types
  // under tsconfig's exactOptionalPropertyTypes — z.array(...).optional() yields
  // `string[] | undefined`, which a bare `only?: string[]` would reject.
  /** Restrict to these upstream provider slugs (errors if none available). */
  only?: string[] | undefined;
  /** Preferred upstream order. */
  order?: string[] | undefined;
  /** false = use ONLY the listed providers (no fallback beyond them). */
  allowFallbacks?: boolean | undefined;
}

export interface ProviderConfig {
  enabled: boolean;
  auth: "oauth" | "apikey" | "openrouter";
  apiKeyEnv?: string;
  model: string;
  reasoningEffort?: "low" | "medium" | "high";
  maxTokens?: number;
  timeoutMs: number;
  costPerMTokensUsd?: number;
  /** OpenRouter-only: upstream-provider routing (see OpenRouterProviderRouting). */
  openrouterProvider?: OpenRouterProviderRouting;
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
  // Aborts the underlying CLI subprocess when the gate's self-deadline fires
  // (loop.runTimeoutMs). Adapters MUST forward this to spawnSafely so in-flight
  // reviewers are killed rather than left running orphaned past the deadline.
  signal?: AbortSignal;
  // When present, the adapter wraps the reviewer CLI in sandbox-exec (macOS) via
  // spawnSafely's sandbox option. Mode "strict" refuses to run if sandbox-exec is
  // unavailable; "permissive" falls back to unisolated execution.
  sandbox?: { profile: SandboxProfile; mode: "strict" | "permissive" };
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
  // the mapped findings. Absent when the call errored — EXCEPT the S2 lossy-
  // mapping ERROR branch (claude/gemini/opencode's `mappingLooksLossy` path),
  // which deliberately carries rawText as the only surviving triage evidence
  // for the finding(s) that died in schema mapping (the temp run dir is reaped
  // before triage could otherwise recover them).
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
  /** OpenRouter-only: upstream-provider routing (see OpenRouterProviderRouting). */
  openrouterProvider?: OpenRouterProviderRouting;
  // Aborts the underlying call when the gate's self-deadline fires
  // (loop.runTimeoutMs). Adapters MUST forward this to spawnSafely / their fetch
  // controller so a judge or critic running under the deadline is cut short too.
  signal?: AbortSignal;
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
