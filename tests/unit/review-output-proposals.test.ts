// tests/unit/review-output-proposals.test.ts
import { describe, expect, it } from "bun:test";
import { parseReviewOutput } from "../../src/providers/review-output.ts";

describe("parseReviewOutput memory_proposals", () => {
  it("parses an optional memory_proposals array", () => {
    const out = parseReviewOutput(
      JSON.stringify({
        verdict: "PASS",
        findings: [],
        memory_proposals: [
          {
            type: "convention",
            scope: "this-repo",
            title: "t",
            body: "b",
            confidence: 0.7,
            tags: ["x"],
            evidence: [{ kind: "reviewer-observation" }],
          },
        ],
      }),
    );
    expect(out?.memory_proposals?.length).toBe(1);
    expect(out?.memory_proposals?.[0]?.title).toBe("t");
  });
  it("tolerates missing memory_proposals (undefined, not error)", () => {
    const out = parseReviewOutput(JSON.stringify({ verdict: "PASS", findings: [] }));
    expect(out?.memory_proposals).toBeUndefined();
  });
});
