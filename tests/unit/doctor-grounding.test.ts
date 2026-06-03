import { describe, expect, it } from "bun:test";
import { type ProviderAvailable, groundingCheck } from "../../src/cli/commands/doctor.ts";
import { defineConfig } from "../../src/config/define-config.ts";
import type { ProviderId } from "../../src/providers/registry.ts";

const always = (_id: ProviderId) => true;
const never = (_id: ProviderId) => false;

function withGrounding(provider: ProviderId) {
  return defineConfig({
    phases: { grounding: { provider } },
  } as Parameters<typeof defineConfig>[0]);
}

describe("groundingCheck", () => {
  it("returns null when grounding is off (default)", () => {
    expect(groundingCheck(defineConfig({}), always)).toBeNull();
  });

  it("ok when the grounding provider is available", () => {
    const c = groundingCheck(withGrounding("openrouter"), always);
    expect(c?.status).toBe("ok");
    expect(c?.detail).toContain("openrouter");
  });

  it("warns when the grounding provider is unavailable (judge silently no-ops, no demotion)", () => {
    const c = groundingCheck(withGrounding("openrouter"), never);
    expect(c?.status).toBe("warn");
    expect(c?.detail).toContain("grounding judge");
    expect(c?.hint).toContain("OPENROUTER_API_KEY");
  });

  it("checks the CONFIGURED provider apiKeyEnv (not a hard-coded name)", () => {
    const seen: (string | undefined)[] = [];
    const spy: ProviderAvailable = (_id, apiKeyEnv) => {
      seen.push(apiKeyEnv);
      return true;
    };
    groundingCheck(withGrounding("openrouter"), spy);
    expect(seen).toContain("OPENROUTER_API_KEY");
  });
});
