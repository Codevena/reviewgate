// tests/unit/anchor-repair-cascade.test.ts
import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function fin(over: Partial<Finding>): Finding {
  return {
    id: "F-x",
    signature: "s",
    severity: "WARN",
    category: "security",
    rule_id: "r",
    file: "src/store.ts",
    line_start: 25,
    line_end: 25,
    message: "m",
    details: "d",
    reviewer: { provider: "ollama", model: "glm-5.2:cloud", persona: "correctness" },
    confidence: 0.55,
    consensus: "singleton",
    ...over,
  };
}

describe("anchor_repaired survives a dedup merge", () => {
  // WITHOUT the OR-propagation: anchor_repaired is undefined on the merged finding (it lived on
  // the member, and ties-keep-first made the UNrepaired finding the representative) -> the badge
  // and pilot-03's count both disappear in exactly the cascade case.
  // WITH it: anchor_repaired is true on the single merged finding.
  it("OR-propagates anchor_repaired from a merged member to the representative", () => {
    const r = aggregate({
      findings: [
        fin({
          signature: "sigA",
          line_start: 25,
          line_end: 25,
          rule_id: "path-traversal-readtemplate",
        }),
        fin({
          signature: "sigB",
          line_start: 26,
          line_end: 26,
          rule_id: "path-traversal",
          anchor_repaired: true,
          reviewer: {
            provider: "openrouter",
            model: "deepseek/deepseek-v3.2",
            persona: "security",
          },
          confidence: 0.9,
        }),
      ],
      reviewersTotal: 2,
    });
    expect(r.dedupedFindings.length).toBe(1);
    expect(r.dedupedFindings[0]?.anchor_repaired).toBe(true);
    expect(r.dedupedFindings[0]?.consensus).toBe("majority");
  });
});
