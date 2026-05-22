// tests/unit/build-adapters.test.ts
import { describe, expect, it } from "bun:test";
import { buildAdapters, consumedProviders } from "../../src/cli/build-adapters.ts";
import { defaultConfig } from "../../src/config/defaults.ts";

const cfgWithBrainEmbedderNotReviewer = {
  ...defaultConfig,
  phases: {
    review: { reviewers: [{ provider: "codex" as const, persona: "security" }] },
    critic: null,
    triage: null,
    brain: {
      enabled: true,
      maxPromptTokens: 1500,
      embeddings: { provider: "openrouter" as const, model: "m", apiKeyEnv: "X" },
      egressAllowlist: [],
      curatorTimeoutMs: 20000,
    },
  },
};

describe("buildAdapters", () => {
  it("includes the brain embeddings provider even when it is not a reviewer", () => {
    const provs = consumedProviders(cfgWithBrainEmbedderNotReviewer as never);
    expect(provs).toContain("codex");
    expect(provs).toContain("openrouter"); // embeddings provider, not a reviewer
  });

  it("explicit providerOverrides win over cassette/createAdapter", () => {
    const fake = { id: "codex" } as never;
    const adapters = buildAdapters(cfgWithBrainEmbedderNotReviewer as never, { codex: fake }, null);
    expect(adapters.codex).toBe(fake);
  });

  it("replay mode binds a ReplayAdapter per consumed provider", () => {
    const adapters = buildAdapters(cfgWithBrainEmbedderNotReviewer as never, undefined, {
      mode: "replay",
      path: "/dev/null", // loadCassette of empty → []
    });
    expect(adapters.codex?.id).toBe("codex");
    expect(adapters.openrouter?.id).toBe("openrouter");
  });

  it("with a cassette active + forced persona, two same-provider reviewers collapsing to one id is a hard error", () => {
    const cfg = {
      ...defaultConfig,
      phases: {
        review: {
          reviewers: [
            { provider: "codex" as const, persona: "security" },
            { provider: "codex" as const, persona: "architecture" },
          ],
        },
        critic: null,
        triage: null,
      },
    };
    // forced persona "plan" collapses both codex reviewers onto "codex-plan"
    expect(() =>
      buildAdapters(cfg as never, undefined, { mode: "replay", path: "/dev/null" }, "plan"),
    ).toThrow(/duplicate reviewerId/);
    // without a forced persona the two distinct personas are fine
    expect(() =>
      buildAdapters(cfg as never, undefined, { mode: "replay", path: "/dev/null" }),
    ).not.toThrow();
  });
});
