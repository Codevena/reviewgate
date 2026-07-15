import { describe, expect, it } from "bun:test";
import { buildCustomConfig, buildQuickPreset } from "../../src/cli/setup/build-config.ts";
import { defineConfig } from "../../src/config/define-config.ts";

describe("buildQuickPreset", () => {
  it("no OPENROUTER key => fpLedger on, brain OFF", () => {
    const cfg = defineConfig(
      buildQuickPreset({ openrouterKeyPresent: false }) as Parameters<typeof defineConfig>[0],
    );
    expect(cfg.phases.fpLedger).toEqual({ enabled: true });
    expect(cfg.phases.brain).toBeNull();
    expect(cfg.phases.review.reviewers).toEqual([
      { provider: "codex", persona: "security", fallback: ["gemini", "claude-code"] },
    ]);
  });

  it("enables agentLessons on the returned partial (recommended default)", () => {
    const partial = buildQuickPreset({ openrouterKeyPresent: false }) as {
      phases?: { agentLessons?: { enabled?: boolean } };
    };
    expect(partial.phases?.agentLessons?.enabled).toBe(true);
  });

  it("enables reputation on the returned partial", () => {
    const partial = buildQuickPreset({ openrouterKeyPresent: false }) as {
      phases?: { reputation?: { enabled?: boolean } };
    };
    expect(partial.phases?.reputation?.enabled).toBe(true);
  });

  it("OPENROUTER key present => brain ON with codex fp-filter curator", () => {
    const cfg = defineConfig(
      buildQuickPreset({ openrouterKeyPresent: true }) as Parameters<typeof defineConfig>[0],
    );
    expect(cfg.phases.brain?.enabled).toBe(true);
    expect(cfg.phases.brain?.curator).toEqual({ provider: "opencode", persona: "fp-filter" });
  });
});

describe("buildCustomConfig", () => {
  it("maps the agentLessons answer: true => { enabled: true }, false => null (schema off-state)", () => {
    const base = {
      reviewers: [{ provider: "codex" as const, persona: "security", model: "" }],
      critic: null,
      brain: null,
      fpLedger: false,
      contextDocs: false,
      reputation: false,
      agentLessons: false,
      lore: false,
    };
    const on = buildCustomConfig({ ...base, agentLessons: true }) as {
      phases?: { agentLessons?: { enabled?: boolean } | null };
    };
    expect(on.phases?.agentLessons).toEqual({ enabled: true });
    const off = buildCustomConfig({ ...base, agentLessons: false }) as {
      phases?: { agentLessons?: { enabled?: boolean } | null };
    };
    expect(off.phases?.agentLessons).toBeNull();
  });

  it("maps the lore answer: true => { enabled: true }, false => null (schema off-state, opt-in)", () => {
    const base = {
      reviewers: [{ provider: "codex" as const, persona: "security", model: "" }],
      critic: null,
      brain: null,
      fpLedger: false,
      contextDocs: false,
      reputation: false,
      agentLessons: false,
      lore: false,
    };
    const on = buildCustomConfig({ ...base, lore: true }) as {
      phases?: { lore?: { enabled?: boolean } | null };
    };
    expect(on.phases?.lore).toEqual({ enabled: true });
    const off = buildCustomConfig({ ...base, lore: false }) as {
      phases?: { lore?: { enabled?: boolean } | null };
    };
    expect(off.phases?.lore).toBeNull();
  });

  it("emits phases.reputation.enabled reflecting the answer", () => {
    const off = buildCustomConfig({
      reviewers: [{ provider: "codex", persona: "security", model: "" }],
      critic: null,
      brain: null,
      fpLedger: false,
      contextDocs: false,
      reputation: false,
      agentLessons: false,
      lore: false,
    }) as { phases?: { reputation?: { enabled?: boolean } } };
    expect(off.phases?.reputation?.enabled).toBe(false);
    const on = buildCustomConfig({
      reviewers: [{ provider: "codex", persona: "security", model: "" }],
      critic: null,
      brain: null,
      fpLedger: false,
      contextDocs: false,
      reputation: true,
      agentLessons: false,
      lore: false,
    }) as { phases?: { reputation?: { enabled?: boolean } } };
    expect(on.phases?.reputation?.enabled).toBe(true);
  });

  it("wires the OpenRouter upstream-provider into providers.openrouter.openrouterProvider", () => {
    const cfg = defineConfig(
      buildCustomConfig({
        reviewers: [
          { provider: "openrouter", persona: "security", model: "deepseek/deepseek-v4-pro" },
        ],
        critic: null,
        brain: null,
        fpLedger: false,
        contextDocs: false,
        reputation: false,
        agentLessons: false,
        lore: false,
        openrouterProvider: "deepseek",
      }) as Parameters<typeof defineConfig>[0],
    );
    expect(cfg.providers.openrouter?.openrouterProvider).toEqual({ only: ["deepseek"] });
  });

  it("omits openrouterProvider when not chosen (auto-route)", () => {
    const cfg = defineConfig(
      buildCustomConfig({
        reviewers: [{ provider: "openrouter", persona: "security", model: "x/y" }],
        critic: null,
        brain: null,
        fpLedger: false,
        contextDocs: false,
        reputation: false,
        agentLessons: false,
        lore: false,
      }) as Parameters<typeof defineConfig>[0],
    );
    expect(cfg.providers.openrouter?.openrouterProvider).toBeUndefined();
  });

  it("preserves an existing structured OpenRouter route when the wizard leaves it unchanged", () => {
    const cfg = defineConfig(
      buildCustomConfig({
        reviewers: [{ provider: "openrouter", persona: "security", model: "m" }],
        critic: null,
        brain: null,
        fpLedger: false,
        contextDocs: false,
        reputation: false,
        agentLessons: false,
        lore: false,
        openrouterRouting: { order: ["alibaba", "deepseek"], allowFallbacks: false },
      }),
    );
    expect(cfg.providers.openrouter?.openrouterProvider).toEqual({
      order: ["alibaba", "deepseek"],
      allowFallbacks: false,
    });
  });

  it("enables an OpenRouter provider used only as a quota fallback", () => {
    const cfg = defineConfig(
      buildCustomConfig({
        reviewers: [
          { provider: "codex", persona: "security", model: "gpt", fallback: ["openrouter"] },
        ],
        critic: null,
        brain: null,
        fpLedger: false,
        contextDocs: false,
        reputation: false,
        agentLessons: false,
        lore: false,
        openrouterProvider: "alibaba",
        providerModels: { openrouter: "deepseek/deepseek-v4-flash" },
      }),
    );
    expect(cfg.providers.openrouter?.enabled).toBe(true);
    expect(cfg.providers.openrouter?.model).toBe("deepseek/deepseek-v4-flash");
    expect(cfg.providers.openrouter?.openrouterProvider).toEqual({ only: ["alibaba"] });
  });

  it("uses one provider model when OpenRouter is both a primary and a fallback", () => {
    const cfg = defineConfig(
      buildCustomConfig({
        reviewers: [
          { provider: "openrouter", persona: "security", model: "vendor/model-a" },
          {
            provider: "codex",
            persona: "quality",
            model: "gpt-5.5",
            fallback: ["openrouter"],
          },
        ],
        critic: null,
        brain: null,
        fpLedger: false,
        contextDocs: false,
        reputation: false,
        agentLessons: false,
        lore: false,
        providerModels: { openrouter: "vendor/model-b" },
      }),
    );
    expect(cfg.providers.openrouter?.model).toBe("vendor/model-b");
  });

  it("keeps a fallback-only model when the same provider is also the critic", () => {
    const cfg = defineConfig(
      buildCustomConfig({
        reviewers: [
          { provider: "codex", persona: "security", model: "gpt", fallback: ["openrouter"] },
        ],
        critic: {
          provider: "openrouter",
          persona: "fp-filter",
          model: "deepseek/deepseek-v4-pro",
        },
        brain: null,
        fpLedger: false,
        contextDocs: false,
        reputation: false,
        agentLessons: false,
        lore: false,
        providerModels: { openrouter: "vendor/custom-fallback-model" },
      }),
    );
    expect(cfg.providers.openrouter?.model).toBe("vendor/custom-fallback-model");
    expect(cfg.phases.critic?.model).toBe("deepseek/deepseek-v4-pro");
  });

  it("keeps a fallback-only model when the same provider is also the curator", () => {
    const cfg = defineConfig(
      buildCustomConfig({
        reviewers: [
          { provider: "codex", persona: "security", model: "gpt", fallback: ["openrouter"] },
        ],
        critic: null,
        brain: {
          curator: {
            provider: "openrouter",
            persona: "fp-filter",
            model: "deepseek/deepseek-v4-pro",
          },
        },
        fpLedger: false,
        contextDocs: false,
        reputation: false,
        agentLessons: false,
        lore: false,
        providerModels: { openrouter: "vendor/custom-fallback-model" },
      }),
    );
    expect(cfg.providers.openrouter?.model).toBe("vendor/custom-fallback-model");
    expect(cfg.phases.brain?.curator?.model).toBe("deepseek/deepseek-v4-pro");
  });

  it("keeps one primary provider model when that provider is also critic and curator", () => {
    const cfg = defineConfig(
      buildCustomConfig({
        reviewers: [{ provider: "openrouter", persona: "security", model: "vendor/primary-model" }],
        critic: {
          provider: "openrouter",
          persona: "fp-filter",
          model: "vendor/critic-model",
        },
        brain: {
          curator: {
            provider: "openrouter",
            persona: "fp-filter",
            model: "vendor/curator-model",
          },
        },
        fpLedger: false,
        contextDocs: false,
        reputation: false,
        agentLessons: false,
        lore: false,
      }),
    );

    expect(cfg.providers.openrouter?.model).toBe("vendor/primary-model");
    expect(cfg.phases.critic?.model).toBe("vendor/critic-model");
    expect(cfg.phases.brain?.curator?.model).toBe("vendor/curator-model");
  });

  it("maps reviewers + critic (with model) + fpLedger toggles", () => {
    const partial = buildCustomConfig({
      reviewers: [
        { provider: "codex", persona: "security", model: "gpt-5.5" },
        { provider: "gemini", persona: "architecture", model: "gemini-3.5-flash" },
      ],
      critic: { provider: "opencode", persona: "fp-filter", model: "default" },
      brain: null,
      fpLedger: true,
      contextDocs: false,
      reputation: false,
      agentLessons: false,
      lore: false,
    });
    const cfg = defineConfig(partial as Parameters<typeof defineConfig>[0]);
    expect(cfg.providers.gemini?.enabled).toBe(true);
    expect(cfg.phases.review.reviewers).toHaveLength(2);
    expect(cfg.phases.critic).toEqual({
      provider: "opencode",
      persona: "fp-filter",
      model: "default",
    });
    expect(cfg.phases.fpLedger).toEqual({ enabled: true });
    expect(cfg.phases.brain).toBeNull();
    expect(cfg.phases.contextDocs).toBeNull();
  });

  it("maps first-run safety and completion choices", () => {
    const cfg = defineConfig(
      buildCustomConfig({
        reviewers: [{ provider: "codex", persona: "security", model: "" }],
        critic: null,
        brain: null,
        fpLedger: true,
        contextDocs: false,
        reputation: true,
        agentLessons: true,
        lore: false,
        sandboxMode: "strict",
        softPassPolicy: "block",
        acknowledgePass: true,
        desktopNotifications: true,
        prePushWarn: false,
      }) as Parameters<typeof defineConfig>[0],
    );
    expect(cfg.sandbox.mode).toBe("strict");
    expect(cfg.loop.softPassPolicy).toBe("block");
    expect(cfg.loop.acknowledgePass).toBe(true);
    expect(cfg.notify.desktop).toBe(true);
    expect(cfg.loop.prePushWarn).toBe(false);
  });

  it("emits the curator model in phases.brain.curator.model", () => {
    const partial = buildCustomConfig({
      reviewers: [{ provider: "codex", persona: "security", model: "gpt-5.5" }],
      critic: null,
      brain: { curator: { provider: "codex", persona: "fp-filter", model: "gpt-5.4-codex" } },
      fpLedger: false,
      contextDocs: false,
      reputation: false,
      agentLessons: false,
      lore: false,
    });
    const cfg = defineConfig(partial as Parameters<typeof defineConfig>[0]);
    expect(cfg.phases.brain?.curator).toEqual({
      provider: "codex",
      persona: "fp-filter",
      model: "gpt-5.4-codex",
    });
  });

  it("omits an empty critic/curator model so defineConfig uses the provider default", () => {
    const partial = buildCustomConfig({
      reviewers: [{ provider: "codex", persona: "security", model: "" }],
      critic: { provider: "opencode", persona: "fp-filter", model: "" },
      brain: { curator: { provider: "codex", persona: "fp-filter", model: "" } },
      fpLedger: false,
      contextDocs: false,
      reputation: false,
      agentLessons: false,
      lore: false,
    });
    // critic/curator entries present but WITHOUT an explicit model key (→ provider default)
    const ph = (
      partial as {
        phases?: {
          critic?: Record<string, unknown>;
          brain?: { curator?: Record<string, unknown> };
        };
      }
    ).phases;
    expect(ph?.critic && "model" in ph.critic).toBe(false);
    expect(ph?.brain?.curator && "model" in ph.brain.curator).toBe(false);
  });

  it("a per-reviewer model override lands in providers.<id>.model", () => {
    const partial = buildCustomConfig({
      reviewers: [{ provider: "codex", persona: "security", model: "gpt-5.4-codex" }],
      critic: null,
      brain: null,
      fpLedger: false,
      contextDocs: false,
      reputation: false,
      agentLessons: false,
      lore: false,
    });
    const cfg = defineConfig(partial as Parameters<typeof defineConfig>[0]);
    expect(cfg.providers.codex.model).toBe("gpt-5.4-codex");
  });

  it("emits a per-reviewer fallback chain when present", () => {
    const partial = buildCustomConfig({
      reviewers: [
        { provider: "codex", persona: "security", model: "", fallback: ["gemini", "claude-code"] },
      ],
      critic: null,
      brain: null,
      fpLedger: false,
      contextDocs: false,
      reputation: false,
      agentLessons: false,
      lore: false,
    });
    const cfg = defineConfig(partial as Parameters<typeof defineConfig>[0]);
    expect(cfg.phases.review.reviewers[0]).toEqual({
      provider: "codex",
      persona: "security",
      fallback: ["gemini", "claude-code"],
    });
  });

  it("omits the fallback key when the chain is empty/absent", () => {
    const partial = buildCustomConfig({
      reviewers: [{ provider: "codex", persona: "security", model: "", fallback: [] }],
      critic: null,
      brain: null,
      fpLedger: false,
      contextDocs: false,
      reputation: false,
      agentLessons: false,
      lore: false,
    });
    const cfg = defineConfig(partial as Parameters<typeof defineConfig>[0]);
    expect(Object.hasOwn(cfg.phases.review.reviewers[0] ?? {}, "fallback")).toBe(false);
  });

  it("ollama reviewer: apikey + OLLAMA_API_KEY; Cloud omits baseUrl (defaults supply it)", () => {
    const partial = buildCustomConfig({
      reviewers: [{ provider: "ollama", persona: "security", model: "glm-5.2:cloud" }],
      critic: null,
      brain: null,
      fpLedger: false,
      contextDocs: false,
      reputation: false,
      agentLessons: false,
      lore: false,
    }) as { providers?: { ollama?: Record<string, unknown> } };
    expect(Object.hasOwn(partial.providers?.ollama ?? {}, "baseUrl")).toBe(false);
    const cfg = defineConfig(partial as Parameters<typeof defineConfig>[0]);
    expect(cfg.providers.ollama?.enabled).toBe(true);
    expect(cfg.providers.ollama?.auth).toBe("apikey");
    expect(cfg.providers.ollama?.apiKeyEnv).toBe("OLLAMA_API_KEY");
    expect(cfg.providers.ollama?.model).toBe("glm-5.2:cloud");
    expect(cfg.providers.ollama?.baseUrl).toBe("https://ollama.com/v1");
  });

  it("Local endpoint writes providers.ollama.baseUrl=localhost", () => {
    const partial = buildCustomConfig({
      reviewers: [{ provider: "ollama", persona: "security", model: "glm-5.2:cloud" }],
      critic: null,
      brain: null,
      fpLedger: false,
      contextDocs: false,
      reputation: false,
      agentLessons: false,
      lore: false,
      ollamaBaseUrl: "http://localhost:11434/v1",
    }) as { providers?: { ollama?: { baseUrl?: string } } };
    expect(partial.providers?.ollama?.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("enables providers.ollama when ollama is CRITIC-only (no ollama reviewer)", () => {
    const partial = buildCustomConfig({
      reviewers: [{ provider: "codex", persona: "security", model: "" }],
      critic: { provider: "ollama", persona: "fp-filter", model: "glm-5.2:cloud" },
      brain: null,
      fpLedger: false,
      contextDocs: false,
      reputation: false,
      agentLessons: false,
      lore: false,
    }) as { providers?: { ollama?: Record<string, unknown> } };
    expect(partial.providers?.ollama?.enabled).toBe(true);
    expect(partial.providers?.ollama?.auth).toBe("apikey");
    expect(partial.providers?.ollama?.apiKeyEnv).toBe("OLLAMA_API_KEY");
  });
});
