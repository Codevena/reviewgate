import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function f(over: Partial<Finding>): Finding {
  return {
    id: "F",
    signature: "sigX",
    severity: "CRITICAL",
    category: "quality",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "x", persona: "security" },
    confidence: 0.9,
    consensus: "unanimous",
    ...over,
  } as Finding;
}

describe("aggregate fp-ledger demote", () => {
  it("demotes a finding whose signature matches an active FP entry", () => {
    const r = aggregate({
      findings: [f({ signature: "sigX" })],
      reviewersTotal: 1,
      fpActive: new Map([["sigX", { id: "FP-001" }]]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.fp_ledger_match?.suppressed).toBe(true);
    expect(r.dedupedFindings[0]?.fp_ledger_match?.pattern_id).toBe("FP-001");
    expect(r.verdict).not.toBe("FAIL");
  });
  it("leaves non-matching findings blocking", () => {
    const r = aggregate({
      findings: [f({ signature: "other" })],
      reviewersTotal: 1,
      fpActive: new Map([["sigX", { id: "FP-001" }]]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
  });

  it("matched_count reflects how many of the cluster's signatures matched", () => {
    // Two findings at the same location cluster into one — the merged finding's
    // members carry BOTH signatures; both are active FPs → matched_count 2.
    const r = aggregate({
      findings: [
        f({ signature: "sigX", rule_id: "a-rule", message: "alpha issue", line_start: 1 }),
        f({
          signature: "sigY",
          rule_id: "b-rule",
          message: "beta issue",
          line_start: 1,
          reviewer: { provider: "gemini", model: "x", persona: "architecture" },
        }),
      ],
      reviewersTotal: 2,
      fpActive: new Map([
        ["sigX", { id: "FP-001" }],
        ["sigY", { id: "FP-002" }],
      ]),
    });
    expect(r.dedupedFindings).toHaveLength(1); // clustered
    expect(r.dedupedFindings[0]?.fp_ledger_match?.matched_count).toBe(2);
    // pattern_id = the representative's matching entry (rule "a-rule" sorts first)
    expect(r.dedupedFindings[0]?.fp_ledger_match?.pattern_id).toBe("FP-001");
  });
});
