import { describe, expect, test } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

// Slice C (P4, field report 2026-06-22): a lone, uncorroborated, non-security/correctness
// CRITICAL on a single-reviewer panel STILL hard-FAILs (PR#22 — preserved exactly, zero
// regression), but is tagged `lone_critical_uncorroborated` so the report can frame it
// honestly ("single reviewer, verify the cited code yourself") instead of presenting it as
// fully-corroborated truth. Render-only: the verdict math is UNCHANGED.
function mkFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    signature: "sig-1",
    severity: "CRITICAL",
    category: "quality",
    rule_id: "rule.x",
    file: "src/foo.ts",
    line_start: 10,
    line_end: 10,
    message: "questionable lone call",
    details: "a single reviewer's CRITICAL",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  } as Finding;
}

describe("Slice C: lone-CRITICAL honest framing (annotate, don't downgrade)", () => {
  test("1 reviewer + non-sec/corr CRITICAL → FAIL (PR#22 unchanged) + tagged lone", () => {
    const r = aggregate({ findings: [mkFinding()], reviewersTotal: 1 });
    expect(r.verdict).toBe("FAIL"); // PR#22 regression guard
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.dedupedFindings[0]?.lone_critical_uncorroborated).toBe(true);
  });

  test("does NOT tag a security CRITICAL (it blocks as a full security finding)", () => {
    const r = aggregate({ findings: [mkFinding({ category: "security" })], reviewersTotal: 1 });
    expect(r.verdict).toBe("FAIL");
    expect(r.dedupedFindings[0]?.lone_critical_uncorroborated).toBeUndefined();
  });

  test("does NOT tag a correctness CRITICAL", () => {
    const r = aggregate({ findings: [mkFinding({ category: "correctness" })], reviewersTotal: 1 });
    expect(r.dedupedFindings[0]?.lone_critical_uncorroborated).toBeUndefined();
  });

  test("does NOT tag a cluster whose merged member is security (OR-over-members)", () => {
    const rep = mkFinding({
      id: "F-001",
      category: "quality",
      message: "hardcoded credential example shown in source documentation block",
      rule_id: "q.nit",
    });
    const secMember = mkFinding({
      id: "F-002",
      category: "security",
      line_start: 11,
      message: "hardcoded credential example shown in source documentation section",
      rule_id: "sec.key",
      signature: "sig-2",
    });
    const r = aggregate({ findings: [rep, secMember], reviewersTotal: 1 });
    expect(r.dedupedFindings.length).toBe(1);
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.dedupedFindings[0]?.lone_critical_uncorroborated).toBeUndefined();
  });

  test("does NOT tag on a MULTI-reviewer panel (singleton consensus there → SOFT-PASS)", () => {
    // reviewersTotal=2 but only one reviewer flagged it → consensus singleton → NOT a hard
    // FAIL (the consensus gate guards it), so it must not wear the lone-critical badge.
    const r = aggregate({ findings: [mkFinding()], reviewersTotal: 2 });
    expect(r.verdict).toBe("SOFT-PASS");
    expect(r.dedupedFindings[0]?.lone_critical_uncorroborated).toBeUndefined();
  });

  test("does NOT double-stamp a low-confidence CRITICAL already clamped to WARN", () => {
    // confidenceFloor clamps a low-confidence non-sec/corr CRITICAL to WARN (demoted_from_critical),
    // so it is no longer CRITICAL → the lone tag (CRITICAL-only) must not fire.
    const r = aggregate({
      findings: [mkFinding({ confidence: 0.2 })],
      reviewersTotal: 1,
      confidenceFloor: 0.6,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("WARN");
    expect(r.dedupedFindings[0]?.lone_critical_uncorroborated).toBeUndefined();
  });
});
