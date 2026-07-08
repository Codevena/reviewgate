// src/providers/registry.ts
import type { ProviderAdapter } from "./adapter-base.ts";
import { ClaudeAdapter } from "./claude.ts";
import { CodexAdapter } from "./codex.ts";
import { GeminiAdapter } from "./gemini.ts";
import { OllamaAdapter } from "./ollama.ts";
import { OpenCodeAdapter } from "./opencode.ts";
import { OpenRouterAdapter } from "./openrouter.ts";

export type ProviderId = "codex" | "gemini" | "claude-code" | "openrouter" | "opencode" | "ollama";

// HTTP-API adapters with no local subprocess to sandbox (sandbox-exec/bwrap wrap
// a spawned CLI, which these don't have). The orchestrator skips the sandbox for them.
export const SUBPROCESSLESS_PROVIDERS: ReadonlySet<string> = new Set(["openrouter", "ollama"]);

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
    case "opencode":
      return new OpenCodeAdapter();
    case "ollama":
      return new OllamaAdapter();
  }
}
