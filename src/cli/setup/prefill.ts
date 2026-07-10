import { defaultConfig } from "../../config/defaults.ts";
import type { ReviewgateConfig } from "../../config/define-config.ts";
import { isLoopbackUrl } from "../../providers/ollama.ts";
import type { ProviderId } from "../../providers/registry.ts";

// Per-provider default model, sourced from the validated defaults. Shared with setup.ts.
export const MODEL_DEFAULT: Record<ProviderId, string> = {
  codex: defaultConfig.providers.codex.model,
  gemini: defaultConfig.providers.gemini.model,
  "claude-code": defaultConfig.providers["claude-code"].model,
  openrouter: defaultConfig.providers.openrouter.model,
  opencode: defaultConfig.providers.opencode.model,
  ollama: defaultConfig.providers.ollama.model,
};

export interface WizardDefaults {
  reviewerProviders: ProviderId[];
  perReviewer: Record<string, { persona: string; model: string; fallback?: ProviderId[] }>;
  critic: { provider: ProviderId; model: string } | null;
  brainCurator: { provider: ProviderId; model: string } | null;
  fpLedger: boolean;
  contextDocs: boolean;
  reputation: boolean;
  agentLessons: boolean;
  /** Lore — opt-in; a fresh setup and an existing config without phases.lore both prefill false. */
  lore: boolean;
  /** Existing OpenRouter upstream-provider routing (only[0]/order[0]), to seed the
   *  re-run prompt. Empty string = none. */
  openrouterProvider: string;
  ollamaEndpoint: "cloud" | "local";
}

// The fresh-setup recommendation (no existing config). Preserves today's wizard behavior —
// notably fpLedger recommended ON even though the schema default is null/off.
export const RECOMMENDED_DEFAULTS: WizardDefaults = {
  reviewerProviders: ["codex"],
  // Predefined quota-failover chain (both OAuth, $0; each runs only if available).
  perReviewer: {
    codex: { persona: "security", model: MODEL_DEFAULT.codex, fallback: ["gemini", "claude-code"] },
  },
  critic: null,
  brainCurator: null,
  fpLedger: true,
  contextDocs: false,
  reputation: true,
  agentLessons: true,
  // Opt-in — the recommended preset never enables it (must be turned on explicitly).
  lore: false,
  openrouterProvider: "",
  ollamaEndpoint: "cloud",
};

function modelFor(cfg: ReviewgateConfig, provider: ProviderId, override?: string): string {
  return override ?? cfg.providers[provider]?.model ?? MODEL_DEFAULT[provider];
}

// Derives prompt defaults from an existing (effective, validated) config so a re-run seeds
// every Custom prompt with the user's current setup.
export function answersFromConfig(cfg: ReviewgateConfig): WizardDefaults {
  const reviewerProviders: ProviderId[] = [];
  const perReviewer: Record<string, { persona: string; model: string }> = {};
  for (const r of cfg.phases.review.reviewers) {
    if (!reviewerProviders.includes(r.provider)) reviewerProviders.push(r.provider);
    if (!perReviewer[r.provider]) {
      perReviewer[r.provider] = {
        persona: r.persona,
        model: modelFor(cfg, r.provider, r.model),
        ...(r.fallback && r.fallback.length > 0 ? { fallback: r.fallback } : {}),
      };
    }
  }
  const c = cfg.phases.critic;
  const critic = c ? { provider: c.provider, model: modelFor(cfg, c.provider, c.model) } : null;
  const cur = cfg.phases.brain?.curator;
  const brainCurator = cur
    ? { provider: cur.provider, model: modelFor(cfg, cur.provider, cur.model) }
    : null;
  const orRouting = cfg.providers.openrouter?.openrouterProvider;
  const openrouterProvider = orRouting?.only?.[0] ?? orRouting?.order?.[0] ?? "";
  const ollamaBase = cfg.providers.ollama?.baseUrl;
  // The wizard models the endpoint as a binary Cloud/Local, so a hand-set custom REMOTE
  // baseUrl (non-loopback, non-default) reads back as "cloud" and reverts to the ollama.com
  // default on re-serialize — custom remotes aren't wizard-round-trippable (edit
  // reviewgate.config.ts directly to keep one).
  const ollamaEndpoint: "cloud" | "local" =
    ollamaBase && isLoopbackUrl(ollamaBase) ? "local" : "cloud";
  return {
    reviewerProviders,
    perReviewer,
    critic,
    brainCurator,
    fpLedger: Boolean(cfg.phases.fpLedger?.enabled),
    agentLessons: Boolean(cfg.phases.agentLessons?.enabled),
    lore: Boolean(cfg.phases.lore?.enabled),
    contextDocs: Boolean(cfg.phases.contextDocs?.enabled),
    reputation: Boolean(cfg.phases.reputation?.enabled),
    openrouterProvider,
    ollamaEndpoint,
  };
}
