// tests/unit/aggregator.test.ts
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
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "gpt-5.5", persona: "security" },
    confidence: 0.5,
    consensus: "singleton",
    ...over,
  };
}

describe("aggregate", () => {
  it("empty findings → PASS", () => {
    const r = aggregate({ findings: [], reviewersTotal: 1 });
    expect(r.verdict).toBe("PASS");
    expect(r.counts).toEqual({ critical: 0, warn: 0, info: 0 });
  });

  it("only INFO → PASS", () => {
    const r = aggregate({ findings: [fin({ severity: "INFO" })], reviewersTotal: 1 });
    expect(r.verdict).toBe("PASS");
  });

  it("single WARN with one reviewer → SOFT-PASS (singleton/minority)", () => {
    const r = aggregate({
      findings: [fin({ severity: "WARN", category: "quality" })],
      reviewersTotal: 1,
    });
    expect(r.verdict).toBe("SOFT-PASS");
  });

  it("CRITICAL security → FAIL regardless of consensus", () => {
    const r = aggregate({
      findings: [fin({ severity: "CRITICAL", category: "security" })],
      reviewersTotal: 1,
    });
    expect(r.verdict).toBe("FAIL");
  });

  it("CRITICAL architecture from the SOLE reviewer → FAIL (single-reviewer panel honours it)", () => {
    // The codex-capped → single-fallback reality: a lone reviewer's CRITICAL must
    // block, not SOFT-PASS, since `singleton` is the max consensus possible.
    const r = aggregate({
      findings: [fin({ severity: "CRITICAL", category: "architecture", consensus: "singleton" })],
      reviewersTotal: 1,
    });
    expect(r.verdict).toBe("FAIL");
  });

  it("CRITICAL architecture flagged by ONE of several reviewers → NOT FAIL (anti-FP preserved)", () => {
    // With a real multi-reviewer panel, one reviewer's lone CRITICAL outside
    // security/correctness should NOT hard-block (the others didn't corroborate it).
    const r = aggregate({
      findings: [fin({ severity: "CRITICAL", category: "architecture", consensus: "minority" })],
      reviewersTotal: 3,
    });
    expect(r.verdict).not.toBe("FAIL");
  });

  it("singleton non-security CRITICAL on a multi-reviewer panel → SOFT-PASS, never PASS (F-06)", () => {
    // A non-failing CRITICAL must at least feed the SOFT-PASS tier — otherwise it
    // is strictly weaker than a lone WARN (severity inversion) and softPassPolicy
    // never sees it.
    const r = aggregate({
      findings: [fin({ severity: "CRITICAL", category: "architecture" })],
      reviewersTotal: 3,
    });
    expect(r.verdict).toBe("SOFT-PASS");
    expect(r.counts).toEqual({ critical: 1, warn: 0, info: 0 });
  });

  it("multi-category masking warning survives the 2000-char details cap (F-08)", () => {
    // Representative's details are already AT the schema cap; the merged-categories
    // warning (and the other reviewers' wordings) must still survive — truncate the
    // original, never the note (same invariant as the demote paths).
    const a = fin({
      severity: "CRITICAL",
      category: "security",
      file: "cap.ts",
      line_start: 5,
      line_end: 5,
      rule_id: "hardcoded-secret",
      message: "hardcoded secret committed in source",
      details: "x".repeat(2000),
      reviewer: { provider: "codex", model: "m", persona: "security" },
    });
    const b = fin({
      severity: "WARN",
      category: "quality",
      file: "cap.ts",
      line_start: 5,
      line_end: 5,
      rule_id: "exposed-credential",
      message: "hardcoded secret in source code",
      reviewer: { provider: "gemini", model: "m", persona: "architecture" },
    });
    const r = aggregate({ findings: [a, b], reviewersTotal: 2 });
    expect(r.dedupedFindings.length).toBe(1);
    // biome-ignore lint/style/noNonNullAssertion: test asserts presence
    const merged = r.dedupedFindings[0]!;
    expect(merged.details.length).toBeLessThanOrEqual(2000);
    expect(merged.details).toContain("merges concerns categorized as");
    expect(merged.details).toContain("Also reported by other reviewers");
  });

  it("signatures dedupe and accumulate confirmed_by", () => {
    const f1 = fin({
      id: "F-1",
      signature: "shared",
      severity: "WARN",
      reviewer: { provider: "codex", model: "g", persona: "security" },
    });
    const f2 = fin({
      id: "F-2",
      signature: "shared",
      severity: "WARN",
      reviewer: { provider: "gemini", model: "g", persona: "architecture" },
    });
    const r = aggregate({ findings: [f1, f2], reviewersTotal: 2 });
    expect(r.dedupedFindings.length).toBe(1);
    // biome-ignore lint/style/noNonNullAssertion: test asserts presence
    expect(r.dedupedFindings[0]!.confirmed_by?.length).toBe(2);
    // biome-ignore lint/style/noNonNullAssertion: test asserts presence
    expect(r.dedupedFindings[0]!.consensus).toBe("majority");
  });

  it("merges the SAME bug reported by different reviewers with DIFFERENT rule_ids", () => {
    // Three reviewers flag the hardcoded secret on the same line, each with its
    // own rule_id and wording → must collapse to ONE finding (one decision).
    const a = fin({
      severity: "CRITICAL",
      category: "security",
      file: "x.ts",
      line_start: 5,
      line_end: 5,
      rule_id: "hardcoded-secret",
      message: "secret in source",
      reviewer: { provider: "codex", model: "m", persona: "security" },
    });
    const b = fin({
      severity: "CRITICAL",
      category: "security",
      file: "x.ts",
      line_start: 5,
      line_end: 5,
      rule_id: "secret-leak",
      message: "API key committed",
      reviewer: { provider: "openrouter", model: "m", persona: "security" },
    });
    const c = fin({
      severity: "WARN",
      category: "security",
      file: "x.ts",
      line_start: 5,
      line_end: 5,
      rule_id: "exposed-credential",
      message: "credential exposure",
      reviewer: { provider: "gemini", model: "m", persona: "architecture" },
    });
    const r = aggregate({ findings: [a, b, c], reviewersTotal: 3 });
    expect(r.dedupedFindings.length).toBe(1); // one bug, not three
    // biome-ignore lint/style/noNonNullAssertion: test asserts presence
    const merged = r.dedupedFindings[0]!;
    expect(merged.severity).toBe("CRITICAL"); // highest severity wins
    expect(merged.confirmed_by?.length).toBe(3); // all three reviewers
    expect(merged.consensus).toBe("unanimous");
    expect(merged.details).toContain("Also reported"); // other wordings preserved
  });

  it("merges near-identically WORDED findings across different line regions/categories", () => {
    // Same bug, different reviewers, DIFFERENT lines + categories, but very
    // similar wording → the lexical-similarity merge collapses them.
    const a = fin({
      severity: "CRITICAL",
      category: "security",
      file: "y.ts",
      line_start: 5,
      line_end: 5,
      rule_id: "hardcoded-secret",
      message: "hardcoded secret committed in source",
      reviewer: { provider: "codex", model: "m", persona: "security" },
    });
    const b = fin({
      severity: "WARN",
      category: "quality",
      file: "y.ts",
      line_start: 30,
      line_end: 30,
      rule_id: "exposed-credential",
      message: "hardcoded secret in source code",
      reviewer: { provider: "gemini", model: "m", persona: "architecture" },
    });
    const r = aggregate({ findings: [a, b], reviewersTotal: 2 });
    expect(r.dedupedFindings.length).toBe(1);
    // biome-ignore lint/style/noNonNullAssertion: test asserts presence
    expect(r.dedupedFindings[0]!.severity).toBe("CRITICAL");
    // biome-ignore lint/style/noNonNullAssertion: test asserts presence
    expect(r.dedupedFindings[0]!.confirmed_by?.length).toBe(2);
  });

  it("does NOT region-merge a correctness bug with a co-located cosmetic nit (N6)", () => {
    // A real bug and a cosmetic nit land on the same line, differently worded. The
    // region-merge would bundle them under ONE finding + ONE decision, inflating the
    // nit to the bug's CRITICAL. N6 keeps them separate. (The wording-similarity dedup
    // path for genuine cross-category duplicates is unaffected — see the test above.)
    const bug = fin({
      severity: "CRITICAL",
      category: "correctness",
      file: "Widget.tsx",
      line_start: 10,
      line_end: 10,
      rule_id: "height-collapse",
      message: "ResponsiveContainer height 100% collapses to zero on mobile",
      reviewer: { provider: "codex", model: "m", persona: "security" },
    });
    const nit = fin({
      severity: "WARN",
      category: "quality",
      file: "Widget.tsx",
      line_start: 10,
      line_end: 10,
      rule_id: "indent",
      message: "inconsistent indentation here",
      reviewer: { provider: "codex", model: "m", persona: "security" },
    });
    const r = aggregate({ findings: [bug, nit], reviewersTotal: 1 });
    expect(r.dedupedFindings.length).toBe(2);
    const cosmetic = r.dedupedFindings.find((f) => f.category === "quality");
    // biome-ignore lint/style/noNonNullAssertion: test asserts presence
    expect(cosmetic!.severity).toBe("WARN"); // not inflated to the bug's CRITICAL
    const real = r.dedupedFindings.find((f) => f.category === "correctness");
    // biome-ignore lint/style/noNonNullAssertion: test asserts presence
    expect(real!.severity).toBe("CRITICAL");
  });

  it("STILL region-merges two co-located findings of the SAME stakes class (N6 regression)", () => {
    // Two correctness findings on the same line (both high-stakes), differently worded
    // → still ONE finding (genuine dedup of the same concern is preserved).
    const a = fin({
      severity: "CRITICAL",
      category: "correctness",
      file: "calc.ts",
      line_start: 7,
      line_end: 7,
      rule_id: "off-by-one",
      message: "loop overruns the array bound",
      reviewer: { provider: "codex", model: "m", persona: "security" },
    });
    const b = fin({
      severity: "WARN",
      category: "correctness",
      file: "calc.ts",
      line_start: 7,
      line_end: 7,
      rule_id: "bounds",
      message: "index may exceed the length",
      reviewer: { provider: "gemini", model: "m", persona: "architecture" },
    });
    const r = aggregate({ findings: [a, b], reviewersTotal: 2 });
    expect(r.dedupedFindings.length).toBe(1);
  });

  it("does NOT merge differently-worded findings (no masking of distinct issues)", () => {
    const a = fin({
      severity: "CRITICAL",
      category: "security",
      file: "z.ts",
      line_start: 5,
      line_end: 5,
      rule_id: "sqli",
      message: "user input string interpolation enables injection",
      reviewer: { provider: "codex", model: "m", persona: "security" },
    });
    const b = fin({
      severity: "CRITICAL",
      category: "security",
      file: "z.ts",
      line_start: 30,
      line_end: 30,
      rule_id: "no-ratelimit",
      message: "missing rate limiting allows brute force abuse",
      reviewer: { provider: "gemini", model: "m", persona: "architecture" },
    });
    const r = aggregate({ findings: [a, b], reviewersTotal: 2 });
    expect(r.dedupedFindings.length).toBe(2); // distinct issues stay separate
  });

  it("is order-independent: shuffled input yields identical clustering", () => {
    const fs = [
      fin({
        file: "a.ts",
        line_start: 5,
        severity: "CRITICAL",
        category: "security",
        rule_id: "r1",
        message: "hardcoded secret committed in source",
        reviewer: { provider: "codex", model: "m", persona: "security" },
      }),
      fin({
        file: "a.ts",
        line_start: 30,
        severity: "WARN",
        category: "quality",
        rule_id: "r2",
        message: "hardcoded secret in source code",
        reviewer: { provider: "gemini", model: "m", persona: "architecture" },
      }),
      fin({
        file: "a.ts",
        line_start: 50,
        severity: "WARN",
        category: "performance",
        rule_id: "r3",
        message: "expensive loop without memoization here",
        reviewer: { provider: "openrouter", model: "m", persona: "security" },
      }),
      fin({
        file: "b.ts",
        line_start: 1,
        severity: "INFO",
        category: "docs",
        rule_id: "r4",
        message: "missing jsdoc on exported function",
        reviewer: { provider: "claude-code", model: "m", persona: "adversarial" },
      }),
    ];
    const forward = aggregate({ findings: fs, reviewersTotal: 4 });
    const reversed = aggregate({ findings: [...fs].reverse(), reviewersTotal: 4 });
    const key = (r: ReturnType<typeof aggregate>) =>
      r.dedupedFindings
        .map((f) => `${f.severity}|${f.message}`)
        .sort()
        .join(";");
    expect(key(forward)).toBe(key(reversed));
    expect(forward.dedupedFindings.length).toBe(reversed.dedupedFindings.length);
  });

  it("keeps genuinely separate bugs (different line regions) distinct", () => {
    const sqli = fin({
      severity: "CRITICAL",
      category: "security",
      file: "x.ts",
      line_start: 3,
      line_end: 3,
      rule_id: "sqli",
    });
    const secret = fin({
      severity: "CRITICAL",
      category: "security",
      file: "x.ts",
      line_start: 40,
      line_end: 40,
      rule_id: "secret",
    });
    const r = aggregate({ findings: [sqli, secret], reviewersTotal: 2 });
    expect(r.dedupedFindings.length).toBe(2); // 3 vs 40 → different windows
  });
});
