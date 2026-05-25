import { describe, expect, it } from "bun:test";
import { selectActiveReviewers } from "../../src/core/reputation/quarantine.ts";

const keyOf = (r: { provider: string; persona: string }) => `${r.provider}:${r.persona}`;
const codex = { provider: "codex", persona: "security" };
const gemini = { provider: "gemini", persona: "architecture" };

describe("selectActiveReviewers", () => {
  it("returns all reviewers unchanged when nothing is quarantined", () => {
    const res = selectActiveReviewers([codex, gemini], new Set<string>(), keyOf);
    expect(res.active).toEqual([codex, gemini]);
    expect(res.dropped).toEqual([]);
    expect(res.usedFullFallback).toBe(false);
  });

  it("drops a quarantined reviewer slot", () => {
    const res = selectActiveReviewers([codex, gemini], new Set(["codex:security"]), keyOf);
    expect(res.active).toEqual([gemini]);
    expect(res.dropped).toEqual(["codex:security"]);
    expect(res.usedFullFallback).toBe(false);
  });

  it("runs the FULL panel when filtering would empty it", () => {
    const res = selectActiveReviewers(
      [codex, gemini],
      new Set(["codex:security", "gemini:architecture"]),
      keyOf,
    );
    expect(res.active).toEqual([codex, gemini]); // full panel, unchanged
    expect(res.dropped).toEqual([]);
    expect(res.usedFullFallback).toBe(true);
  });
});
