import { describe, expect, it } from "bun:test";
import { SUBPROCESSLESS_PROVIDERS } from "../../src/providers/registry.ts";

describe("SUBPROCESSLESS_PROVIDERS", () => {
  it("contains the HTTP adapters (openrouter, ollama) and not the CLI ones", () => {
    expect(SUBPROCESSLESS_PROVIDERS.has("openrouter")).toBe(true);
    expect(SUBPROCESSLESS_PROVIDERS.has("ollama")).toBe(true);
    expect(SUBPROCESSLESS_PROVIDERS.has("codex")).toBe(false);
  });
});
