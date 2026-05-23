import { describe, expect, it } from "bun:test";
import { isProviderAvailable } from "../../src/providers/availability.ts";

describe("isProviderAvailable", () => {
  it("openrouter: true only when the configured key env var is set", () => {
    expect(
      isProviderAvailable("openrouter", "OPENROUTER_API_KEY", {
        env: { OPENROUTER_API_KEY: "sk-x" },
      }),
    ).toBe(true);
    expect(isProviderAvailable("openrouter", "OPENROUTER_API_KEY", { env: {} })).toBe(false);
  });

  it("openrouter: honors a non-default apiKeyEnv name", () => {
    expect(isProviderAvailable("openrouter", "MY_KEY", { env: { MY_KEY: "x" } })).toBe(true);
    expect(isProviderAvailable("openrouter", "MY_KEY", { env: { OPENROUTER_API_KEY: "x" } })).toBe(
      false,
    );
  });

  it("openrouter: defaults a missing apiKeyEnv to OPENROUTER_API_KEY", () => {
    expect(isProviderAvailable("openrouter", undefined, { env: { OPENROUTER_API_KEY: "x" } })).toBe(
      true,
    );
  });

  it("CLI providers probe their binary (codex/gemini/claude-code/opencode)", () => {
    const present = (bin: string) => ["codex", "gemini", "claude", "opencode"].includes(bin);
    for (const id of ["codex", "gemini", "claude-code", "opencode"] as const) {
      expect(isProviderAvailable(id, undefined, { env: {}, probeBin: present })).toBe(true);
    }
    expect(isProviderAvailable("codex", undefined, { env: {}, probeBin: () => false })).toBe(false);
  });

  it("claude-code probes the `claude` binary, not `claude-code`", () => {
    const probed: string[] = [];
    isProviderAvailable("claude-code", undefined, {
      env: {},
      probeBin: (b) => {
        probed.push(b);
        return true;
      },
    });
    expect(probed).toEqual(["claude"]);
  });
});
