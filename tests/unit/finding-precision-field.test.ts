// tests/unit/finding-precision-field.test.ts
import { describe, expect, it } from "bun:test";
import { FindingSchema } from "../../src/schemas/finding.ts";

const base = {
  id: "F-001",
  signature: "sig1",
  severity: "CRITICAL" as const,
  category: "security" as const,
  rule_id: "r",
  file: "src/db.ts",
  line_start: 1,
  line_end: 1,
  message: "m",
  details: "d",
  reviewer: { provider: "codex", model: "m", persona: "security" },
  confidence: 0.9,
  consensus: "singleton" as const,
};

describe("FindingSchema reviewer_precision (#8)", () => {
  it("accepts a finding WITH reviewer_precision", () => {
    const parsed = FindingSchema.parse({
      ...base,
      reviewer_precision: [{ provider: "codex", tp: 22, fp: 3, precision: 0.88 }],
    });
    expect(parsed.reviewer_precision?.[0]?.provider).toBe("codex");
  });

  it("accepts a null precision (zero-sample) entry", () => {
    const parsed = FindingSchema.parse({
      ...base,
      reviewer_precision: [{ provider: "gemini", tp: 0, fp: 0, precision: null }],
    });
    expect(parsed.reviewer_precision?.[0]?.precision).toBeNull();
  });

  it("accepts a finding WITHOUT the field (optional)", () => {
    expect(FindingSchema.parse(base).reviewer_precision).toBeUndefined();
  });
});
