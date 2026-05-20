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
});
