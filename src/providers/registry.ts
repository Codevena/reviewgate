// src/providers/registry.ts
import type { ProviderAdapter } from "./adapter-base.ts";
import { ClaudeAdapter } from "./claude.ts";
import { CodexAdapter } from "./codex.ts";
import { GeminiAdapter } from "./gemini.ts";
import { OpenRouterAdapter } from "./openrouter.ts";

export type ProviderId = "codex" | "gemini" | "claude-code" | "openrouter";

export function createAdapter(id: ProviderId): ProviderAdapter {
  switch (id) {
    case "codex":
      return new CodexAdapter();
    case "gemini":
      return new GeminiAdapter();
    case "claude-code":
      return new ClaudeAdapter();
    case "openrouter":
      return new OpenRouterAdapter();
  }
}
