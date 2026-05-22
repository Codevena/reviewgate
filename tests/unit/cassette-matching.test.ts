// tests/unit/cassette-matching.test.ts
import { describe, expect, it } from "bun:test";
import { completeKey, embedKey, reviewKey, sha256 } from "../../src/cassette/matching.ts";

describe("cassette matching keys", () => {
  it("review key is the reviewerId (critic disambiguated from a same-provider reviewer)", () => {
    expect(reviewKey("codex-security")).toBe("codex-security");
    expect(reviewKey("critic-codex")).toBe("critic-codex");
    expect(reviewKey("codex-security")).not.toBe(reviewKey("critic-codex"));
  });
  it("complete key is provider-scoped", () => {
    expect(completeKey("openrouter")).toBe("openrouter:complete");
  });
  it("embed key is content-addressed by text hash", () => {
    const h = sha256("hello");
    expect(embedKey("openrouter", h)).toBe(`openrouter:embed:${h}`);
    expect(sha256("hello")).toBe(sha256("hello"));
    expect(sha256("hello")).not.toBe(sha256("world"));
  });
});
