// tests/unit/aggregator-claimed-fixed.test.ts
import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function fin(over: Partial<Finding>): Finding {
  return {
    id: "F",
    signature: "s",
    severity: "WARN",
    category: "quality",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  };
}

describe("aggregate claimedFixed pin (§4.3)", () => {
  it("keeps a recurrence blocking even when the critic says likely_fp, and tags it", () => {
    const f = fin({ signature: "sig-fix", severity: "WARN" });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      critic: new Map([["sig-fix", { verdict: "likely_fp" }]]),
      claimedFixed: new Map([["sig-fix", 1]]),
    });
    // Pinned: the critic demote (WARN→INFO) is skipped.
    expect(r.dedupedFindings[0]?.severity).toBe("WARN");
    expect(r.dedupedFindings[0]?.critic_verdict).toBeUndefined();
    expect(r.dedupedFindings[0]?.claimed_fixed_recurred?.iter).toBe(1);
    expect(r.verdict).toBe("FAIL"); // §4.3: singleton WARN recurrence forces FAIL, not SOFT-PASS
  });

  it("a singleton WARN recurrence forces FAIL (not SOFT-PASS), but an identical non-recurrence does not", () => {
    const recur = fin({ signature: "sig-fix", severity: "WARN" });
    const rFail = aggregate({
      findings: [recur],
      reviewersTotal: 1,
      claimedFixed: new Map([["sig-fix", 1]]),
    });
    expect(rFail.verdict).toBe("FAIL");
    expect(rFail.dedupedFindings[0]?.severity).toBe("WARN");

    const control = fin({ signature: "sig-other", severity: "WARN" });
    const rSoft = aggregate({ findings: [control], reviewersTotal: 1 });
    expect(rSoft.verdict).toBe("SOFT-PASS"); // same shape, no claimedFixed → unchanged behavior
  });

  it("detects a recurrence via a MEMBER signature and tags the earliest iter", () => {
    const rep = fin({ signature: "rep", severity: "WARN", line_start: 1, line_end: 1 });
    const mem = fin({ signature: "mem", severity: "WARN", line_start: 1, line_end: 1 });
    const r = aggregate({
      findings: [rep, mem],
      reviewersTotal: 1,
      critic: new Map([["rep", { verdict: "likely_fp" }]]),
      claimedFixed: new Map([["mem", 2]]),
    });
    expect(r.dedupedFindings).toHaveLength(1);
    expect(r.dedupedFindings[0]?.signature).toBe("rep");
    expect(r.dedupedFindings[0]?.members?.map((m) => m.signature)).toContain("mem");
    expect(r.dedupedFindings[0]?.severity).toBe("WARN");
    expect(r.dedupedFindings[0]?.claimed_fixed_recurred?.iter).toBe(2);
  });

  it("tie-break: a signature in BOTH claimedFixed AND cycleRejected → cycleRejected wins (INFO, not pinned)", () => {
    const f = fin({ signature: "both", severity: "WARN" });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      claimedFixed: new Map([["both", 1]]),
      cycleRejected: new Set(["both"]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.claimed_fixed_recurred).toBeUndefined();
    expect(r.verdict).toBe("PASS"); // demoted to INFO, not pinned → no block
  });

  it("tie-break via a MEMBER sig: claimedFixed match on a member that is ALSO cycleRejected → not pinned, not tagged", () => {
    const rep = fin({ signature: "rep", severity: "WARN", line_start: 1, line_end: 1 });
    const mem = fin({ signature: "mem", severity: "WARN", line_start: 1, line_end: 1 });
    const r = aggregate({
      findings: [rep, mem],
      reviewersTotal: 1,
      claimedFixed: new Map([["mem", 1]]),
      cycleRejected: new Set(["mem"]),
    });
    expect(r.dedupedFindings).toHaveLength(1);
    expect(r.dedupedFindings[0]?.signature).toBe("rep");
    // cycleRejected wins via the member sig → demoted to INFO and NOT tagged,
    // so no INFO finding wears a claimed_fixed_recurred badge.
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.claimed_fixed_recurred).toBeUndefined();
  });

  it("does NOT exempt scopeFindings: an out-of-diff recurrence still scope-demotes to INFO", () => {
    const f = fin({
      signature: "sig-fix",
      severity: "WARN",
      file: "a.ts",
      line_start: 100,
      line_end: 100,
    });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      claimedFixed: new Map([["sig-fix", 1]]),
      changedRanges: new Map([["a.ts", [[10, 14]] as Array<[number, number]>]]),
      scopeToDiff: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.scope_demoted).toBe(true);
    expect(r.verdict).toBe("PASS"); // INFO → no block
  });

  it("a pinned out-of-diff recurrence is scope-demoted to INFO but retains the recurrence tag", () => {
    const f = fin({
      signature: "sig-fix",
      severity: "WARN",
      file: "a.ts",
      line_start: 100,
      line_end: 100,
    });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      claimedFixed: new Map([["sig-fix", 1]]),
      changedRanges: new Map([["a.ts", [[10, 14]] as Array<[number, number]>]]),
      scopeToDiff: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.scope_demoted).toBe(true);
    expect(r.dedupedFindings[0]?.claimed_fixed_recurred?.iter).toBe(1);
  });

  it("no-op: empty/absent claimedFixed leaves findings untouched", () => {
    const f = fin({ signature: "x", severity: "WARN" });
    const r = aggregate({ findings: [f], reviewersTotal: 1 });
    expect(r.dedupedFindings[0]?.severity).toBe("WARN");
    expect(r.dedupedFindings[0]?.claimed_fixed_recurred).toBeUndefined();
  });

  it("no-op: an explicitly empty claimedFixed Map leaves findings untouched", () => {
    const f = fin({ signature: "x", severity: "WARN" });
    const r = aggregate({ findings: [f], reviewersTotal: 1, claimedFixed: new Map() });
    expect(r.dedupedFindings[0]?.severity).toBe("WARN");
    expect(r.dedupedFindings[0]?.claimed_fixed_recurred).toBeUndefined();
  });
});
