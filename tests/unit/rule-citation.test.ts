// tests/unit/rule-citation.test.ts
// #6 instrumentation (field report 2026-06-17): tag + COUNT (never demote) findings that assert
// a project/house rule without a verifiable file:line citation (the F-004 class).
import { describe, expect, it } from "bun:test";
import { tagUncitedRuleClaims } from "../../src/core/rule-citation.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function f(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    signature: "s",
    severity: "WARN",
    category: "quality",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "x", persona: "security" },
    confidence: 0.8,
    consensus: "singleton",
    ...over,
  };
}
const tag = (over: Partial<Finding>) => {
  const r = tagUncitedRuleClaims([f(over)]);
  return { f: r.findings[0], count: r.uncitedCount };
};

describe("tagUncitedRuleClaims — flags uncited rule claims (#6)", () => {
  it("flags the F-004 case: 'CLAUDE.md says: DO NOT ADD ANY COMMENTS' with no citation", () => {
    const { f: out, count } = tag({
      message: "CLAUDE.md says: DO NOT ADD ANY COMMENTS unless asked",
    });
    expect(out?.rule_citation_unverified).toBe(true);
    expect(count).toBe(1);
  });

  it("flags an uncited 'house rule' claim", () => {
    const { f: out } = tag({ details: "This violates the house rule on naming." });
    expect(out?.rule_citation_unverified).toBe(true);
  });

  it("flags an uncited 'repo convention' claim", () => {
    const { f: out } = tag({ details: "The repo convention is to avoid default exports." });
    expect(out?.rule_citation_unverified).toBe(true);
  });

  it("does NOT change severity (non-demoting)", () => {
    const { f: out } = tag({ severity: "CRITICAL", message: "CLAUDE.md says no comments" });
    expect(out?.severity).toBe("CRITICAL");
  });
});

describe("tagUncitedRuleClaims — does NOT flag (#6)", () => {
  it("a rule claim WITH a file:line citation is not flagged", () => {
    const { f: out, count } = tag({
      details: "The repo convention is tabs (see CONVENTIONS.md:12).",
    });
    expect(out?.rule_citation_unverified).toBeUndefined();
    expect(count).toBe(0);
  });

  it("a rule claim citing 'line N' is not flagged", () => {
    const { f: out } = tag({ details: "CLAUDE.md line 5 forbids comments here." });
    expect(out?.rule_citation_unverified).toBeUndefined();
  });

  it("an ordinary finding with no rule assertion is not flagged", () => {
    const { f: out } = tag({ message: "Unbounded loop can overflow", details: "No base case." });
    expect(out?.rule_citation_unverified).toBeUndefined();
  });
});

describe("tagUncitedRuleClaims — counting + toggle", () => {
  it("counts only the uncited rule claims across a mixed set", () => {
    const r = tagUncitedRuleClaims([
      f({ id: "F-1", message: "CLAUDE.md says no comments" }), // uncited → count
      f({ id: "F-2", details: "Per our coding standard, see STYLE.md:9." }), // cited → no
      f({ id: "F-3", message: "Off-by-one error" }), // not a rule claim → no
      f({ id: "F-4", details: "Violates the house rule." }), // uncited → count
    ]);
    expect(r.uncitedCount).toBe(2);
    expect(r.findings.filter((x) => x.rule_citation_unverified).length).toBe(2);
  });

  it("is a no-op when disabled", () => {
    const r = tagUncitedRuleClaims([f({ message: "CLAUDE.md says no comments" })], false);
    expect(r.uncitedCount).toBe(0);
    expect(r.findings[0]?.rule_citation_unverified).toBeUndefined();
  });
});
