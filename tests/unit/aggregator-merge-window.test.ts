// tests/unit/aggregator-merge-window.test.ts
// Finding 1: the region/wording merge window must be tested against the IMMUTABLE
// cluster seed anchor, not the mutated representative (`sample`). The representative
// is re-pointed to the highest-severity member as a cluster grows, so testing
// membership against `sample.line_start` let the window DRIFT and made clustering
// order-dependent.
import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function fin(over: Partial<Finding>): Finding {
  return {
    id: "F-x",
    signature: "s",
    severity: "INFO",
    category: "quality",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "unrelated wording so only the region rule can merge",
    details: "d",
    reviewer: { provider: "codex", model: "gpt-5.5", persona: "security" },
    confidence: 0.5,
    consensus: "singleton",
    ...over,
  };
}

describe("aggregate — merge window anchors on the immutable seed (F-1)", () => {
  it("a far finding does NOT merge just because a higher-severity member drifted the representative", () => {
    // REGION_WINDOW = 5. Seed at line 1. A CRITICAL at line 5 merges (|5-1|=4 ≤ 5)
    // and (in the buggy version) re-points the representative to line 5; a third
    // finding at line 9 is 8 lines from the SEED (must NOT merge) but only 4 from
    // the drifted representative (would wrongly merge). With anchoring it stays a
    // separate cluster.
    const findings = [
      fin({ signature: "a", severity: "INFO", line_start: 1, message: "alpha alpha distinct one" }),
      fin({
        signature: "b",
        severity: "CRITICAL",
        line_start: 5,
        message: "beta beta distinct two",
      }),
      fin({
        signature: "c",
        severity: "INFO",
        line_start: 9,
        message: "gamma gamma distinct three",
      }),
    ];
    const r = aggregate({ findings, reviewersTotal: 1 });
    // 2 clusters: {line1, line5} and {line9}. The buggy drift would collapse to 1.
    expect(r.dedupedFindings.length).toBe(2);
    // The far finding survives as its own (advisory INFO) finding, not buried as a
    // member of the line-1 cluster.
    const lines = r.dedupedFindings.map((f) => f.line_start).sort((x, y) => x - y);
    expect(lines).toContain(9);
  });

  it("merge result is identical regardless of input order (order-independence)", () => {
    const a = fin({
      signature: "a",
      severity: "INFO",
      line_start: 1,
      message: "alpha one distinct",
    });
    const b = fin({
      signature: "b",
      severity: "CRITICAL",
      line_start: 5,
      message: "beta two distinct",
    });
    const c = fin({
      signature: "c",
      severity: "INFO",
      line_start: 9,
      message: "gamma three distinct",
    });
    const forward = aggregate({ findings: [a, b, c], reviewersTotal: 1 });
    const reverse = aggregate({ findings: [c, b, a], reviewersTotal: 1 });
    expect(reverse.dedupedFindings.length).toBe(forward.dedupedFindings.length);
    expect(forward.dedupedFindings.length).toBe(2);
  });

  it("two genuinely co-located findings (within the window of the seed) still merge", () => {
    const findings = [
      fin({ signature: "a", severity: "WARN", line_start: 10, message: "same region foo bar" }),
      fin({ signature: "b", severity: "WARN", line_start: 13, message: "same region baz qux" }),
    ];
    const r = aggregate({ findings, reviewersTotal: 1 });
    expect(r.dedupedFindings.length).toBe(1);
  });
});
