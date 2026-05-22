import { describe, expect, it } from "bun:test";
import { curatorCheck } from "../../src/cli/commands/doctor.ts";
import { defineConfig } from "../../src/config/define-config.ts";
import type { ProviderId } from "../../src/providers/registry.ts";

const always = (_id: ProviderId) => true;
const never = (_id: ProviderId) => false;

function withCurator(
  provider: ProviderId,
  reviewers?: { provider: ProviderId; persona: string }[],
) {
  return defineConfig({
    phases: {
      ...(reviewers ? { review: { reviewers } } : {}),
      brain: {
        enabled: true,
        embeddings: { provider: "openrouter" },
        curator: { provider, persona: "fp-filter" },
      },
    },
  } as Parameters<typeof defineConfig>[0]);
}

describe("curatorCheck", () => {
  it("returns null when no curator is configured (brain off by default)", () => {
    expect(curatorCheck(defineConfig({}), always)).toBeNull();
  });

  it("returns null when brain is enabled but no curator is set", () => {
    const cfg = defineConfig({
      phases: { brain: { enabled: true, embeddings: { provider: "openrouter" } } },
    } as Parameters<typeof defineConfig>[0]);
    expect(curatorCheck(cfg, always)).toBeNull();
  });

  it("ok when the curator provider is available", () => {
    // opencode = a non-reviewer curator (not in the default codex-only panel)
    const c = curatorCheck(withCurator("opencode"), always);
    expect(c?.status).toBe("ok");
    expect(c?.detail).toContain("opencode");
  });

  it("warns + hints when the curator provider's CLI is unavailable (silent no-op risk)", () => {
    const c = curatorCheck(withCurator("codex"), never);
    expect(c?.status).toBe("warn");
    expect(c?.detail).toContain("silently falls back");
    expect(c?.hint).toContain("codex");
  });

  it("openrouter curator unavailable → hint points at OPENROUTER_API_KEY", () => {
    const c = curatorCheck(withCurator("openrouter"), never);
    expect(c?.status).toBe("warn");
    expect(c?.hint).toContain("OPENROUTER_API_KEY");
  });

  it("notes when the curator provider is also a reviewer (independence caveat)", () => {
    // codex is the default reviewer; using it as curator too → self-judging note.
    const c = curatorCheck(
      withCurator("codex", [{ provider: "codex", persona: "security" }]),
      always,
    );
    expect(c?.status).toBe("ok");
    expect(c?.detail).toContain("also a reviewer");
  });
});
