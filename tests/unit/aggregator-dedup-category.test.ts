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

  it("does NOT wording-merge two distinct bugs far apart in the file (F-010)", () => {
    // Two independent null-deref bugs ~500 lines apart, described with similar
    // words. jaccard({null,pointer,dereference,here}, {null,pointer,dereference,risk})
    // = 3/5 = 0.6 ≥ threshold → the unbounded wording-merge would collapse them into
    // ONE finding, hiding the line-510 bug as a member disposed by a single decision.
    // A wording-merge must be distance-bounded so genuinely separate defects stay apart.
    const a = fin({
      file: "a.ts",
      line_start: 10,
      line_end: 10,
      message: "null pointer dereference here",
      rule_id: "a",
    });
    const b = fin({
      file: "a.ts",
      line_start: 510,
      line_end: 510,
      message: "null pointer dereference risk",
      rule_id: "b",
    });
    const r = aggregate({ findings: [a, b], reviewersTotal: 2 });
    expect(r.dedupedFindings.length).toBe(2);
  });

  it("still wording-merges similar findings reported a few lines apart (reviewer line jitter)", () => {
    // Two reviewers flag the SAME bug but report slightly different lines — a
    // wording-merge within the bounded window must still collapse them to one.
    const a = fin({
      file: "a.ts",
      line_start: 10,
      line_end: 10,
      message: "null pointer dereference here",
      rule_id: "a",
      reviewer: { provider: "codex", model: "m", persona: "security" },
    });
    const b = fin({
      file: "a.ts",
      line_start: 12,
      line_end: 12,
      message: "null pointer dereference risk",
      rule_id: "b",
      reviewer: { provider: "gemini", model: "m", persona: "security" },
    });
    const r = aggregate({ findings: [a, b], reviewersTotal: 2 });
    expect(r.dedupedFindings.length).toBe(1);
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
