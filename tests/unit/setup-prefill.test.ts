import { describe, expect, it } from "bun:test";
import {
  MODEL_DEFAULT,
  RECOMMENDED_DEFAULTS,
  answersFromConfig,
} from "../../src/cli/setup/prefill.ts";
import { defineConfig } from "../../src/config/define-config.ts";

describe("RECOMMENDED_DEFAULTS", () => {
  it("matches today's fresh-setup recommendation (codex/security, fpLedger ON)", () => {
    expect(RECOMMENDED_DEFAULTS.reviewerProviders).toEqual(["codex"]);
    expect(RECOMMENDED_DEFAULTS.perReviewer.codex).toEqual({
      persona: "security",
      model: MODEL_DEFAULT.codex,
      fallback: ["gemini", "claude-code"],
    });
    expect(RECOMMENDED_DEFAULTS.critic).toBeNull();
    expect(RECOMMENDED_DEFAULTS.brainCurator).toBeNull();
    expect(RECOMMENDED_DEFAULTS.fpLedger).toBe(true);
    expect(RECOMMENDED_DEFAULTS.contextDocs).toBe(false);
    expect(RECOMMENDED_DEFAULTS.reputation).toBe(true);
  });
});

describe("answersFromConfig", () => {
  it("extracts reviewers (provider/persona/model), critic, curator, toggles", () => {
    const cfg = defineConfig({
      providers: { gemini: { enabled: true }, openrouter: { enabled: true } },
      phases: {
        review: {
          reviewers: [
            { provider: "codex", persona: "security" },
            { provider: "gemini", persona: "architecture" },
          ],
        },
        critic: { provider: "opencode", persona: "fp-filter" },
        fpLedger: { enabled: true },
        contextDocs: { enabled: true },
        reputation: { enabled: true },
        brain: {
          enabled: true,
          embeddings: {
            provider: "openrouter",
            model: "baai/bge-base-en-v1.5",
            apiKeyEnv: "OPENROUTER_API_KEY",
          },
          curator: { provider: "codex", persona: "fp-filter" },
        },
      },
    } as Parameters<typeof defineConfig>[0]);
    const d = answersFromConfig(cfg);
    expect(d.reviewerProviders).toEqual(["codex", "gemini"]);
    expect(d.perReviewer.codex?.persona).toBe("security");
    expect(d.perReviewer.gemini?.persona).toBe("architecture");
    expect(d.perReviewer.gemini?.model).toBe(cfg.providers.gemini?.model);
    expect(d.critic).toEqual({
      provider: "opencode",
      model: cfg.providers.opencode?.model ?? MODEL_DEFAULT.opencode,
    });
    expect(d.brainCurator?.provider).toBe("codex");
    expect(d.fpLedger).toBe(true);
    expect(d.contextDocs).toBe(true);
    expect(d.reputation).toBe(true);
  });

  it("defaults/empty config => codex-only, no critic/brain, fpLedger off (schema default)", () => {
    const d = answersFromConfig(defineConfig({}));
    expect(d.reviewerProviders).toEqual(["codex"]);
    expect(d.critic).toBeNull();
    expect(d.brainCurator).toBeNull();
    expect(d.fpLedger).toBe(false);
    // phases.reputation defaults ON in the schema, so a bare config reads back enabled.
    expect(d.reputation).toBe(true);
  });

  it("honors a per-reviewer model override over providers.<id>.model", () => {
    const cfg = defineConfig({
      phases: {
        review: { reviewers: [{ provider: "codex", persona: "security", model: "gpt-5.4-codex" }] },
      },
    } as Parameters<typeof defineConfig>[0]);
    expect(answersFromConfig(cfg).perReviewer.codex?.model).toBe("gpt-5.4-codex");
  });

  it("reads reputation:false when explicitly disabled", () => {
    const cfg = defineConfig({
      phases: { reputation: { enabled: false } },
    } as Parameters<typeof defineConfig>[0]);
    expect(answersFromConfig(cfg).reputation).toBe(false);
  });

  it("round-trips a per-reviewer fallback chain from the config", () => {
    const cfg = defineConfig({
      phases: {
        review: {
          reviewers: [{ provider: "codex", persona: "security", fallback: ["gemini"] }],
        },
      },
    } as Parameters<typeof defineConfig>[0]);
    expect(answersFromConfig(cfg).perReviewer.codex?.fallback).toEqual(["gemini"]);
  });

  it("answersFromConfig derives ollamaEndpoint from providers.ollama.baseUrl", () => {
    const local = answersFromConfig(
      defineConfig({
        providers: {
          codex: { enabled: true, auth: "oauth", model: "x", timeoutMs: 1000 },
          ollama: {
            enabled: true,
            auth: "apikey",
            apiKeyEnv: "OLLAMA_API_KEY",
            model: "glm-5.2:cloud",
            baseUrl: "http://localhost:11434/v1",
            timeoutMs: 1000,
          },
        },
        phases: { review: { reviewers: [{ provider: "ollama", persona: "security" }] } },
      } as Parameters<typeof defineConfig>[0]),
    );
    expect(local.ollamaEndpoint).toBe("local");
    const cloud = answersFromConfig(
      defineConfig({
        providers: { codex: { enabled: true, auth: "oauth", model: "x", timeoutMs: 1000 } },
        phases: { review: { reviewers: [{ provider: "codex", persona: "security" }] } },
      } as Parameters<typeof defineConfig>[0]),
    );
    expect(cloud.ollamaEndpoint).toBe("cloud");
  });
});
