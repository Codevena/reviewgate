// tests/unit/orchestrator-effective-reviewers.test.ts
import { describe, expect, it } from "bun:test";
import { effectiveReviewerCount } from "../../src/core/orchestrator.ts";

// The singleton-CRITICAL failsafe (aggregator) must see the number of DISTINCT
// reviewer identities, not the raw ok-run slot count. When two reviewer slots
// both fail over to the SAME provider:persona, they are effectively ONE reviewer
// — their findings dedupe to a single reviewer key — so a lone CRITICAL must
// still hard-FAIL instead of SOFT-PASSing under a phantom 2-reviewer panel.
describe("effectiveReviewerCount", () => {
  it("collapses two slots that share a provider:persona to 1", () => {
    expect(
      effectiveReviewerCount([
        { provider: "openrouter", persona: "security" },
        { provider: "openrouter", persona: "security" },
      ]),
    ).toBe(1);
  });

  it("counts distinct personas of the same provider as separate reviewers", () => {
    expect(
      effectiveReviewerCount([
        { provider: "openrouter", persona: "security" },
        { provider: "openrouter", persona: "quality" },
      ]),
    ).toBe(2);
  });

  it("counts distinct providers as separate reviewers", () => {
    expect(
      effectiveReviewerCount([
        { provider: "codex", persona: "security" },
        { provider: "gemini", persona: "security" },
      ]),
    ).toBe(2);
  });

  it("returns 0 for an empty panel", () => {
    expect(effectiveReviewerCount([])).toBe(0);
  });
});
