import type { DeepPartial, ReviewgateConfig } from "../../config/define-config.ts";
import type { ProviderId } from "../../providers/registry.ts";

export interface ReviewerAnswer {
  provider: ProviderId;
  persona: string;
  /** Model slug. Empty string → omit it so defineConfig falls back to the provider default in defaults.ts. */
  model: string;
  /** Quota-failover chain. Empty/absent → omit the key (no failover for this slot). */
  fallback?: ProviderId[];
}

export interface CustomAnswers {
  reviewers: ReviewerAnswer[];
  critic: {
    provider: ProviderId;
    persona: string;
    /** Empty string → omit it so defineConfig falls back to the provider default. */
    model: string;
  } | null;
  brain: {
    curator: {
      provider: ProviderId;
      persona: string;
      /** Empty string → omit it so defineConfig falls back to the provider default. */
      model: string;
    };
  } | null;
  fpLedger: boolean;
  contextDocs: boolean;
  reputation: boolean;
  /** Agent Lessons — the agent-facing twin of the FP-ledger: accepted+fixed
   *  findings (verified real agent mistakes) are distilled into recurring
   *  patterns and injected at SessionStart as advisory context. Render-only,
   *  never verdict-affecting. false → phases.agentLessons = null (schema off). */
  agentLessons: boolean;
  /** OpenRouter upstream-provider slug to pin (e.g. "deepseek" for deepseek/*
   *  models). Empty/absent → auto-route. Written as providers.openrouter
   *  .openrouterProvider = { only: [slug] }. Only applied when openrouter is used. */
  openrouterProvider?: string;
  /** Ollama endpoint override (Local). Absent → Cloud (baseUrl omitted). Written as providers.ollama.baseUrl. */
  ollamaBaseUrl?: string;
}

const DEFAULT_AUTH: Record<ProviderId, "oauth" | "openrouter" | "apikey"> = {
  codex: "oauth",
  gemini: "oauth",
  "claude-code": "oauth",
  opencode: "oauth",
  openrouter: "openrouter",
  ollama: "apikey",
};

// Enables each used provider with its chosen model. apiKeyEnv is set for openrouter,
// plus its optional upstream-provider routing (openrouterProvider → { only: [slug] }).
function providersFor(
  ids: { provider: ProviderId; model?: string }[],
  openrouterProvider?: string,
  ollamaBaseUrl?: string,
): DeepPartial<ReviewgateConfig>["providers"] {
  const out: Record<string, unknown> = {};
  for (const { provider, model } of ids) {
    const entry: Record<string, unknown> = { enabled: true, auth: DEFAULT_AUTH[provider] };
    if (model) entry.model = model;
    if (provider === "openrouter") {
      entry.apiKeyEnv = "OPENROUTER_API_KEY";
      const slug = openrouterProvider?.trim();
      if (slug) entry.openrouterProvider = { only: [slug] };
    }
    if (provider === "ollama") {
      entry.apiKeyEnv = "OLLAMA_API_KEY";
      if (ollamaBaseUrl) entry.baseUrl = ollamaBaseUrl;
    }
    out[provider] = { ...(out[provider] as object), ...entry };
  }
  return out as DeepPartial<ReviewgateConfig>["providers"];
}

export interface QuickInput {
  openrouterKeyPresent: boolean;
}

export function buildQuickPreset(input: QuickInput): DeepPartial<ReviewgateConfig> {
  const brainPhase = input.openrouterKeyPresent
    ? {
        brain: {
          enabled: true,
          embeddings: {
            provider: "openrouter" as const,
            model: "baai/bge-base-en-v1.5",
            apiKeyEnv: "OPENROUTER_API_KEY",
          },
          // opencode = a NON-reviewer judge → more independent than reusing a
          // reviewer (codex). Non-blocking: if opencode isn't installed the judge
          // silently falls back to its default and `doctor` warns.
          curator: { provider: "opencode" as const, persona: "fp-filter" },
        },
      }
    : {};
  return {
    providers: { codex: { enabled: true, auth: "oauth" } },
    phases: {
      // Predefined quota-failover: codex → gemini → claude-code (both OAuth, $0).
      // Each only runs if its CLI is available; no surprise billing.
      review: {
        reviewers: [
          { provider: "codex", persona: "security", fallback: ["gemini", "claude-code"] },
        ],
      },
      fpLedger: { enabled: true },
      reputation: { enabled: true },
      // Agent Lessons: recommended ON like the fpLedger — fail-safe/advisory,
      // and it is the only learning loop that teaches the AGENT (not reviewers).
      agentLessons: { enabled: true },
      ...brainPhase,
    },
  } as DeepPartial<ReviewgateConfig>;
}

export function buildCustomConfig(a: CustomAnswers): DeepPartial<ReviewgateConfig> {
  const providerIds: { provider: ProviderId; model?: string }[] = a.reviewers.map((r) => ({
    provider: r.provider,
    model: r.model,
  }));
  if (a.critic) providerIds.push({ provider: a.critic.provider });
  if (a.brain) providerIds.push({ provider: a.brain.curator.provider });

  // Record<string,unknown> so contextDocs can be null (a valid override); defineConfig validates it.
  const phases: Record<string, unknown> = {
    review: {
      reviewers: a.reviewers.map((r) => ({
        provider: r.provider,
        persona: r.persona,
        ...(r.fallback && r.fallback.length > 0 ? { fallback: r.fallback } : {}),
      })),
    },
    fpLedger: { enabled: a.fpLedger },
    reputation: { enabled: a.reputation },
    // null (not {enabled:false}) is the schema's documented off-state.
    agentLessons: a.agentLessons ? { enabled: true } : null,
  };
  if (a.critic) {
    const criticEntry: Record<string, unknown> = {
      provider: a.critic.provider,
      persona: a.critic.persona,
    };
    if (a.critic.model) criticEntry.model = a.critic.model;
    phases.critic = criticEntry;
  }
  if (a.brain) {
    const curatorEntry: Record<string, unknown> = {
      provider: a.brain.curator.provider,
      persona: a.brain.curator.persona,
    };
    if (a.brain.curator.model) curatorEntry.model = a.brain.curator.model;
    phases.brain = {
      enabled: true,
      embeddings: {
        provider: "openrouter",
        model: "baai/bge-base-en-v1.5",
        apiKeyEnv: "OPENROUTER_API_KEY",
      },
      curator: curatorEntry,
    };
  }
  phases.contextDocs = a.contextDocs ? { enabled: true } : null;

  return {
    providers: providersFor(providerIds, a.openrouterProvider, a.ollamaBaseUrl),
    phases: phases as DeepPartial<ReviewgateConfig>["phases"],
  } as DeepPartial<ReviewgateConfig>;
}
