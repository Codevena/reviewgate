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

  it("pin overrides the confidence-floor demote: a low-confidence recurrence stays blocking", () => {
    const f = fin({ signature: "sig-fix", severity: "WARN", confidence: 0.1 });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      confidenceFloor: 0.5, // 0.1 < 0.5 would normally demote an uncorroborated WARN to INFO
      claimedFixed: new Map([["sig-fix", 1]]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("WARN"); // pinned → not demoted
    expect(r.dedupedFindings[0]?.low_confidence).toBeUndefined();
    expect(r.dedupedFindings[0]?.claimed_fixed_recurred?.iter).toBe(1);
    expect(r.verdict).toBe("FAIL");
  });

  it("control: a low-confidence uncorroborated WARN WITHOUT claimedFixed demotes to INFO", () => {
    const f = fin({ signature: "sig-x", severity: "WARN", confidence: 0.1 });
    const r = aggregate({ findings: [f], reviewersTotal: 1, confidenceFloor: 0.5 });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.low_confidence).toBe(true);
  });

  it("pin overrides the reputation demote: a recurrence from an unreliable lone reviewer stays blocking", () => {
    const f = fin({
      signature: "sig-fix",
      severity: "WARN",
      category: "quality",
      reviewer: { provider: "codex", model: "m", persona: "security" },
    });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      repUnreliable: new Set(["codex:security"]),
      demoteCorrectness: true,
      claimedFixed: new Map([["sig-fix", 1]]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("WARN"); // pinned → not demoted
    expect(r.dedupedFindings[0]?.reputation_demoted).toBeUndefined();
  });

  it("control: a WARN quality singleton from an unreliable reviewer demotes to INFO (no claimedFixed)", () => {
    const f = fin({
      signature: "sig-x",
      severity: "WARN",
      category: "quality",
      reviewer: { provider: "codex", model: "m", persona: "security" },
    });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      repUnreliable: new Set(["codex:security"]),
      demoteCorrectness: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.reputation_demoted).toBe(true);
  });

  it("suppressor precedence: fpActive demotes a claimed-fixed recurrence to INFO (fp wins, documented)", () => {
    const f = fin({ signature: "sig-fix", severity: "WARN" });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      fpActive: new Map([["sig-fix", { id: "FP-001" }]]),
      claimedFixed: new Map([["sig-fix", 1]]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO"); // fp suppressor wins over the pin
    expect(r.dedupedFindings[0]?.fp_ledger_match?.suppressed).toBe(true);
    expect(r.verdict).toBe("PASS"); // INFO → no force-FAIL
  });

  it("suppressor precedence: fpActiveClusters demotes a claimed-fixed recurrence to INFO (fp-cluster wins)", () => {
    // The cluster key is `${ruleIdToken0(rule_id)}@${file}`. ruleIdToken0("ruleX")
    // returns "ruleX" (no '-' delimiter → the whole string) → key "ruleX@a.ts".
    const f = fin({ signature: "sig-fix", severity: "WARN", rule_id: "ruleX", file: "a.ts" });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      fpActiveClusters: new Map([["ruleX@a.ts", { key: "ruleX@a.ts", member_ids: ["FP-001"] }]]),
      claimedFixed: new Map([["sig-fix", 1]]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.fp_cluster_match?.suppressed).toBe(true);
  });
});
