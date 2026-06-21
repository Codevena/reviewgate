// tests/unit/aggregator-confidence.test.ts
// Phase 4 #7 — `confidence` was parsed into every Finding but NEVER used in the
// verdict: a 0.2-confidence finding blocked exactly as hard as a 0.99 one. Wire
// it as a demotion signal — a low-confidence, uncorroborated finding becomes
// advisory (INFO) instead of blocking, EXCEPT a CRITICAL security/correctness
// finding (always blocking, mirroring the critic carve-out).
import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function f(over: Partial<Finding>): Finding {
  return {
    id: "F",
    signature: "sigX",
    severity: "WARN",
    category: "quality",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "x", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  } as Finding;
}

describe("aggregate confidence demote", () => {
  it("demotes a low-confidence, uncorroborated WARN to INFO (advisory, non-blocking)", () => {
    const r = aggregate({
      findings: [f({ severity: "WARN", confidence: 0.2, consensus: "singleton" })],
      reviewersTotal: 1,
      confidenceFloor: 0.5,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.low_confidence).toBe(true);
    expect(r.verdict).not.toBe("FAIL");
  });

  it("keeps a finding AT or ABOVE the floor blocking", () => {
    const r = aggregate({
      findings: [f({ severity: "WARN", confidence: 0.5, consensus: "majority" })],
      reviewersTotal: 2,
      confidenceFloor: 0.5,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("WARN");
    expect(r.dedupedFindings[0]?.low_confidence).toBeUndefined();
  });

  it("does NOT demote a CRITICAL security finding even at low confidence", () => {
    const r = aggregate({
      findings: [
        f({ severity: "CRITICAL", category: "security", confidence: 0.1, consensus: "singleton" }),
      ],
      reviewersTotal: 1,
      confidenceFloor: 0.5,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.verdict).toBe("FAIL");
  });

  it("G0: clamps a low-confidence non-security CRITICAL to WARN (not INFO) + stamps demoted_from_critical", () => {
    const r = aggregate({
      findings: [
        f({ severity: "CRITICAL", category: "quality", confidence: 0.1, consensus: "singleton" }),
      ],
      reviewersTotal: 2,
      confidenceFloor: 0.5,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("WARN");
    expect(r.dedupedFindings[0]?.demoted_from_critical).toBe(true);
    expect(r.dedupedFindings[0]?.low_confidence).toBe(true);
    expect(r.verdict).toBe("SOFT-PASS");
  });

  it("G0: clamps a from-CRITICAL WARN below the floor at WARN (not INFO)", () => {
    const r = aggregate({
      findings: [
        f({
          severity: "WARN",
          category: "quality",
          confidence: 0.1,
          consensus: "singleton",
          demoted_from_critical: true,
        }),
      ],
      reviewersTotal: 2,
      confidenceFloor: 0.5,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("WARN");
    expect(r.dedupedFindings[0]?.demoted_from_critical).toBe(true);
  });

  it("does NOT demote a corroborated (majority/unanimous) low-confidence finding", () => {
    // Two reviewers independently reported it → consensus overrides one reviewer's
    // low self-rated confidence.
    const r = aggregate({
      findings: [
        f({
          signature: "s",
          confidence: 0.2,
          reviewer: { provider: "codex", model: "x", persona: "security" },
        }),
        f({
          signature: "s",
          confidence: 0.2,
          reviewer: { provider: "gemini", model: "y", persona: "arch" },
        }),
      ],
      reviewersTotal: 2,
      confidenceFloor: 0.5,
    });
    const consensus = r.dedupedFindings[0]?.consensus;
    expect(consensus === "majority" || consensus === "unanimous").toBe(true);
    expect(r.dedupedFindings[0]?.severity).toBe("WARN");
    expect(r.dedupedFindings[0]?.low_confidence).toBeUndefined();
  });

  it("keeps a co-located security CRITICAL blocking while the low-confidence quality finding demotes separately (N6)", () => {
    // N6: a security concern and a co-located cosmetic one are NOT merged across the
    // high-stakes boundary, so the security CRITICAL is its OWN finding (never
    // confidence-demoted), while the low-confidence quality CRITICAL demotes on its own.
    const r = aggregate({
      findings: [
        f({
          severity: "CRITICAL",
          category: "quality",
          rule_id: "a-quality",
          message: "magic number here",
          line_start: 1,
          confidence: 0.1,
          signature: "sq",
        }),
        f({
          severity: "CRITICAL",
          category: "security",
          rule_id: "z-security",
          message: "sql injection risk",
          line_start: 1,
          confidence: 0.1,
          signature: "ss",
        }),
      ],
      reviewersTotal: 1,
      confidenceFloor: 0.5,
    });
    expect(r.dedupedFindings.length).toBe(2); // not merged across the stakes boundary
    const sec = r.dedupedFindings.find((x) => x.category === "security");
    const qual = r.dedupedFindings.find((x) => x.category === "quality");
    expect(sec?.severity).toBe("CRITICAL"); // security CRITICAL is never confidence-demoted
    expect(qual?.severity).not.toBe("CRITICAL"); // the quality nit demotes on its own low confidence
    expect(qual?.low_confidence).toBe(true);
    expect(r.verdict).toBe("FAIL"); // the security concern still blocks
  });

  it("does NOT demote a cluster when a co-located MEMBER has high confidence", () => {
    // A low-confidence WARN representative merges with a high-confidence WARN
    // member at the same line. The cluster's confidence is the MAX across members,
    // so the high-confidence member must keep the cluster blocking (not masked by
    // the representative's low self-rating).
    const r = aggregate({
      findings: [
        f({
          severity: "WARN",
          rule_id: "a-rule",
          message: "alpha issue at this spot",
          line_start: 1,
          confidence: 0.1,
          signature: "a",
        }),
        f({
          severity: "WARN",
          rule_id: "b-rule",
          message: "alpha issue at this spot too",
          line_start: 1,
          confidence: 0.95,
          signature: "b",
        }),
      ],
      reviewersTotal: 1,
      confidenceFloor: 0.5,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("WARN"); // high-conf member keeps it blocking
    expect(r.dedupedFindings[0]?.low_confidence).toBeUndefined();
  });

  it("verdict FAILs a CRITICAL cluster whose security concern is a MEMBER (reviewersTotal>1)", () => {
    // A CRITICAL quality representative + CRITICAL security member, 2 reviewers,
    // consensus singleton. The verdict's security/correctness auto-FAIL must
    // consider member categories — else this dangerous finding silently PASSes.
    const r = aggregate({
      findings: [
        f({
          severity: "CRITICAL",
          category: "quality",
          rule_id: "a-quality",
          message: "magic number",
          line_start: 1,
          confidence: 0.9,
          signature: "q",
        }),
        f({
          severity: "CRITICAL",
          category: "security",
          rule_id: "z-security",
          message: "sql injection",
          line_start: 1,
          confidence: 0.9,
          signature: "s",
        }),
      ],
      reviewersTotal: 2,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.verdict).toBe("FAIL");
  });

  it("keeps a co-located correctness CRITICAL blocking when the critic flags a sibling quality finding (N6)", () => {
    // N6: the correctness concern and the cosmetic one are NOT merged across the
    // high-stakes boundary, so a critic likely_fp on the quality finding cannot drag
    // the correctness CRITICAL down — the latter is its own finding, exempt from demote.
    const r = aggregate({
      findings: [
        f({
          severity: "CRITICAL",
          category: "quality",
          rule_id: "a-quality",
          message: "magic number",
          line_start: 1,
          signature: "q",
        }),
        f({
          severity: "CRITICAL",
          category: "correctness",
          rule_id: "z-correct",
          message: "off by one",
          line_start: 1,
          signature: "c",
        }),
      ],
      reviewersTotal: 2,
      critic: new Map([["q", { verdict: "likely_fp" as const }]]),
    });
    expect(r.dedupedFindings.length).toBe(2); // not merged across the stakes boundary
    const corr = r.dedupedFindings.find((x) => x.category === "correctness");
    expect(corr?.severity).toBe("CRITICAL"); // correctness CRITICAL exempt from critic demote
    expect(r.verdict).toBe("FAIL");
  });

  it("no floor (or 0) → confidence is NOT used (back-compat: a 0.1 WARN still blocks)", () => {
    const r = aggregate({
      findings: [f({ severity: "WARN", confidence: 0.1, consensus: "singleton" })],
      reviewersTotal: 1,
      // confidenceFloor omitted
    });
    expect(r.dedupedFindings[0]?.severity).toBe("WARN");
    expect(r.dedupedFindings[0]?.low_confidence).toBeUndefined();
  });
});
