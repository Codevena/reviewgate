import { describe, expect, it } from "bun:test";
import {
  buildDecisionOutcome,
  classifyDecision,
  normalizeProviders,
} from "../../src/core/decision-outcome.ts";
import type { DecisionEntry } from "../../src/schemas/decision.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    signature: "sig",
    severity: "CRITICAL",
    category: "correctness",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "x", persona: "p" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  } as Finding;
}

describe("classifyDecision", () => {
  it("accepted+fixed → tp", () => {
    expect(
      classifyDecision({
        schema: "reviewgate.decision.v1",
        finding_id: "F-001",
        verdict: "accepted",
        action: "fixed",
      } as DecisionEntry),
    ).toBe("tp");
  });
  it("accepted+addressed-elsewhere → tp", () => {
    expect(
      classifyDecision({
        schema: "reviewgate.decision.v1",
        finding_id: "F-001",
        verdict: "accepted",
        action: "addressed-elsewhere",
      } as DecisionEntry),
    ).toBe("tp");
  });
  it("accepted+deferred-with-followup → declined", () => {
    expect(
      classifyDecision({
        schema: "reviewgate.decision.v1",
        finding_id: "F-001",
        verdict: "accepted",
        action: "deferred-with-followup",
      } as DecisionEntry),
    ).toBe("declined");
  });
  it("accepted+acknowledged-low-value → declined", () => {
    expect(
      classifyDecision({
        schema: "reviewgate.decision.v1",
        finding_id: "F-001",
        verdict: "accepted",
        action: "acknowledged-low-value",
      } as DecisionEntry),
    ).toBe("declined");
  });
  it("rejected+reviewer_was_wrong:true → fp", () => {
    expect(
      classifyDecision({
        schema: "reviewgate.decision.v1",
        finding_id: "F-001",
        verdict: "rejected",
        reason: "x".repeat(20),
        reviewer_was_wrong: true,
      } as DecisionEntry),
    ).toBe("fp");
  });
  it("rejected without reviewer_was_wrong → declined", () => {
    expect(
      classifyDecision({
        schema: "reviewgate.decision.v1",
        finding_id: "F-001",
        verdict: "rejected",
        reason: "x".repeat(20),
      } as DecisionEntry),
    ).toBe("declined");
  });
});

describe("normalizeProviders", () => {
  it("collects reviewer + members, strips persona, dedups, sorts", () => {
    const f = finding({
      reviewer: { provider: "gemini", model: "m", persona: "p" },
      members: [
        { signature: "s1", provider: "codex", rule_id: "r", category: "correctness" },
        { signature: "s2", provider: "gemini", rule_id: "r", category: "correctness" },
        {
          signature: "s3",
          provider: "claude-code:security",
          rule_id: "r",
          category: "correctness",
        },
      ],
    });
    expect(normalizeProviders(f)).toEqual(["claude-code", "codex", "gemini"]);
  });
});

describe("buildDecisionOutcome", () => {
  it("builds a tp outcome with severity + providers", () => {
    const out = buildDecisionOutcome(
      {
        schema: "reviewgate.decision.v1",
        finding_id: "F-001",
        verdict: "accepted",
        action: "fixed",
      } as DecisionEntry,
      finding({ severity: "WARN" }),
    );
    expect(out).toEqual({
      finding_id: "F-001",
      severity: "WARN",
      bucket: "tp",
      providers: ["codex"],
    });
  });
  it("carries reviewer_was_wrong on an fp outcome", () => {
    const out = buildDecisionOutcome(
      {
        schema: "reviewgate.decision.v1",
        finding_id: "F-001",
        verdict: "rejected",
        reason: "x".repeat(20),
        reviewer_was_wrong: true,
      } as DecisionEntry,
      finding(),
    );
    expect(out.bucket).toBe("fp");
    expect(out.reviewer_was_wrong).toBe(true);
  });
});
