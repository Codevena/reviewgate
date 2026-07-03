// tests/unit/aggregator-region-rejected.test.ts
//
// T3 / R4 (field report 2026-07-03): the region-rejection demote pass. The field
// treadmill: the same ~5-line region re-flagged round after round under a RENAMED
// signature (stale-effect-dependency → stale-action-param-cleanup → …), defeating
// every signature-keyed guard. Explicit union-of-rejected-categories semantics per
// the plan-gate round-3 INFO: >= 2 distinct dispositions on the REGION total (not
// per category), and EVERY member category of the new finding must be in the
// region's accumulated rejected-categories set.
import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    severity: "WARN",
    category: "correctness",
    rule_id: "action-param-race-condition", // renamed vs the rejected rule — irrelevant here
    file: "app/flashcards-content.tsx",
    line_start: 102,
    line_end: 103,
    message: "m",
    details: "d",
    reviewer: { provider: "openrouter", model: "x", persona: "quality" },
    confidence: 0.9,
    consensus: "singleton",
    signature: "sig-fresh",
    ...over,
  } as Finding;
}

type RegionInput = NonNullable<Parameters<typeof aggregate>[0]["rejectedRegions"]>[number];
function region(over: Partial<RegionInput> = {}): RegionInput {
  return {
    file: "app/flashcards-content.tsx",
    start_line: 100,
    end_line: 104,
    severity: "WARN" as const,
    categories: ["correctness" as const, "quality" as const],
    reason: "the effect cleanup already clears the action param",
    distinct_count: 2,
    ...over,
  };
}

describe("aggregator region-rejection pass (R4)", () => {
  it("demotes a same-region, category-compatible WARN to INFO at >= 2 distinct rejections", () => {
    const agg = aggregate({
      findings: [finding({})],
      reviewersTotal: 2,
      rejectedRegions: [region()],
    });
    const f = agg.dedupedFindings[0];
    expect(f?.severity).toBe("INFO");
    expect(f?.region_rejected_match).toEqual({
      distinct_count: 2,
      prior_reason: "the effect cleanup already clears the action param",
      suppressed: true,
    });
    expect(agg.verdict).toBe("PASS");
    expect(agg.regionSuppressedCount).toBe(1);
  });

  it("sliding tolerance: a finding within ±5 lines of the region still matches", () => {
    const agg = aggregate({
      findings: [finding({ line_start: 109, line_end: 109 })], // region ends 104, +5 = 109
      reviewersTotal: 2,
      rejectedRegions: [region()],
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("INFO");
  });

  it("a finding > REGION_WINDOW past the region boundary does not match", () => {
    const agg = aggregate({
      findings: [finding({ line_start: 110, line_end: 110 })],
      reviewersTotal: 2,
      rejectedRegions: [region()],
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("WARN");
    expect(agg.dedupedFindings[0]?.region_rejected_match).toBeUndefined();
  });

  it("1 distinct rejection → badge only, finding stays blocking (no self-ratchet)", () => {
    const agg = aggregate({
      findings: [finding({})],
      reviewersTotal: 2,
      rejectedRegions: [region({ distinct_count: 1 })],
    });
    const f = agg.dedupedFindings[0];
    expect(f?.severity).toBe("WARN");
    expect(f?.region_rejected_match?.suppressed).toBe(false);
    expect(agg.regionSuppressedCount).toBe(0);
  });

  it("category jump → badge only (every member category must be in the rejected set)", () => {
    const agg = aggregate({
      findings: [finding({ category: "performance" })],
      reviewersTotal: 2,
      rejectedRegions: [region()], // rejected set: correctness+quality
    });
    const f = agg.dedupedFindings[0];
    expect(f?.severity).toBe("WARN");
    expect(f?.region_rejected_match?.suppressed).toBe(false);
  });

  it("one overlapping category among several members is NOT sufficient (round-2 W2)", () => {
    const a = finding({
      signature: "sig-a",
      category: "correctness",
      message: "identical wording so the two findings region-merge here",
    });
    const b = finding({
      signature: "sig-b",
      category: "performance",
      rule_id: "other-rule",
      message: "identical wording so the two findings region-merge here",
    });
    const agg = aggregate({
      findings: [a, b],
      reviewersTotal: 2,
      rejectedRegions: [region()], // performance NOT in rejected categories
    });
    const f = agg.dedupedFindings[0];
    expect(f?.members?.length).toBe(2);
    expect(f?.severity).toBe("WARN");
    expect(f?.region_rejected_match?.suppressed).toBe(false);
  });

  it("a rejected-WARN region never suppresses a new CRITICAL (ceiling + dominance)", () => {
    const agg = aggregate({
      findings: [finding({ severity: "CRITICAL", category: "quality" })],
      reviewersTotal: 2,
      rejectedRegions: [region({ categories: ["quality" as const] })],
    });
    const f = agg.dedupedFindings[0];
    expect(f?.severity).toBe("CRITICAL");
    expect(f?.region_rejected_match?.suppressed).toBe(false);
  });

  it("security is never demoted by region memory", () => {
    const agg = aggregate({
      findings: [finding({ category: "security" })],
      reviewersTotal: 2,
      rejectedRegions: [region({ categories: ["security" as const, "correctness" as const] })],
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("WARN"); // unchanged (its own severity)
    expect(agg.dedupedFindings[0]?.region_rejected_match?.suppressed).toBe(false);
    expect(agg.regionSuppressedCount).toBe(0);
  });

  it("a demoted_from_critical WARN stays decision-required (G0 outranks R4)", () => {
    const agg = aggregate({
      findings: [finding({ demoted_from_critical: true, category: "quality" })],
      reviewersTotal: 2,
      rejectedRegions: [region({ categories: ["quality" as const] })],
    });
    const f = agg.dedupedFindings[0];
    expect(f?.severity).toBe("WARN");
    expect(f?.demoted_from_critical).toBe(true);
    expect(f?.region_rejected_match?.suppressed).toBe(false);
  });

  it("a §4.3 claimed-fixed recurrence is never region-suppressed", () => {
    const agg = aggregate({
      findings: [finding({ signature: "sig-pin" })],
      reviewersTotal: 2,
      rejectedRegions: [region()],
      claimedFixed: new Map([["sig-pin", 1]]),
    });
    const f = agg.dedupedFindings[0];
    // The claimed-fixed pin keeps it blocking; region pass must not touch it.
    expect(f?.severity).not.toBe("INFO");
    expect(f?.region_rejected_match).toBeUndefined();
  });

  it("a finding without line data is untouched (fail-safe)", () => {
    const agg = aggregate({
      findings: [finding({ line_start: 0 as unknown as number })],
      reviewersTotal: 2,
      rejectedRegions: [region({ start_line: 0, end_line: 200 })],
    });
    // line_start 0 is falsy-typed here; the pass requires usable line data.
    expect(agg.dedupedFindings[0]?.region_rejected_match).toBeUndefined();
  });

  it("no rejectedRegions input → byte-identical passthrough (flag off)", () => {
    const withRegions = aggregate({ findings: [finding({})], reviewersTotal: 2 });
    expect(withRegions.dedupedFindings[0]?.severity).toBe("WARN");
    expect(withRegions.dedupedFindings[0]?.region_rejected_match).toBeUndefined();
    expect(withRegions.regionSuppressedCount).toBe(0);
  });

  it("wrong file never matches", () => {
    const agg = aggregate({
      findings: [finding({ file: "app/other.tsx" })],
      reviewersTotal: 2,
      rejectedRegions: [region()],
    });
    expect(agg.dedupedFindings[0]?.region_rejected_match).toBeUndefined();
  });
});
