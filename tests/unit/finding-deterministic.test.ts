import { describe, expect, it } from "bun:test";
import { FindingSchema } from "../../src/schemas/finding.ts";

const base = {
  id: "check-typecheck",
  signature: "check:typecheck",
  severity: "CRITICAL",
  category: "correctness",
  rule_id: "deterministic-check/typecheck",
  file: "(deterministic check: typecheck)",
  line_start: 1,
  line_end: 1,
  message: "Deterministic check failed",
  details: "tsc error TS2532",
  reviewer: { provider: "checks", model: "deterministic", persona: "checks" },
  confidence: 1,
  consensus: "singleton",
};

describe("FindingSchema deterministic flag", () => {
  it("accepts deterministic: true", () => {
    const r = FindingSchema.safeParse({ ...base, deterministic: true });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.deterministic).toBe(true);
  });
  it("defaults to undefined when omitted (back-compat)", () => {
    const r = FindingSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.deterministic).toBeUndefined();
  });
});
