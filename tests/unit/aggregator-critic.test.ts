// tests/unit/aggregator-critic.test.ts
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
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.5,
    consensus: "singleton",
    ...over,
  };
}

describe("aggregate with critic", () => {
  it("demotes a likely_fp WARN singleton to INFO -> PASS", () => {
    const f = fin({ signature: "sigA", severity: "WARN", category: "quality" });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      critic: new Map([["sigA", { verdict: "likely_fp" }]]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.verdict).toBe("PASS");
  });

  it("never demotes a CRITICAL security finding even if critic says likely_fp", () => {
    const f = fin({ signature: "sigB", severity: "CRITICAL", category: "security" });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      critic: new Map([["sigB", { verdict: "likely_fp" }]]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.verdict).toBe("FAIL");
  });

  it("never demotes a MAJORITY-agreed WARN (corroborated FAIL must not flip to SOFT-PASS)", () => {
    // 2 of 3 reviewers flag the same location → consensus "majority". The critic
    // (a single adversary) must not be able to demote a finding the group
    // corroborated — same protection unanimous already gets, and that the
    // confidence- and reputation-demote tiers already grant to majority.
    const a = fin({
      signature: "sigMaj",
      severity: "WARN",
      category: "correctness",
      reviewer: { provider: "codex", model: "m", persona: "security" },
    });
    const b = fin({
      signature: "sigMaj",
      severity: "WARN",
      category: "correctness",
      reviewer: { provider: "gemini", model: "m", persona: "architecture" },
    });
    const r = aggregate({
      findings: [a, b],
      reviewersTotal: 3,
      critic: new Map([["sigMaj", { verdict: "likely_fp" }]]),
    });
    expect(r.dedupedFindings[0]?.consensus).toBe("majority");
    expect(r.dedupedFindings[0]?.severity).toBe("WARN");
    expect(r.verdict).toBe("FAIL");
  });

  it("applies a critic likely_fp keyed on a MEMBER signature (not just the representative)", () => {
    // Two reports cluster into one finding; the representative carries sig-rep,
    // the merged member carries sig-mem. A critic verdict keyed on the MEMBER
    // signature must still demote (mirrors the fp_ledger_match member scan) —
    // otherwise a likely_fp that the critic pinned to the merged wording leaks
    // through with full blocking weight.
    const rep = fin({
      signature: "sig-rep",
      severity: "WARN",
      category: "quality",
      line_start: 1,
      line_end: 1,
      reviewer: { provider: "codex", model: "m", persona: "security" },
    });
    const mem = fin({
      signature: "sig-mem",
      severity: "WARN",
      category: "quality",
      line_start: 1,
      line_end: 1,
      reviewer: { provider: "codex", model: "m", persona: "security" },
    });
    const r = aggregate({
      findings: [rep, mem],
      reviewersTotal: 1,
      critic: new Map([["sig-mem", { verdict: "likely_fp" }]]),
    });
    expect(r.dedupedFindings).toHaveLength(1);
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.critic_verdict).toBe("likely_fp");
  });

  it("counts a dropped INFO likely_fp in criticDroppedCount (observability not lost)", () => {
    // DEMOTE[INFO] === "drop", so a likely_fp INFO is removed entirely and never
    // appears in dedupedFindings — the `demoted` metric (which filters
    // dedupedFindings) silently undercounts it. The aggregate must report the
    // drop so the observability number reflects the critic's real activity.
    const f = fin({ signature: "sigDrop", severity: "INFO", category: "quality" });
    const r = aggregate({
      findings: [f],
      reviewersTotal: 1,
      critic: new Map([["sigDrop", { verdict: "likely_fp" }]]),
    });
    expect(r.dedupedFindings).toHaveLength(0); // dropped
    expect(r.criticDroppedCount).toBe(1);
  });

  it("never demotes a unanimous-panel finding", () => {
    const a = fin({
      signature: "sigC",
      severity: "WARN",
      reviewer: { provider: "codex", model: "m", persona: "security" },
    });
    const b = fin({
      signature: "sigC",
      severity: "WARN",
      reviewer: { provider: "gemini", model: "m", persona: "architecture" },
    });
    const c = fin({
      signature: "sigC",
      severity: "WARN",
      reviewer: { provider: "claude-code", model: "m", persona: "adversarial" },
    });
    const r = aggregate({
      findings: [a, b, c],
      reviewersTotal: 3,
      critic: new Map([["sigC", { verdict: "likely_fp" }]]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("WARN");
    expect(r.dedupedFindings[0]?.consensus).toBe("unanimous");
  });
});
