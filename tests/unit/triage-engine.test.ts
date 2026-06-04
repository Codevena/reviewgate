// tests/unit/triage-engine.test.ts
import { describe, expect, it } from "bun:test";
import { computeDiffFacts } from "../../src/research/diff-facts.ts";
import { triageFromFacts } from "../../src/triage/matrix.ts";
import { refineTriage } from "../../src/triage/triage-engine.ts";

const det = triageFromFacts(
  computeDiffFacts(
    "diff --git a/src/x.ts b/src/x.ts\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n",
  ),
);

describe("refineTriage", () => {
  it("keeps the deterministic decision when the LLM call is absent", async () => {
    const d = await refineTriage(det, { llm: null });
    expect(d).toEqual(det);
  });
  it("lets the LLM lower risk but NEVER widen budget beyond deterministic", async () => {
    const d = await refineTriage(det, {
      llm: async () => ({
        riskClass: "sensitive",
        budgetTier: "expanded",
        justification: "llm tried to widen",
      }),
    });
    expect(d.budgetTier).toBe("standard");
  });
  it("falls back to the deterministic decision if the LLM throws", async () => {
    const d = await refineTriage(det, {
      llm: async () => {
        throw new Error("boom");
      },
    });
    expect(d).toEqual(det);
  });
  it("preserves the docs risk class through refinement (llm: null)", async () => {
    const det = {
      schema: "reviewgate.triage.v1" as const,
      riskClass: "docs" as const,
      runReview: true,
      budgetTier: "minimal" as const,
      loopCap: 3,
      reviewerHint: [],
      maxIterationsOverride: null,
      justification: "Plan/doc review.",
    };
    const out = await refineTriage(det, { llm: null });
    expect(out.riskClass).toBe("docs");
    expect(out.runReview).toBe(true);
  });
});
