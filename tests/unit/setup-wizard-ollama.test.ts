import { describe, expect, it } from "bun:test";
import {
  REVIEWER_PROVIDERS,
  apiKeyEnvFor,
  authFor,
  availabilityHint,
  distinctOpenrouterProbeTuples,
  ollamaNotes,
  openrouterReviewerProbeTuples,
  sharedProviderModel,
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

describe("setup wizard — shared provider model", () => {
  it("keeps an OpenRouter primary and fallback on one probed, persisted model", () => {
    const reviewers = [
      { provider: "openrouter" as const, persona: "security", model: "vendor/model-a" },
      {
        provider: "codex" as const,
        persona: "security",
        model: "gpt-5.5",
        fallback: ["openrouter" as const],
      },
    ];
    const providerModels = { openrouter: "vendor/model-a" };
    const selection = sharedProviderModel(reviewers, providerModels, "openrouter");

    selection.set("vendor/model-b");

    expect(selection.get()).toBe("vendor/model-b");
    expect(reviewers[0]?.model).toBe("vendor/model-b");
    expect(providerModels.openrouter).toBe("vendor/model-b");

    const tuples = openrouterReviewerProbeTuples(reviewers, providerModels);
    expect(tuples.map((tuple) => tuple.purpose)).toEqual(["reviewer", "fallback"]);
    tuples[1]?.setModel("vendor/model-c");
    expect(tuples[0]?.getModel()).toBe("vendor/model-c");
    expect(reviewers[0]?.model).toBe("vendor/model-c");
  });

  it("deduplicates identical OpenRouter prompt tuples but keeps different purposes", () => {
    const model = { value: "vendor/model" };
    const tuple = (purpose: "reviewer" | "fallback") => ({
      label: purpose,
      purpose,
      getModel: () => model.value,
      setModel: (value: string) => {
        model.value = value;
      },
    });

    const distinct = distinctOpenrouterProbeTuples(
      [tuple("reviewer"), tuple("reviewer"), tuple("fallback"), tuple("fallback")],
      { only: ["alibaba"] },
    );

    expect(distinct.map(({ purpose }) => purpose)).toEqual(["reviewer", "fallback"]);
  });
});
