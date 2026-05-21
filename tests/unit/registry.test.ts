// tests/unit/registry.test.ts
import { describe, expect, it } from "bun:test";
import { ClaudeAdapter } from "../../src/providers/claude.ts";
import { CodexAdapter } from "../../src/providers/codex.ts";
import { GeminiAdapter } from "../../src/providers/gemini.ts";
import { OpenCodeAdapter } from "../../src/providers/opencode.ts";
import { OpenRouterAdapter } from "../../src/providers/openrouter.ts";
import { createAdapter } from "../../src/providers/registry.ts";

describe("createAdapter", () => {
  it("builds the right adapter per provider id", () => {
    expect(createAdapter("codex")).toBeInstanceOf(CodexAdapter);
    expect(createAdapter("gemini")).toBeInstanceOf(GeminiAdapter);
    expect(createAdapter("claude-code")).toBeInstanceOf(ClaudeAdapter);
    expect(createAdapter("openrouter")).toBeInstanceOf(OpenRouterAdapter);
    expect(createAdapter("opencode")).toBeInstanceOf(OpenCodeAdapter);
  });
});
