import { describe, expect, it } from "bun:test";
import {
  REVIEWER_PROVIDERS,
  apiKeyEnvFor,
  authFor,
  availabilityHint,
  ollamaNotes,
} from "../../src/cli/commands/setup.ts";

describe("setup wizard — ollama plumbing", () => {
  it("REVIEWER_PROVIDERS includes ollama", () => {
    expect(REVIEWER_PROVIDERS).toContain("ollama");
  });
  it("authFor: ollama→apikey, openrouter→openrouter, CLI→oauth", () => {
    expect(authFor("ollama")).toBe("apikey");
    expect(authFor("openrouter")).toBe("openrouter");
    expect(authFor("codex")).toBe("oauth");
  });
  it("apiKeyEnvFor: API-key providers→env var, CLI→undefined", () => {
    expect(apiKeyEnvFor("ollama")).toBe("OLLAMA_API_KEY");
    expect(apiKeyEnvFor("openrouter")).toBe("OPENROUTER_API_KEY");
    expect(apiKeyEnvFor("codex")).toBeUndefined();
  });
  it("availabilityHint: key provider unavailable→'no API key', CLI→'CLI not found', available→undefined", () => {
    expect(availabilityHint("ollama", false)).toBe("no API key");
    expect(availabilityHint("openrouter", false)).toBe("no API key");
    expect(availabilityHint("codex", false)).toBe("CLI not found");
    expect(availabilityHint("ollama", true)).toBeUndefined();
  });
  it("ollamaNotes: key-missing note only when !keyPresent; local+judge note only for local+judge", () => {
    expect(ollamaNotes({ usedAsJudge: false, endpoint: "cloud", keyPresent: true })).toEqual([]);
    expect(ollamaNotes({ usedAsJudge: false, endpoint: "cloud", keyPresent: false })).toHaveLength(
      1,
    );
    expect(ollamaNotes({ usedAsJudge: false, endpoint: "cloud", keyPresent: false })[0]).toContain(
      "OLLAMA_API_KEY",
    );
    const localJudge = ollamaNotes({ usedAsJudge: true, endpoint: "local", keyPresent: true });
    expect(localJudge).toHaveLength(1);
    expect(localJudge[0]).toContain("Cloud");
    // local + judge + no key → BOTH notes
    expect(ollamaNotes({ usedAsJudge: true, endpoint: "local", keyPresent: false })).toHaveLength(
      2,
    );
  });
});
