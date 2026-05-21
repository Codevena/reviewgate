import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function fin(over: Partial<Finding>): Finding {
  return {
    id: "F-x",
    signature: "s",
    severity: "WARN",
    category: "quality",
    rule_id: "r",
    file: "a.ts",
    line_start: 10,
    line_end: 10,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.5,
    consensus: "singleton",
    ...over,
  };
}

describe("aggregate — region dedup ignores category", () => {
  it("merges the same line flagged under DIFFERENT categories/rule_ids by different reviewers", () => {
    // The same magic number on line 10: one reviewer calls it quality/WARN, another
    // performance/INFO. Same region → one finding, highest severity, both reviewers.
    const a = fin({
      file: "x.ts",
      line_start: 10,
      severity: "WARN",
      category: "quality",
      rule_id: "magic-number",
      message: "magic number — extract a named constant",
      reviewer: { provider: "codex", model: "m", persona: "security" },
    });
    const b = fin({
      file: "x.ts",
      line_start: 10,
      severity: "INFO",
      category: "performance",
      rule_id: "magic-number-timeout",
      message: "hardcoded 3600000 ms interval",
      reviewer: { provider: "gemini", model: "m", persona: "architecture" },
    });
    const r = aggregate({ findings: [a, b], reviewersTotal: 2 });
    expect(r.dedupedFindings.length).toBe(1);
    expect(r.dedupedFindings[0]?.severity).toBe("WARN"); // highest of WARN/INFO
    expect(r.dedupedFindings[0]?.confirmed_by?.length).toBe(2);
    // Masking guard: the multi-category merge is surfaced in details.
    expect(r.dedupedFindings[0]?.details).toContain("merges concerns categorized as");
  });

  it("still keeps issues in DIFFERENT line regions distinct (even same category)", () => {
    const a = fin({
      file: "x.ts",
      line_start: 5,
      severity: "CRITICAL",
      category: "security",
      rule_id: "a",
    });
    const b = fin({
      file: "x.ts",
      line_start: 40,
      severity: "CRITICAL",
      category: "security",
      rule_id: "b",
    });
    const r = aggregate({ findings: [a, b], reviewersTotal: 2 });
    expect(r.dedupedFindings.length).toBe(2);
  });
});
