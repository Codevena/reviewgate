import { describe, expect, it } from "bun:test";
import {
  type ProviderAvailable,
  fallbackChainCheck,
  recentQuotaCheck,
} from "../../src/cli/commands/doctor.ts";
import { defineConfig } from "../../src/config/define-config.ts";

const allAvailable: ProviderAvailable = () => true;
const noneAvailable: ProviderAvailable = () => false;

describe("fallbackChainCheck", () => {
  it("returns null when no reviewer declares a fallback chain", () => {
    // Explicitly override reviewers to drop the predefined default chain.
    const noChain = defineConfig({
      phases: { review: { reviewers: [{ provider: "codex", persona: "security" }] } },
    } as Parameters<typeof defineConfig>[0]);
    expect(fallbackChainCheck(noChain, allAvailable)).toBeNull();
  });

  it("the shipped default config HAS a usable failover chain (gemini/claude-code)", () => {
    expect(fallbackChainCheck(defineConfig({}), allAvailable)?.status).toBe("ok");
  });

  it("ok when a declared fallback provider is configured + available", () => {
    const cfg = defineConfig({
      providers: {
        gemini: { enabled: false, auth: "oauth", model: "gemini-3.5-flash", timeoutMs: 1000 },
      },
      phases: {
        review: {
          reviewers: [{ provider: "codex", persona: "security", fallback: ["gemini"] }],
        },
      },
    } as Parameters<typeof defineConfig>[0]);
    const c = fallbackChainCheck(cfg, allAvailable);
    expect(c?.status).toBe("ok");
  });

  it("warns when every fallback candidate is unavailable", () => {
    const cfg = defineConfig({
      providers: {
        gemini: { enabled: false, auth: "oauth", model: "gemini-3.5-flash", timeoutMs: 1000 },
      },
      phases: {
        review: {
          reviewers: [{ provider: "codex", persona: "security", fallback: ["gemini"] }],
        },
      },
    } as Parameters<typeof defineConfig>[0]);
    const c = fallbackChainCheck(cfg, noneAvailable);
    expect(c?.status).toBe("warn");
    expect(c?.detail).toContain("codex");
  });

  it("ok when at least ONE candidate in a multi-provider chain is available", () => {
    const cfg = defineConfig({
      phases: {
        review: {
          reviewers: [
            { provider: "codex", persona: "security", fallback: ["gemini", "claude-code"] },
          ],
        },
      },
    } as Parameters<typeof defineConfig>[0]);
    // gemini unavailable, claude-code available → chain is still usable.
    const onlyClaude: ProviderAvailable = (id) => id === "claude-code";
    const c = fallbackChainCheck(cfg, onlyClaude);
    expect(c?.status).toBe("ok");
  });
});

describe("recentQuotaCheck", () => {
  it("returns null with no reviewer data", () => {
    expect(recentQuotaCheck(null)).toBeNull();
  });

  it("returns null when no reviewer was quota-exhausted", () => {
    expect(
      recentQuotaCheck([
        { provider: "codex", status: "ok" },
        { provider: "gemini", status: "error" },
      ]),
    ).toBeNull();
  });

  it("warns and names the capped provider(s), de-duplicated", () => {
    const c = recentQuotaCheck([
      { provider: "codex", status: "quota-exhausted" },
      { provider: "codex", status: "quota-exhausted" },
    ]);
    expect(c?.status).toBe("warn");
    expect(c?.detail).toContain("codex");
    expect(c?.detail.match(/codex/g)?.length).toBe(1);
  });
});
