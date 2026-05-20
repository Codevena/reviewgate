import { describe, expect, it } from "bun:test";
import { type Finding, FindingSchema } from "../../src/schemas/finding.ts";

describe("FindingSchema", () => {
  it("accepts a minimal valid finding", () => {
    const ok: Finding = {
      id: "F-001",
      signature: "abcd1234",
      severity: "WARN",
      category: "security",
      rule_id: "sql-injection",
      file: "src/db.ts",
      line_start: 42,
      line_end: 42,
      message: "unsanitized SQL",
      details: "building SQL from string concat",
      reviewer: { provider: "codex", model: "gpt-5.4", persona: "security" },
      confidence: 0.9,
      consensus: "singleton",
    };
    expect(FindingSchema.parse(ok)).toEqual(ok);
  });

  it("rejects severity outside enum", () => {
    expect(() =>
      FindingSchema.parse({
        id: "F-001",
        signature: "x",
        severity: "HIGH",
        category: "security",
        rule_id: "x",
        file: "x",
        line_start: 1,
        line_end: 1,
        message: "x",
        details: "x",
        reviewer: { provider: "codex", model: "x", persona: "x" },
        confidence: 0.5,
        consensus: "singleton",
      }),
    ).toThrow();
  });

  it("rejects confidence out of [0,1]", () => {
    expect(() =>
      FindingSchema.parse({
        id: "F-001",
        signature: "x",
        severity: "INFO",
        category: "docs",
        rule_id: "x",
        file: "x",
        line_start: 1,
        line_end: 1,
        message: "x",
        details: "x",
        reviewer: { provider: "codex", model: "x", persona: "x" },
        confidence: 1.5,
        consensus: "singleton",
      }),
    ).toThrow();
  });

  it("accepts optional contradicts_memory field", () => {
    const f = {
      id: "F-001",
      signature: "x",
      severity: "INFO",
      category: "quality",
      rule_id: "x",
      file: "x",
      line_start: 1,
      line_end: 1,
      message: "x",
      details: "x",
      reviewer: { provider: "codex", model: "x", persona: "security" },
      confidence: 0.7,
      consensus: "singleton",
      contradicts_memory: { brain_entry_id: "be-1", reason: "this is wrong because…" },
    };
    expect(() => FindingSchema.parse(f)).not.toThrow();
  });
});
