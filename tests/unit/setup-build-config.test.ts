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
    expect(cfg.phases.review.reviewers).toEqual([{ provider: "codex", persona: "security" }]);
  });

  it("OPENROUTER key present => brain ON with codex fp-filter curator", () => {
    const cfg = defineConfig(
      buildQuickPreset({ openrouterKeyPresent: true }) as Parameters<typeof defineConfig>[0],
    );
    expect(cfg.phases.brain?.enabled).toBe(true);
    expect(cfg.phases.brain?.curator).toEqual({ provider: "codex", persona: "fp-filter" });
  });
});

describe("buildCustomConfig", () => {
  it("maps reviewers + critic (with model) + fpLedger toggles", () => {
    const partial = buildCustomConfig({
      reviewers: [
        { provider: "codex", persona: "security", model: "gpt-5.4" },
        { provider: "gemini", persona: "architecture", model: "gemini-3-flash-preview" },
      ],
      critic: { provider: "opencode", persona: "fp-filter", model: "default" },
      brain: null,
      fpLedger: true,
      contextDocs: false,
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

  it("emits the curator model in phases.brain.curator.model", () => {
    const partial = buildCustomConfig({
      reviewers: [{ provider: "codex", persona: "security", model: "gpt-5.4" }],
      critic: null,
      brain: { curator: { provider: "codex", persona: "fp-filter", model: "gpt-5.4-codex" } },
      fpLedger: false,
      contextDocs: false,
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
    });
    const cfg = defineConfig(partial as Parameters<typeof defineConfig>[0]);
    expect(cfg.providers.codex.model).toBe("gpt-5.4-codex");
  });
});
