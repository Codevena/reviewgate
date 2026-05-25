import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function finding(over: Partial<Finding>): Finding {
  return {
    id: "F-001",
    severity: "CRITICAL",
    category: "quality",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "gemini", model: "x", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    signature: "sig-1",
    ...over,
  } as Finding;
}

describe("aggregator reputation demote", () => {
  it("demotes a lone non-security CRITICAL from an unreliable provider → WARN (SOFT-PASS)", () => {
    const agg = aggregate({
      findings: [finding({})],
      reviewersTotal: 2,
      repUnreliable: new Set(["gemini"]),
    });
    const f = agg.dedupedFindings[0];
    expect(f?.severity).toBe("WARN");
    expect(f?.reputation_demoted).toBe(true);
    expect(agg.verdict).toBe("SOFT-PASS");
  });

  it("NEVER demotes a security/correctness CRITICAL even from an unreliable provider", () => {
    const agg = aggregate({
      findings: [finding({ category: "security" })],
      reviewersTotal: 2,
      repUnreliable: new Set(["gemini"]),
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(agg.verdict).toBe("FAIL");
  });

  it("does NOT demote a corroborated (majority) finding", () => {
    // Two findings from different providers (same location) → aggregator computes
    // "majority" consensus. Both providers in repUnreliable — but corroboration
    // exempts the cluster from the reputation demote.
    const f1 = finding({
      signature: "sig-2",
      reviewer: { provider: "gemini", model: "x", persona: "security" },
    });
    const f2 = finding({
      signature: "sig-2",
      reviewer: { provider: "codex", model: "y", persona: "quality" },
    });
    const agg = aggregate({
      findings: [f1, f2],
      reviewersTotal: 2,
      repUnreliable: new Set(["gemini", "codex"]),
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
  });

  it("no effect when the provider is not unreliable", () => {
    const agg = aggregate({
      findings: [finding({})],
      reviewersTotal: 2,
      repUnreliable: new Set(),
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
  });
});
