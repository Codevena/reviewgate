// tests/unit/cassette-matching.test.ts
import { describe, expect, it } from "bun:test";
import { completeKey, embedKey, reviewKey, sha256 } from "../../src/cassette/matching.ts";

describe("cassette matching keys", () => {
  it("review key is the reviewerId (critic disambiguated from a same-provider reviewer)", () => {
    expect(reviewKey("codex-security")).toBe("codex-security");
    expect(reviewKey("critic-codex")).toBe("critic-codex");
    expect(reviewKey("codex-security")).not.toBe(reviewKey("critic-codex"));
  });
  it("complete key is provider-scoped (legacy, no prompt hash)", () => {
    expect(completeKey("openrouter")).toBe("openrouter:complete");
  });
  it("complete key is per-prompt when a hash is given → distinct phases don't share a FIFO (F-9)", () => {
    // Two judge phases (e.g. critic vs grounding) send DIFFERENT prompts. Keying
    // by the prompt hash gives each phase its OWN key, so a pop never returns a
    // sibling phase's recorded response.
    const phaseA = sha256("critic prompt");
    const phaseB = sha256("grounding prompt");
    expect(completeKey("openrouter", phaseA)).toBe(`openrouter:complete:${phaseA}`);
    expect(completeKey("openrouter", phaseB)).toBe(`openrouter:complete:${phaseB}`);
    expect(completeKey("openrouter", phaseA)).not.toBe(completeKey("openrouter", phaseB));
    // Same prompt → same key (content-addressed, like embed()).
    expect(completeKey("openrouter", phaseA)).toBe(
      completeKey("openrouter", sha256("critic prompt")),
    );
  });
  it("embed key is content-addressed by text hash", () => {
    const h = sha256("hello");
    expect(embedKey("openrouter", h)).toBe(`openrouter:embed:${h}`);
    expect(sha256("hello")).toBe(sha256("hello"));
    expect(sha256("hello")).not.toBe(sha256("world"));
  });
});
