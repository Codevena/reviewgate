import { describe, expect, test } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function mkFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    signature: "sig-1",
    severity: "CRITICAL",
    category: "security",
    rule_id: "rule.x",
    file: "src/foo.test.ts",
    line_start: 10,
    line_end: 10,
    message: "weak password TempPass123!",
    details: "mocked return value",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  } as Finding;
}

describe("Slice 2: test-file security demote", () => {
  test("demotes a security CRITICAL on a *.test.ts file to INFO", () => {
    const r = aggregate({ findings: [mkFinding()], reviewersTotal: 1, demoteTestSecurity: true });
    const f = r.dedupedFindings[0];
    expect(f?.severity).toBe("INFO");
    expect(f?.test_severity_demoted).toBe(true);
    expect(r.verdict).not.toBe("FAIL");
  });

  test("demotes a security finding under a tests/ directory", () => {
    const r = aggregate({
      findings: [mkFinding({ file: "tests/fixtures/auth.ts" })],
      reviewersTotal: 1,
      demoteTestSecurity: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
  });

  test("does NOT demote a correctness finding on a test file", () => {
    const r = aggregate({
      findings: [mkFinding({ category: "correctness" })],
      reviewersTotal: 1,
      demoteTestSecurity: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.dedupedFindings[0]?.test_severity_demoted).toBeUndefined();
  });

  test("does NOT demote a security finding on a non-test file", () => {
    const r = aggregate({
      findings: [mkFinding({ file: "src/auth.ts" })],
      reviewersTotal: 1,
      demoteTestSecurity: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
  });

  test("is a no-op when demoteTestSecurity is absent/false", () => {
    const r = aggregate({ findings: [mkFinding()], reviewersTotal: 1 });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
  });
});
