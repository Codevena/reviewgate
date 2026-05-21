import { describe, expect, it } from "bun:test";
import { RiskClass, TriageDecisionSchema } from "../../src/schemas/triage.ts";

describe("triage schema", () => {
  it("accepts the docs risk class", () => {
    expect(RiskClass.parse("docs")).toBe("docs");
  });

  it("validates a full docs triage decision", () => {
    const d = TriageDecisionSchema.parse({
      schema: "reviewgate.triage.v1",
      riskClass: "docs",
      runReview: true,
      budgetTier: "minimal",
      loopCap: 3,
      reviewerHint: [],
      justification: "Plan/doc review.",
    });
    expect(d.riskClass).toBe("docs");
  });
});
