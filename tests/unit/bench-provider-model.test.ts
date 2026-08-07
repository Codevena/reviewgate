// tests/unit/bench-provider-model.test.ts
// --provider-model pins a reviewer's upstream model for a bench run. Without it,
// providers.opencode.model is the sentinel "default" (src/config/defaults.ts:52),
// which means "whatever ~/.config/opencode/opencode.jsonc happens to say" — a
// benchmark input living outside the repo, invisible to the provenance manifest.
// Import order per biome's organizeImports: bench/runner before cli/commands/bench.
import { describe, expect, it } from "bun:test";
import { buildBenchConfig } from "../../src/bench/runner.ts";
import { buildRoster, parseProviderModels } from "../../src/cli/commands/bench.ts";

const QWEN = "alibaba-token-plan/qwen3.8-max";

describe("parseProviderModels", () => {
  it("parses a single provider=model pair", () => {
    expect(parseProviderModels(`opencode=${QWEN}`)).toEqual({ opencode: QWEN });
  });

  it("parses several comma-separated pairs", () => {
    expect(parseProviderModels(`opencode=${QWEN},ollama=glm-5.2:cloud`)).toEqual({
      opencode: QWEN,
      ollama: "glm-5.2:cloud",
    });
  });

  it("keeps '=' inside the model id (provider/model:tag forms)", () => {
    expect(parseProviderModels("openrouter=deepseek/deepseek-v4-flash=x")).toEqual({
      openrouter: "deepseek/deepseek-v4-flash=x",
    });
  });

  it("rejects an unknown provider", () => {
    expect(() => parseProviderModels("qwen=whatever")).toThrow(/unknown provider "qwen"/);
  });

  it("rejects a pair without '='", () => {
    expect(() => parseProviderModels("opencode")).toThrow(/expects <provider>=<model>/);
  });

  it("rejects an empty model", () => {
    expect(() => parseProviderModels("opencode=")).toThrow(/empty model/);
  });

  it("returns an empty object for an empty string", () => {
    expect(parseProviderModels("")).toEqual({});
  });
});

describe("buildBenchConfig providerModels", () => {
  // The guard's two numbers, stated up front: WITHOUT the mechanism the model is
  // "default"; WITH it, the pinned id. Both differ, so this test is not vacuous.
  it("leaves the model at the 'default' sentinel when no override is given", () => {
    const cfg = buildBenchConfig({ providers: ["opencode"] });
    expect(cfg.providers.opencode?.model).toBe("default");
  });

  it("pins the provider model when an override is given", () => {
    const cfg = buildBenchConfig({
      providers: ["opencode"],
      providerModels: { opencode: QWEN },
    });
    expect(cfg.providers.opencode?.model).toBe(QWEN);
  });

  // Two numbers: the shipped default for ollama is "glm-5.2:cloud"
  // (src/config/defaults.ts:63), so the override MUST be a different value or the
  // test proves nothing. WITHOUT the mechanism: "glm-5.2:cloud". WITH it:
  // "qwen3-coder:480b-cloud".
  it("pins a provider that is not in the reviewer panel", () => {
    expect(buildBenchConfig({ providers: ["opencode"] }).providers.ollama?.model).toBe(
      "glm-5.2:cloud",
    );
    const cfg = buildBenchConfig({
      providers: ["opencode"],
      providerModels: { ollama: "qwen3-coder:480b-cloud" },
    });
    expect(cfg.providers.ollama?.model).toBe("qwen3-coder:480b-cloud");
  });

  // `suppressors: { critic: "openrouter" }` is REQUIRED: defaultConfig.phases.critic
  // is null, and buildBenchConfig applies criticModel only inside its
  // `if (base.phases.critic)` branch. Without it, cfg.phases.critic?.model is
  // undefined and this test fails — which is correct existing behaviour, NOT a bug
  // to "fix" by making criticModel unconditional.
  it("does not disturb the critic model override", () => {
    const cfg = buildBenchConfig({
      providers: ["opencode"],
      providerModels: { opencode: QWEN },
      suppressors: { critic: "openrouter" },
      criticModel: "deepseek/deepseek-v4-flash",
    });
    expect(cfg.providers.opencode?.model).toBe(QWEN);
    expect(cfg.phases.critic?.model).toBe("deepseek/deepseek-v4-flash");
  });
});

describe("buildRoster provenance", () => {
  // The spec states the guard in terms of PROVENANCE, not config. Every test above
  // asserts cfg.providers.<id>.model — the config layer. This one closes the hop to
  // what actually gets written into the results file, via the `roster.push` in
  // buildRoster (`model: providerCfg?.model ?? "unknown"`).
  // Empty adapters: preflight is skipped, cli_version falls back to "unknown", and the
  // model still resolves — which is the only field under test here.
  // WITHOUT the override: "default". WITH it: the pinned id.
  it("records the pinned model in the provenance roster", async () => {
    const plain = await buildRoster(buildBenchConfig({ providers: ["opencode"] }), {});
    expect(plain[0]?.model).toBe("default");

    const pinned = await buildRoster(
      buildBenchConfig({ providers: ["opencode"], providerModels: { opencode: QWEN } }),
      {},
    );
    expect(pinned[0]?.model).toBe(QWEN);
  });
});
