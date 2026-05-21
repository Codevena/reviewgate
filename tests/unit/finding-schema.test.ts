import { describe, expect, it } from "bun:test";
import { FindingSchema } from "../../src/schemas/finding.ts";

const base = {
  id: "F-001", signature: "s", severity: "INFO", category: "quality",
  rule_id: "r", file: "a.ts", line_start: 1, line_end: 1,
  message: "m", details: "d",
  reviewer: { provider: "codex", model: "x", persona: "security" },
  confidence: 0.5, consensus: "singleton",
};

describe("FindingSchema scope_demoted", () => {
  it("accepts scope_demoted:true and defaults to absent", () => {
    expect(FindingSchema.parse({ ...base, scope_demoted: true }).scope_demoted).toBe(true);
    expect(FindingSchema.parse(base).scope_demoted).toBeUndefined();
  });
});
