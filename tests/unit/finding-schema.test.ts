import { describe, expect, it } from "bun:test";
import { FindingSchema } from "../../src/schemas/finding.ts";

const base = {
  id: "F-001",
  signature: "s",
  severity: "INFO",
  category: "quality",
  rule_id: "r",
  file: "a.ts",
  line_start: 1,
  line_end: 1,
  message: "m",
  details: "d",
  reviewer: { provider: "codex", model: "x", persona: "security" },
  confidence: 0.5,
  consensus: "singleton",
};

describe("FindingSchema scope_demoted", () => {
  it("accepts scope_demoted:true and defaults to absent", () => {
    expect(FindingSchema.parse({ ...base, scope_demoted: true }).scope_demoted).toBe(true);
    expect(FindingSchema.parse(base).scope_demoted).toBeUndefined();
  });
});

describe("FindingSchema demoted_from_critical (G0)", () => {
  it("accepts demoted_from_critical:true at the top level and defaults to absent", () => {
    expect(
      FindingSchema.parse({ ...base, demoted_from_critical: true }).demoted_from_critical,
    ).toBe(true);
    expect(FindingSchema.parse(base).demoted_from_critical).toBeUndefined();
  });

  it("preserves demoted_from_critical on a member (not stripped by safeParse)", () => {
    const f = FindingSchema.parse({
      ...base,
      members: [
        {
          signature: "m1",
          provider: "codex",
          rule_id: "r",
          category: "quality",
          demoted_from_critical: true,
        },
      ],
    });
    expect(f.members?.[0]?.demoted_from_critical).toBe(true);
  });
});

describe("FindingSchema session_attributable (S2)", () => {
  it("accepts session_attributable:false/true and defaults to absent", () => {
    expect(FindingSchema.parse({ ...base, session_attributable: false }).session_attributable).toBe(
      false,
    );
    expect(FindingSchema.parse({ ...base, session_attributable: true }).session_attributable).toBe(
      true,
    );
    expect(FindingSchema.parse(base).session_attributable).toBeUndefined();
  });
});

describe("claimed_fixed_recurred tag", () => {
  it("accepts an optional { iter } tag with a positive iter", () => {
    const f = FindingSchema.parse({ ...base, claimed_fixed_recurred: { iter: 2 } });
    expect(f.claimed_fixed_recurred?.iter).toBe(2);
  });

  it("is optional (absent → undefined)", () => {
    expect(FindingSchema.parse(base).claimed_fixed_recurred).toBeUndefined();
  });

  it("rejects a non-positive iter", () => {
    expect(() => FindingSchema.parse({ ...base, claimed_fixed_recurred: { iter: 0 } })).toThrow();
  });
});
