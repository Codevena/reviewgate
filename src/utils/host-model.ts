// src/utils/host-model.ts
export type HostTier = "opus" | "sonnet" | "haiku" | "unknown";
export type ReviewerTier = "opus" | "sonnet" | "haiku" | "disabled";

const MODEL_TO_TIER: Record<string, HostTier> = {
  "claude-opus-4-8": "opus",
  "claude-opus-4-7": "opus",
  "claude-opus-4-6": "opus",
  "claude-sonnet-4-6": "sonnet",
  "claude-sonnet-4-5": "sonnet",
  "claude-haiku-4-5-20251001": "haiku",
  "claude-haiku-4-5": "haiku",
};

function parseModelId(id: string | undefined | null): HostTier {
  if (!id) return "unknown";
  const exact = MODEL_TO_TIER[id];
  if (exact) return exact;
  if (id.includes("opus")) return "opus";
  if (id.includes("sonnet")) return "sonnet";
  if (id.includes("haiku")) return "haiku";
  return "unknown";
}

export interface DetectInput {
  env: Record<string, string | undefined>;
  hookStdin: { session?: { model?: string } } | null;
}

export interface DetectResult {
  agentHost: "claude" | "codex";
  tier: HostTier;
  modelId: string | null;
  source:
    | "env:REVIEWGATE_HOST_MODEL"
    | "env:CLAUDE_MODEL"
    | "hook-stdin:session.model"
    | "fallback:assume-opus";
}

export function detectHostModel(input: DetectInput): DetectResult {
  const agentHost = input.env.REVIEWGATE_AGENT_HOST === "codex" ? "codex" : "claude";
  const r = input.env.REVIEWGATE_HOST_MODEL;
  if (r)
    return { agentHost, tier: parseModelId(r), modelId: r, source: "env:REVIEWGATE_HOST_MODEL" };

  const c = input.env.CLAUDE_MODEL;
  if (c) return { agentHost, tier: parseModelId(c), modelId: c, source: "env:CLAUDE_MODEL" };

  const s = input.hookStdin?.session?.model;
  if (s)
    return { agentHost, tier: parseModelId(s), modelId: s, source: "hook-stdin:session.model" };

  return { agentHost, tier: "opus", modelId: null, source: "fallback:assume-opus" };
}

export function reviewerTierFor(host: HostTier): ReviewerTier {
  switch (host) {
    case "opus":
      return "sonnet";
    case "sonnet":
      return "haiku";
    case "haiku":
      return "disabled";
    default:
      return "sonnet"; // assume-opus fallback path
  }
}

export function modelIdForTier(tier: ReviewerTier): string | null {
  switch (tier) {
    case "opus":
      return "claude-opus-4-8";
    case "sonnet":
      return "claude-sonnet-4-6";
    case "haiku":
      return "claude-haiku-4-5";
    case "disabled":
      return null;
  }
}
