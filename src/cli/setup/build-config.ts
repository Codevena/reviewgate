import type { DeepPartial, ReviewgateConfig } from "../../config/define-config.ts";
import type { ProviderId } from "../../providers/registry.ts";

export interface ReviewerAnswer {
  provider: ProviderId;
  persona: string;
  /** Model slug. Empty string → omit it so defineConfig falls back to the provider default in defaults.ts. */
  model: string;
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
}

const DEFAULT_AUTH: Record<ProviderId, "oauth" | "openrouter"> = {
  codex: "oauth",
  gemini: "oauth",
  "claude-code": "oauth",
  opencode: "oauth",
  openrouter: "openrouter",
};

// Enables each used provider with its chosen model. apiKeyEnv is set for openrouter.
function providersFor(
  ids: { provider: ProviderId; model?: string }[],
): DeepPartial<ReviewgateConfig>["providers"] {
  const out: Record<string, unknown> = {};
  for (const { provider, model } of ids) {
    const entry: Record<string, unknown> = { enabled: true, auth: DEFAULT_AUTH[provider] };
    if (model) entry.model = model;
    if (provider === "openrouter") entry.apiKeyEnv = "OPENROUTER_API_KEY";
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
          curator: { provider: "codex" as const, persona: "fp-filter" },
        },
      }
    : {};
  return {
    providers: { codex: { enabled: true, auth: "oauth" } },
    phases: {
      review: { reviewers: [{ provider: "codex", persona: "security" }] },
      fpLedger: { enabled: true },
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
    review: { reviewers: a.reviewers.map((r) => ({ provider: r.provider, persona: r.persona })) },
    fpLedger: { enabled: a.fpLedger },
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
    providers: providersFor(providerIds),
    phases: phases as DeepPartial<ReviewgateConfig>["phases"],
  } as DeepPartial<ReviewgateConfig>;
}
