import { describe, expect, test } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

// Slice D (P5, field report 2026-06-22): a CRITICAL finding whose FILE classifies as "docs"
// is over-severity (a stale doc is not a security/data-loss bug). Cap it to WARN — NOT INFO,
// so it stays SOFT-PASS-blocking + decision-required (G0) and never auto-hides under
// softPassPolicy:"allow". Security/correctness on a doc (a leaked secret / dangerous command
// in markdown) is EXEMPT and stays CRITICAL. Keys on the FILE class (ground truth), not the
// reviewer-supplied category.
function mkFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    signature: "sig-1",
    severity: "CRITICAL",
    category: "quality",
    rule_id: "rule.x",
    file: "README.md",
    line_start: 10,
    line_end: 10,
    message: "stale plan-gate prompt text",
    details: "the prompt references a removed file",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  } as Finding;
}

describe("Slice D: docs severity cap", () => {
  test("caps a quality CRITICAL on a .md file to WARN (not a singleton FAIL) with G0 provenance", () => {
    const r = aggregate({ findings: [mkFinding()], reviewersTotal: 1, capDocsSeverity: true });
    const f = r.dedupedFindings[0];
    expect(f?.severity).toBe("WARN");
    expect(f?.docs_severity_capped).toBe(true);
    // G0: a from-CRITICAL value-judgment demote stays ≥WARN + decision-required.
    expect(f?.demoted_from_critical).toBe(true);
    // WARN not INFO → still surfaces; a lone WARN is SOFT-PASS, not a hard FAIL.
    expect(r.verdict).toBe("SOFT-PASS");
    expect(r.counts.critical).toBe(0);
    expect(r.counts.warn).toBe(1);
  });

  test("does NOT cap a security CRITICAL on a doc (leaked secret / dangerous command)", () => {
    const r = aggregate({
      findings: [
        mkFinding({ category: "security", file: "SECURITY.md", message: "hardcoded api key" }),
      ],
      reviewersTotal: 1,
      capDocsSeverity: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.dedupedFindings[0]?.docs_severity_capped).toBeUndefined();
    expect(r.verdict).toBe("FAIL");
  });

  test("does NOT cap a correctness CRITICAL on a doc", () => {
    const r = aggregate({
      findings: [mkFinding({ category: "correctness" })],
      reviewersTotal: 1,
      capDocsSeverity: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
  });

  test("does NOT cap a CRITICAL on a code file", () => {
    const r = aggregate({
      findings: [mkFinding({ file: "src/auth.ts" })],
      reviewersTotal: 1,
      capDocsSeverity: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.dedupedFindings[0]?.docs_severity_capped).toBeUndefined();
  });

  test("does NOT cap a *.md fixture UNDER tests/ (classifies as tests, not docs)", () => {
    const r = aggregate({
      findings: [mkFinding({ file: "tests/fixtures/expected.md" })],
      reviewersTotal: 1,
      capDocsSeverity: true,
    });
    // classify() checks tests BEFORE docs, so this is "tests" → the docs cap must not fire.
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.dedupedFindings[0]?.docs_severity_capped).toBeUndefined();
  });

  test("inverse-masking: a docs cluster whose member is security stays CRITICAL", () => {
    // A quality CRITICAL (representative) and a security CRITICAL that WORDING-merge into one
    // cluster (a region merge across the high-stakes boundary is blocked by N6, so similar
    // wording is required to land them in one finding). touchesSecurityOrCorrectness is
    // OR-over-members, so the cap must NOT fire — the cluster stays CRITICAL.
    const rep = mkFinding({
      id: "F-001",
      category: "quality",
      severity: "CRITICAL",
      file: "README.md",
      line_start: 10,
      message: "hardcoded credential example shown in readme documentation block",
      rule_id: "q.nit",
    });
    const secMember = mkFinding({
      id: "F-002",
      category: "security",
      severity: "CRITICAL",
      file: "README.md",
      line_start: 11,
      message: "hardcoded credential example shown in readme documentation section",
      rule_id: "sec.key",
      signature: "sig-2",
    });
    const r = aggregate({ findings: [rep, secMember], reviewersTotal: 1, capDocsSeverity: true });
    // One cluster (wording merge), rep=quality + member=security → exempt → still CRITICAL/FAIL.
    expect(r.dedupedFindings.length).toBe(1);
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.dedupedFindings[0]?.docs_severity_capped).toBeUndefined();
    expect(r.verdict).toBe("FAIL");
  });

  test("is a no-op when capDocsSeverity is absent/false", () => {
    const r = aggregate({ findings: [mkFinding()], reviewersTotal: 1 });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.dedupedFindings[0]?.docs_severity_capped).toBeUndefined();
  });
});
