// tests/unit/aggregator.test.ts
import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function fin(over: Partial<Finding>): Finding {
  return {
    id: "F-x",
    signature: "s",
    severity: "INFO",
    category: "quality",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "gpt-5.4", persona: "security" },
    confidence: 0.5,
    consensus: "singleton",
    ...over,
  };
}

describe("aggregate", () => {
  it("empty findings → PASS", () => {
    const r = aggregate({ findings: [], reviewersTotal: 1 });
    expect(r.verdict).toBe("PASS");
    expect(r.counts).toEqual({ critical: 0, warn: 0, info: 0 });
  });

  it("only INFO → PASS", () => {
    const r = aggregate({ findings: [fin({ severity: "INFO" })], reviewersTotal: 1 });
    expect(r.verdict).toBe("PASS");
  });

  it("single WARN with one reviewer → SOFT-PASS (singleton/minority)", () => {
    const r = aggregate({
      findings: [fin({ severity: "WARN", category: "quality" })],
      reviewersTotal: 1,
    });
    expect(r.verdict).toBe("SOFT-PASS");
  });

  it("CRITICAL security → FAIL regardless of consensus", () => {
    const r = aggregate({
      findings: [fin({ severity: "CRITICAL", category: "security" })],
      reviewersTotal: 1,
    });
    expect(r.verdict).toBe("FAIL");
  });

  it("signatures dedupe and accumulate confirmed_by", () => {
    const f1 = fin({
      id: "F-1",
      signature: "shared",
      severity: "WARN",
      reviewer: { provider: "codex", model: "g", persona: "security" },
    });
    const f2 = fin({
      id: "F-2",
      signature: "shared",
      severity: "WARN",
      reviewer: { provider: "gemini", model: "g", persona: "architecture" },
    });
    const r = aggregate({ findings: [f1, f2], reviewersTotal: 2 });
    expect(r.dedupedFindings.length).toBe(1);
    // biome-ignore lint/style/noNonNullAssertion: test asserts presence
    expect(r.dedupedFindings[0]!.confirmed_by?.length).toBe(2);
    // biome-ignore lint/style/noNonNullAssertion: test asserts presence
    expect(r.dedupedFindings[0]!.consensus).toBe("majority");
  });

  it("merges the SAME bug reported by different reviewers with DIFFERENT rule_ids", () => {
    // Three reviewers flag the hardcoded secret on the same line, each with its
    // own rule_id and wording → must collapse to ONE finding (one decision).
    const a = fin({
      severity: "CRITICAL",
      category: "security",
      file: "x.ts",
      line_start: 5,
      line_end: 5,
      rule_id: "hardcoded-secret",
      message: "secret in source",
      reviewer: { provider: "codex", model: "m", persona: "security" },
    });
    const b = fin({
      severity: "CRITICAL",
      category: "security",
      file: "x.ts",
      line_start: 5,
      line_end: 5,
      rule_id: "secret-leak",
      message: "API key committed",
      reviewer: { provider: "openrouter", model: "m", persona: "security" },
    });
    const c = fin({
      severity: "WARN",
      category: "security",
      file: "x.ts",
      line_start: 5,
      line_end: 5,
      rule_id: "exposed-credential",
      message: "credential exposure",
      reviewer: { provider: "gemini", model: "m", persona: "architecture" },
    });
    const r = aggregate({ findings: [a, b, c], reviewersTotal: 3 });
    expect(r.dedupedFindings.length).toBe(1); // one bug, not three
    // biome-ignore lint/style/noNonNullAssertion: test asserts presence
    const merged = r.dedupedFindings[0]!;
    expect(merged.severity).toBe("CRITICAL"); // highest severity wins
    expect(merged.confirmed_by?.length).toBe(3); // all three reviewers
    expect(merged.consensus).toBe("unanimous");
    expect(merged.details).toContain("Also reported"); // other wordings preserved
  });

  it("keeps genuinely separate bugs (different line regions) distinct", () => {
    const sqli = fin({
      severity: "CRITICAL",
      category: "security",
      file: "x.ts",
      line_start: 3,
      line_end: 3,
      rule_id: "sqli",
    });
    const secret = fin({
      severity: "CRITICAL",
      category: "security",
      file: "x.ts",
      line_start: 40,
      line_end: 40,
      rule_id: "secret",
    });
    const r = aggregate({ findings: [sqli, secret], reviewersTotal: 2 });
    expect(r.dedupedFindings.length).toBe(2); // 3 vs 40 → different windows
  });
});
