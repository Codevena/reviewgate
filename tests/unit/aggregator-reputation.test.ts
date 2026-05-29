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
      repUnreliable: new Set(["gemini:security"]),
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
      repUnreliable: new Set(["gemini:security"]),
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
      repUnreliable: new Set(["gemini:security", "codex:quality"]),
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

  it("demotes a lone WARN from an unreliable provider → INFO (PASS)", () => {
    const agg = aggregate({
      findings: [finding({ severity: "WARN" })],
      reviewersTotal: 2,
      repUnreliable: new Set(["gemini:security"]),
    });
    const f = agg.dedupedFindings[0];
    expect(f?.severity).toBe("INFO");
    expect(f?.reputation_demoted).toBe(true);
    expect(agg.verdict).toBe("PASS");
  });

  it("does NOT demote when only ONE of several contributing reviewer keys is unreliable", () => {
    // Two findings (same signature/location) from DIFFERENT providers cluster into one
    // representative whose `members` span both providers (gemini, codex). Only gemini
    // is unreliable, so the `.every()` reviewer-key check fails → stays CRITICAL.
    // (Note: a 2-provider cluster also computes "majority" consensus, which is exempt
    //  on its own — the reviewer-key check is defense-in-depth on the same finding.)
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
      repUnreliable: new Set(["gemini:security"]),
    });
    const f = agg.dedupedFindings[0];
    expect(f?.members?.map((m) => m.provider).sort()).toEqual(["codex", "gemini"]);
    expect(f?.severity).toBe("CRITICAL");
    expect(f?.reputation_demoted).toBeUndefined();
  });

  it("does NOT demote when repUnreliable holds only a legacy bare-provider key", () => {
    const agg = aggregate({
      findings: [finding({})],
      reviewersTotal: 2,
      repUnreliable: new Set(["gemini"]),
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(agg.dedupedFindings[0]?.reputation_demoted).toBeUndefined();
  });

  it("demotes a lone unreliable CORRECTNESS CRITICAL → INFO (PASS) when demoteCorrectness on", () => {
    const agg = aggregate({
      findings: [finding({ category: "correctness" })],
      reviewersTotal: 2,
      repUnreliable: new Set(["gemini:security"]),
      demoteCorrectness: true,
    });
    const f = agg.dedupedFindings[0];
    expect(f?.severity).toBe("INFO");
    expect(f?.reputation_demoted).toBe(true);
    expect(agg.verdict).toBe("PASS");
  });

  it("demotes a lone unreliable CORRECTNESS WARN → INFO too", () => {
    const agg = aggregate({
      findings: [finding({ category: "correctness", severity: "WARN" })],
      reviewersTotal: 2,
      repUnreliable: new Set(["gemini:security"]),
      demoteCorrectness: true,
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("INFO");
    expect(agg.verdict).toBe("PASS");
  });

  it("NEVER demotes a SECURITY CRITICAL even with demoteCorrectness on", () => {
    const agg = aggregate({
      findings: [finding({ category: "security" })],
      reviewersTotal: 2,
      repUnreliable: new Set(["gemini:security"]),
      demoteCorrectness: true,
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(agg.verdict).toBe("FAIL");
  });

  it("does NOT demote a correctness finding that has a SECURITY member", () => {
    // representative is correctness, but a merged member is security → touchesSecurity → exempt
    const f1 = finding({
      signature: "sig-9",
      category: "correctness",
      reviewer: { provider: "gemini", model: "x", persona: "security" },
    });
    const f2 = finding({
      signature: "sig-9",
      category: "security",
      reviewer: { provider: "gemini", model: "x", persona: "security" },
    });
    const agg = aggregate({
      findings: [f1, f2],
      reviewersTotal: 1,
      repUnreliable: new Set(["gemini:security"]),
      demoteCorrectness: true,
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
  });

  it("does NOT demote correctness when demoteCorrectness is off (default)", () => {
    const agg = aggregate({
      findings: [finding({ category: "correctness" })],
      reviewersTotal: 2,
      repUnreliable: new Set(["gemini:security"]),
      // demoteCorrectness omitted → off
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(agg.dedupedFindings[0]?.reputation_demoted).toBeUndefined();
  });

  it("does NOT demote a corroborated (majority) correctness CRITICAL", () => {
    const f1 = finding({
      signature: "sig-8",
      category: "correctness",
      reviewer: { provider: "gemini", model: "x", persona: "security" },
    });
    const f2 = finding({
      signature: "sig-8",
      category: "correctness",
      reviewer: { provider: "codex", model: "y", persona: "quality" },
    });
    const agg = aggregate({
      findings: [f1, f2],
      reviewersTotal: 2,
      repUnreliable: new Set(["gemini:security", "codex:quality"]),
      demoteCorrectness: true,
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
  });
});
