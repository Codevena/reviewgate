import { describe, expect, it } from "bun:test";
import { criticCheck, curatorCheck, groundingCheck } from "../../src/cli/commands/doctor.ts";
import { defineConfig } from "../../src/config/define-config.ts";
import type { ProviderId } from "../../src/providers/registry.ts";

const never = (_id: ProviderId) => false;

function withCritic(provider: ProviderId) {
  return defineConfig({
    phases: { critic: { provider, persona: "adversarial" } },
  } as Parameters<typeof defineConfig>[0]);
}

function withCurator(provider: ProviderId) {
  return defineConfig({
    phases: {
      brain: {
        enabled: true,
        embeddings: { provider: "openrouter" },
        curator: { provider, persona: "fp-filter" },
      },
    },
  } as Parameters<typeof defineConfig>[0]);
}

function withGrounding(provider: ProviderId) {
  return defineConfig({
    phases: { grounding: { provider, persona: "grounding" } },
  } as Parameters<typeof defineConfig>[0]);
}

describe("doctor ollama-aware hints", () => {
  it("critic: ollama unavailable → hint points at OLLAMA_API_KEY (not OPENROUTER_API_KEY)", () => {
    const c = criticCheck(withCritic("ollama"), never);
    expect(c?.status).toBe("warn");
    expect(c?.hint).toContain("OLLAMA_API_KEY");
    expect(c?.hint).not.toContain("OPENROUTER_API_KEY");
  });

  it("curator: ollama unavailable → hint points at OLLAMA_API_KEY (not OPENROUTER_API_KEY)", () => {
    const c = curatorCheck(withCurator("ollama"), never);
    expect(c?.status).toBe("warn");
    expect(c?.hint).toContain("OLLAMA_API_KEY");
    expect(c?.hint).not.toContain("OPENROUTER_API_KEY");
  });

  it("grounding: ollama unavailable → hint points at OLLAMA_API_KEY (not OPENROUTER_API_KEY)", () => {
    const c = groundingCheck(withGrounding("ollama"), never);
    expect(c?.status).toBe("warn");
    expect(c?.hint).toContain("OLLAMA_API_KEY");
    expect(c?.hint).not.toContain("OPENROUTER_API_KEY");
  });
});
