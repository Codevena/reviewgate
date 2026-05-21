import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function f(over: Partial<Finding>): Finding {
  return {
    id: "F",
    signature: `${over.file ?? "a.ts"}:${over.line_start ?? 5}`,
    severity: "CRITICAL",
    category: "security",
    rule_id: "r",
    file: "a.ts",
    line_start: 5,
    line_end: 5,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "x", persona: "security" },
    confidence: 0.9,
    consensus: "unanimous",
    ...over,
  } as Finding;
}

const changedRanges = new Map([["a.ts", [[10, 14]] as Array<[number, number]>]]);

describe("aggregate scopeToDiff", () => {
  it("keeps a finding whose range overlaps a changed hunk", () => {
    const r = aggregate({
      findings: [f({ line_start: 11, line_end: 11 })],
      reviewersTotal: 1,
      changedRanges,
      scopeToDiff: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.dedupedFindings[0]?.scope_demoted).toBeUndefined();
    expect(r.verdict).toBe("FAIL");
  });

  it("demotes an out-of-diff finding to INFO and does not FAIL", () => {
    const r = aggregate({
      findings: [f({ line_start: 50, line_end: 50 })],
      reviewersTotal: 1,
      changedRanges,
      scopeToDiff: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.scope_demoted).toBe(true);
    expect(r.verdict).not.toBe("FAIL");
  });

  it("keeps findings when scopeToDiff is false", () => {
    const r = aggregate({
      findings: [f({ line_start: 50, line_end: 50 })],
      reviewersTotal: 1,
      changedRanges,
      scopeToDiff: false,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
  });

  it("keeps a finding on a file not present in changedRanges (conservative)", () => {
    const r = aggregate({
      findings: [f({ file: "other.ts", line_start: 99 })],
      reviewersTotal: 1,
      changedRanges,
      scopeToDiff: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
  });
});
