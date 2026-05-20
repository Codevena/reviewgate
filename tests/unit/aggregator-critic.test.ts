// tests/unit/aggregator-critic.test.ts
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
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.5,
    consensus: "singleton",
    ...over,
  };
}

describe("aggregate with critic", () => {
  it("demotes a likely_fp WARN singleton to INFO -> PASS", () => {
    const f = fin({ signature: "sigA", severity: "WARN", category: "quality" });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      critic: new Map([["sigA", { verdict: "likely_fp" }]]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.verdict).toBe("PASS");
  });

  it("never demotes a CRITICAL security finding even if critic says likely_fp", () => {
    const f = fin({ signature: "sigB", severity: "CRITICAL", category: "security" });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      critic: new Map([["sigB", { verdict: "likely_fp" }]]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.verdict).toBe("FAIL");
  });

  it("never demotes a unanimous-panel finding", () => {
    const a = fin({
      signature: "sigC",
      severity: "WARN",
      reviewer: { provider: "codex", model: "m", persona: "security" },
    });
    const b = fin({
      signature: "sigC",
      severity: "WARN",
      reviewer: { provider: "gemini", model: "m", persona: "architecture" },
    });
    const c = fin({
      signature: "sigC",
      severity: "WARN",
      reviewer: { provider: "claude-code", model: "m", persona: "adversarial" },
    });
    const r = aggregate({
      findings: [a, b, c],
      reviewersTotal: 3,
      critic: new Map([["sigC", { verdict: "likely_fp" }]]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("WARN");
    expect(r.dedupedFindings[0]?.consensus).toBe("unanimous");
  });
});
