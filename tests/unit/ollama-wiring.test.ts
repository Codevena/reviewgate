// tests/unit/ollama-wiring.test.ts
import { describe, expect, it } from "bun:test";
import { defaultConfig } from "../../src/config/defaults.ts";
import { ConfigSchema } from "../../src/config/define-config.ts";
import { isProviderAvailable } from "../../src/providers/availability.ts";
import { OllamaAdapter } from "../../src/providers/ollama.ts";
import { createAdapter } from "../../src/providers/registry.ts";
import { ProviderIdEnum } from "../../src/schemas/audit-event.ts";

describe("ollama wiring", () => {
  it("the persisted audit ProviderIdEnum accepts 'ollama' (stats/audit records)", () => {
    // Guards the Step-6b gap: adding ollama to registry ProviderId without the
    // persisted enum makes RunSummarySchema.parse reject an ollama stat at runtime.
    expect(ProviderIdEnum.safeParse("ollama").success).toBe(true);
  });

  it("defaults include a disabled ollama provider pointing at glm-5.2:cloud + cloud baseUrl", () => {
    expect(defaultConfig.providers.ollama).toMatchObject({
      enabled: false,
      auth: "apikey",
      apiKeyEnv: "OLLAMA_API_KEY",
      model: "glm-5.2:cloud",
      baseUrl: "https://ollama.com/v1",
      costPerMTokensUsd: 0,
    });
  });

  it("ConfigSchema accepts an ollama provider with baseUrl and a reviewer using it", () => {
    // ConfigSchema requires the full top-level shape (loop/sandbox/audit/output have
    // no schema defaults — only defineConfig's deep-merge-over-defaultConfig supplies
    // them), so spread defaultConfig like the other ConfigSchema.parse tests
    // (reputation-config.test.ts) and override just the ollama-relevant fields.
    const parsed = ConfigSchema.parse({
      ...defaultConfig,
      providers: {
        ...defaultConfig.providers,
        ollama: {
          enabled: true,
          auth: "apikey",
          apiKeyEnv: "OLLAMA_API_KEY",
          model: "glm-5.2:cloud",
          baseUrl: "http://localhost:11434/v1",
          timeoutMs: 1000,
        },
      },
      phases: {
        ...defaultConfig.phases,
        review: { reviewers: [{ provider: "ollama", persona: "security" }] },
      },
    });
    expect(parsed.providers.ollama?.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("createAdapter('ollama') returns an OllamaAdapter", () => {
    expect(createAdapter("ollama")).toBeInstanceOf(OllamaAdapter);
  });

  it("isProviderAvailable('ollama') keys off the API key env", () => {
    expect(isProviderAvailable("ollama", "OLLAMA_API_KEY", { env: { OLLAMA_API_KEY: "x" } })).toBe(
      true,
    );
    expect(isProviderAvailable("ollama", "OLLAMA_API_KEY", { env: {} })).toBe(false);
  });
});
