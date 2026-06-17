// tests/unit/aggregator-protect-high-precision.test.ts
// #4 (field report 2026-06-17): a high-track-record reviewer's blocking finding must NOT be
// silently downgraded by the SOFT demoters (critic likely_fp / confidence-floor). The
// dangerous direction is a demoted TRUE positive (F-005: a real Safari CSS bug from a 78%
// reviewer was demoted to advisory). Anti-suppression: protection only PREVENTS a demote.
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
    reviewer: { provider: "claude-code", model: "m", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  };
}
const PROTECTED = new Set(["claude-code"]);

describe("aggregate — protect high-precision reviewers (#4) — critic", () => {
  it("F-005 regression: keeps a critic-likely_fp WARN from a protected reviewer BLOCKING", () => {
    const f = fin({ signature: "sigA", severity: "WARN", category: "quality" });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      critic: new Map([["sigA", { verdict: "likely_fp" }]]),
      protectedReviewers: PROTECTED,
    });
    const out = r.dedupedFindings[0];
    expect(out?.severity).toBe("WARN");
    expect(out?.protected_high_precision).toBe(true);
    // No dismissive "likely_fp" tag → no "🧠 critic flagged as likely FP" badge.
    expect(out?.critic_verdict).not.toBe("likely_fp");
    expect(r.verdict).not.toBe("PASS");
  });

  it("still demotes a critic-likely_fp WARN from a NON-protected reviewer", () => {
    const f = fin({
      signature: "sigB",
      severity: "WARN",
      reviewer: { provider: "openrouter", model: "m", persona: "security" },
    });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      critic: new Map([["sigB", { verdict: "likely_fp" }]]),
      protectedReviewers: PROTECTED,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
  });

  it("never protects a self_refuted finding (T1 retraction wins)", () => {
    const f = fin({ signature: "sigC", severity: "WARN", self_refuted: true });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      critic: new Map([["sigC", { verdict: "likely_fp" }]]),
      protectedReviewers: PROTECTED,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.protected_high_precision).toBeUndefined();
  });

  it("back-compat: with no protectedReviewers, a likely_fp WARN still demotes", () => {
    const f = fin({ signature: "sigD", severity: "WARN" });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      critic: new Map([["sigD", { verdict: "likely_fp" }]]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
  });
});

describe("aggregate — protect high-precision reviewers (#4) — confidence floor", () => {
  it("keeps a sub-floor WARN from a protected reviewer blocking", () => {
    const f = fin({ signature: "sigE", severity: "WARN", category: "quality", confidence: 0.4 });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      confidenceFloor: 0.6,
      protectedReviewers: PROTECTED,
    });
    const out = r.dedupedFindings[0];
    expect(out?.severity).toBe("WARN");
    expect(out?.protected_high_precision).toBe(true);
    expect(out?.low_confidence).toBeUndefined();
  });

  it("still demotes a sub-floor WARN from a NON-protected reviewer", () => {
    const f = fin({
      signature: "sigF",
      severity: "WARN",
      confidence: 0.4,
      reviewer: { provider: "openrouter", model: "m", persona: "security" },
    });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      confidenceFloor: 0.6,
      protectedReviewers: PROTECTED,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.low_confidence).toBe(true);
  });
});
