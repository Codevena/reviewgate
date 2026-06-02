// tests/unit/aggregator-cycle-rejected.test.ts
import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function fin(over: Partial<Finding>): Finding {
  return {
    id: "F",
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
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  };
}

describe("aggregate cycleRejected suppression", () => {
  it("demotes a finding whose signature was already rejected this cycle to INFO", () => {
    const f = fin({ signature: "sig-rej", severity: "WARN" });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      cycleRejected: new Set(["sig-rej"]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.verdict).toBe("PASS"); // no blocking finding remains
  });

  it("matches a MEMBER signature, not just the representative", () => {
    const rep = fin({ signature: "rep", severity: "WARN", line_start: 1, line_end: 1 });
    const mem = fin({ signature: "mem", severity: "WARN", line_start: 1, line_end: 1 });
    const r = aggregate({
      findings: [rep, mem],
      reviewersTotal: 1,
      cycleRejected: new Set(["mem"]),
    });
    expect(r.dedupedFindings).toHaveLength(1);
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
  });

  it("leaves a finding alone when its signature was NOT rejected", () => {
    const f = fin({ signature: "fresh", severity: "WARN" });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      cycleRejected: new Set(["other-sig"]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("WARN");
  });
});
