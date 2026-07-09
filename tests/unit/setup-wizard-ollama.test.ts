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
  it("ollamaNotes: cloud reviewer with key → no notes", () => {
    expect(ollamaNotes({ usedAsJudge: false, endpoint: "cloud", keyPresent: true })).toEqual([]);
  });

  it("ollamaNotes: cloud reviewer without key → one cloud-path note", () => {
    const notes = ollamaNotes({ usedAsJudge: false, endpoint: "cloud", keyPresent: false });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("ollama.com");
  });

  it("ollamaNotes: local reviewer without key → local-daemon note, NOT 'stays inert' wording (bug fix)", () => {
    const notes = ollamaNotes({ usedAsJudge: false, endpoint: "local", keyPresent: false });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("placeholder");
    expect(notes[0]).not.toContain("stays inert");
  });

  it("ollamaNotes: local reviewer with key → no notes", () => {
    expect(ollamaNotes({ usedAsJudge: false, endpoint: "local", keyPresent: true })).toEqual([]);
  });

  it("ollamaNotes: local + judge with key → one local+judge note", () => {
    const localJudge = ollamaNotes({ usedAsJudge: true, endpoint: "local", keyPresent: true });
    expect(localJudge).toHaveLength(1);
    expect(localJudge[0]).toContain("Cloud");
  });

  it("ollamaNotes: local + judge without key → cloud-path note (for the judge) + local+judge note", () => {
    expect(ollamaNotes({ usedAsJudge: true, endpoint: "local", keyPresent: false })).toHaveLength(
      2,
    );
  });
});
