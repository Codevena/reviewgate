// tests/unit/reputation-corroboration.test.ts
//
// T2 / R5 (field report 2026-07-03): reputation corroboration clamp. The old
// unconditional CRITICAL-correctness exemption in the reputation demote pass
// predates G0 and let a chronically-wrong lone reviewer (the field's 38%-precision
// reviewer) manufacture unconditional hard FAILs from hallucinated CRITICALs.
// With corroborateCritical on and >= 2 reviewers, such a finding is clamped to a
// decision-required WARN (G0 keeps it blocking) instead of hard-FAILing the turn.
import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function finding(over: Partial<Finding>): Finding {
  return {
    id: "F-001",
    severity: "CRITICAL",
    category: "correctness",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "openrouter", model: "x", persona: "quality" },
    confidence: 0.9,
    consensus: "singleton",
    signature: "sig-1",
    ...over,
  } as Finding;
}

const UNRELIABLE = new Set(["openrouter:quality"]);

describe("reputation corroboration clamp (R5)", () => {
  it("clamps a lone unreliable CRITICAL-correctness to a decision-required WARN at reviewersTotal=2", () => {
    const agg = aggregate({
      findings: [finding({})],
      reviewersTotal: 2,
      repUnreliable: UNRELIABLE,
      demoteCorrectness: true,
      corroborateCritical: true,
    });
    const f = agg.dedupedFindings[0];
    expect(f?.severity).toBe("WARN");
    expect(f?.reputation_demoted).toBe(true);
    expect(f?.demoted_from_critical).toBe(true); // G0: stays decision-required
    expect(f?.reputation_corroboration_required).toBe(true);
    // No longer an unconditional hard FAIL; G0 (loop-driver) still blocks for decisions.
    expect(agg.verdict).toBe("SOFT-PASS");
  });

  it("singleton failsafe untouched: at reviewersTotal=1 the lone CRITICAL still hard-FAILs", () => {
    const agg = aggregate({
      findings: [finding({})],
      reviewersTotal: 1,
      repUnreliable: UNRELIABLE,
      demoteCorrectness: true,
      corroborateCritical: true,
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(agg.dedupedFindings[0]?.reputation_corroboration_required).toBeUndefined();
    expect(agg.verdict).toBe("FAIL");
  });

  it("security is NEVER clamped (unconditional hard FAIL preserved)", () => {
    const agg = aggregate({
      findings: [finding({ category: "security" })],
      reviewersTotal: 2,
      repUnreliable: UNRELIABLE,
      demoteCorrectness: true,
      corroborateCritical: true,
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(agg.verdict).toBe("FAIL");
  });

  it("a corroborated (majority) CRITICAL-correctness is never clamped", () => {
    const f1 = finding({ signature: "sig-2" });
    const f2 = finding({
      signature: "sig-2",
      reviewer: { provider: "gemini", model: "y", persona: "security" },
    });
    const agg = aggregate({
      findings: [f1, f2],
      reviewersTotal: 2,
      repUnreliable: new Set(["openrouter:quality", "gemini:security"]),
      demoteCorrectness: true,
      corroborateCritical: true,
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(agg.verdict).toBe("FAIL");
  });

  it("ANY unknown/uncalibrated contributor vetoes the clamp (cold-start neutrality)", () => {
    // Two same-signature findings merge; only one contributor is in repUnreliable.
    const f1 = finding({ signature: "sig-3", consensus: "singleton" });
    const f2 = finding({
      signature: "sig-3",
      reviewer: { provider: "codex", model: "y", persona: "security" },
    });
    const agg = aggregate({
      findings: [f1, f2],
      reviewersTotal: 3, // 2/3 flagged = majority would exempt anyway; keys check is defense-in-depth
      repUnreliable: UNRELIABLE, // codex:security NOT in the set
      demoteCorrectness: true,
      corroborateCritical: true,
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
  });

  it("empty/missing repUnreliable → clamp inert (fail-safe on corrupt store)", () => {
    const agg = aggregate({
      findings: [finding({})],
      reviewersTotal: 2,
      demoteCorrectness: true,
      corroborateCritical: true,
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(agg.verdict).toBe("FAIL");
  });

  it("a §4.3 pinned claimed-fixed recurrence is never clamped", () => {
    const agg = aggregate({
      findings: [finding({ signature: "sig-pin" })],
      reviewersTotal: 2,
      repUnreliable: UNRELIABLE,
      demoteCorrectness: true,
      corroborateCritical: true,
      claimedFixed: new Map([["sig-pin", 1]]),
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(agg.verdict).toBe("FAIL");
  });

  it("flag off → old behavior (lone unreliable CRITICAL-correctness stays a hard FAIL)", () => {
    const agg = aggregate({
      findings: [finding({})],
      reviewersTotal: 2,
      repUnreliable: UNRELIABLE,
      demoteCorrectness: true,
      // corroborateCritical omitted → off at the aggregator layer
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(agg.verdict).toBe("FAIL");
  });

  it("demoteCorrectness off → the correctness branch is never entered, clamp inert", () => {
    const agg = aggregate({
      findings: [finding({})],
      reviewersTotal: 2,
      repUnreliable: UNRELIABLE,
      corroborateCritical: true,
      // demoteCorrectness omitted → correctness fully exempt
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(agg.verdict).toBe("FAIL");
  });
});
