// tests/unit/signature.test.ts
import { describe, expect, it } from "bun:test";
import { computeSignature } from "../../src/diff/signature.ts";

describe("computeSignature", () => {
  it("produces a 64-char sha256 hex string", () => {
    const sig = computeSignature({
      file: "src/auth.ts",
      ruleId: "sql-injection",
      category: "security",
      lineStart: 42,
      lineEnd: 42,
    });
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across small line shifts in the same 10-line bucket", () => {
    const a = computeSignature({
      file: "a.ts",
      ruleId: "r",
      category: "security",
      lineStart: 41,
      lineEnd: 41,
    });
    const b = computeSignature({
      file: "a.ts",
      ruleId: "r",
      category: "security",
      lineStart: 49,
      lineEnd: 49,
    });
    expect(a).toBe(b);
  });

  it("changes across bucket boundaries", () => {
    const a = computeSignature({
      file: "a.ts",
      ruleId: "r",
      category: "security",
      lineStart: 39,
      lineEnd: 39,
    });
    const b = computeSignature({
      file: "a.ts",
      ruleId: "r",
      category: "security",
      lineStart: 41,
      lineEnd: 41,
    });
    expect(a).not.toBe(b);
  });

  it("normalizes rule_id (lowercase, hyphen-collapse)", () => {
    const a = computeSignature({
      file: "a.ts",
      ruleId: "SQL-Injection",
      category: "security",
      lineStart: 10,
      lineEnd: 10,
    });
    const b = computeSignature({
      file: "a.ts",
      ruleId: "sql---injection",
      category: "security",
      lineStart: 10,
      lineEnd: 10,
    });
    expect(a).toBe(b);
  });

  it("changes when file changes", () => {
    const a = computeSignature({
      file: "a.ts",
      ruleId: "r",
      category: "security",
      lineStart: 10,
      lineEnd: 10,
    });
    const b = computeSignature({
      file: "b.ts",
      ruleId: "r",
      category: "security",
      lineStart: 10,
      lineEnd: 10,
    });
    expect(a).not.toBe(b);
  });

  // Bug B (found via shoal dogfooding): the rule_id is LLM-authored and drifts
  // between runs for IDENTICAL code, which destabilized the signature →
  // undermined stuck-detection + FP-ledger re-matching. normalizeRuleId must be
  // tolerant to that drift (connector words, token order, generic noise, dupes).
  const sig = (ruleId: string) =>
    computeSignature({ file: "a.ts", ruleId, category: "security", lineStart: 10, lineEnd: 10 });

  it("is stable across a connector-word drift (the verified shoal case)", () => {
    // exactly what happened: "...-via-execsync" vs "...-execsync"
    expect(sig("command-injection-via-execsync")).toBe(sig("command-injection-execsync"));
  });

  it("is order-insensitive (token reordering by the LLM)", () => {
    expect(sig("sql-injection")).toBe(sig("injection-sql"));
  });

  it("drops generic noise suffixes the LLM appends inconsistently", () => {
    expect(sig("xss-risk")).toBe(sig("xss"));
    expect(sig("path-traversal-vulnerability")).toBe(sig("path-traversal"));
  });

  it("collapses duplicate tokens and separator variants", () => {
    expect(sig("open_redirect")).toBe(sig("open-redirect"));
    expect(sig("redirect-open-redirect")).toBe(sig("open-redirect"));
  });

  it("still keeps GENUINELY different rules distinct", () => {
    expect(sig("command-injection")).not.toBe(sig("path-traversal"));
    expect(sig("sql-injection")).not.toBe(sig("xss"));
  });
});
