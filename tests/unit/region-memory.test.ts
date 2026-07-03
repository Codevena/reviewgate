// tests/unit/region-memory.test.ts
//
// T3 / R4 (field report 2026-07-03): harvest + fold of cycle-scoped region
// memory. Raw dispositions are persisted; regions are DERIVED at read time
// (adversarial review 2026-07-03: write-time merging let a superseded
// disposition leave absorbed categories/severity/bounds behind).
import { describe, expect, it } from "bun:test";
import {
  foldDispositions,
  harvestDispositions,
  mergeRegions,
} from "../../src/core/region-memory.ts";
import type { DecisionEntry } from "../../src/schemas/decision.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function finding(id: string, over: Partial<Finding> = {}): Finding {
  return {
    id,
    severity: "WARN",
    category: "correctness",
    rule_id: "stale-effect-dependency",
    file: "app/flashcards-content.tsx",
    line_start: 100,
    line_end: 104,
    message: "m",
    details: "d",
    reviewer: { provider: "openrouter", model: "x", persona: "quality" },
    confidence: 0.9,
    consensus: "singleton",
    signature: `sig-${id}`,
    ...over,
  } as Finding;
}

const rejected = (
  id: string,
  reason = "verified against the code: the guard above prevents this",
): DecisionEntry =>
  ({
    schema: "reviewgate.decision.v1",
    finding_id: id,
    verdict: "rejected",
    reason,
    reviewer_was_wrong: true,
  }) as DecisionEntry;

const vna = (id: string): DecisionEntry =>
  ({
    schema: "reviewgate.decision.v1",
    finding_id: id,
    verdict: "accepted",
    action: "verified-not-applicable",
    reason: "checked CREDIT_COSTS: the key exists as a typed constant",
  }) as DecisionEntry;

const fixed = (id: string): DecisionEntry =>
  ({
    schema: "reviewgate.decision.v1",
    finding_id: id,
    verdict: "accepted",
    action: "fixed",
  }) as DecisionEntry;

describe("harvestDispositions", () => {
  it("maps rejected + verified-not-applicable to rejected, fixed to addressed", () => {
    const byId = new Map([
      ["F-001", finding("F-001")],
      ["F-002", finding("F-002", { line_start: 300, line_end: 301 })],
      ["F-003", finding("F-003", { line_start: 500 })],
    ]);
    const out = harvestDispositions([rejected("F-001"), vna("F-002"), fixed("F-003")], byId);
    expect(out.map((h) => [h.finding_id, h.disposition])).toEqual([
      ["F-001", "rejected"],
      ["F-002", "rejected"],
      ["F-003", "addressed"],
    ]);
    expect(out[0]?.reason).toContain("guard above");
  });

  it("skips unmatched decisions, findings without line data, non-region actions — and INFO findings (anti-padding)", () => {
    const byId = new Map([
      ["F-001", finding("F-001", { line_start: undefined as unknown as number })],
      ["F-002", finding("F-002")],
      ["F-003", finding("F-003", { severity: "INFO" })],
    ]);
    const ack = {
      schema: "reviewgate.decision.v1",
      finding_id: "F-002",
      verdict: "accepted",
      action: "acknowledged-low-value",
    } as DecisionEntry;
    // The agent authoring a rejection against an advisory INFO finding must not
    // count toward the >= 2 suppression bar.
    expect(
      harvestDispositions([rejected("F-001"), rejected("F-404"), ack, rejected("F-003")], byId),
    ).toEqual([]);
  });

  it("collects representative + member categories (deduped)", () => {
    const byId = new Map([
      [
        "F-001",
        finding("F-001", {
          category: "correctness",
          members: [
            { signature: "s1", provider: "openrouter", rule_id: "a", category: "correctness" },
            { signature: "s2", provider: "openrouter", rule_id: "b", category: "quality" },
          ],
        } as Partial<Finding>),
      ],
    ]);
    expect(harvestDispositions([rejected("F-001")], byId)[0]?.categories.sort()).toEqual([
      "correctness",
      "quality",
    ]);
  });
});

describe("foldDispositions", () => {
  const byId = (over: Partial<Finding> = {}) => new Map([["F-001", finding("F-001", over)]]);

  it("is idempotent across re-stops of the same iteration", () => {
    const h = harvestDispositions([rejected("F-001")], byId());
    const once = foldDispositions([], h, 1);
    const twice = foldDispositions(once, h, 1);
    expect(twice).toEqual(once);
    expect(twice.length).toBe(1);
    expect(twice[0]?.key).toBe("1:F-001");
  });

  it("supersede-safe: a rejection re-decided as fixed in the SAME iteration leaves NOTHING behind", () => {
    const first = foldDispositions(
      [],
      harvestDispositions([rejected("F-001")], byId()).filter((x) => x.disposition === "rejected"),
      1,
    );
    expect(first.length).toBe(1);
    const reconciled = foldDispositions(
      first,
      harvestDispositions([fixed("F-001")], byId()).filter((x) => x.disposition === "rejected"),
      1,
    );
    expect(reconciled).toEqual([]);
  });

  it("locks earlier iterations' records and accumulates across iterations", () => {
    const iter1 = foldDispositions([], harvestDispositions([rejected("F-001")], byId()), 1);
    const iter2 = foldDispositions(
      iter1,
      harvestDispositions(
        [rejected("F-004")],
        new Map([["F-004", finding("F-004", { line_start: 102, line_end: 103 })]]),
      ),
      2,
    );
    expect(iter2.map((d) => d.key).sort()).toEqual(["1:F-001", "2:F-004"]);
  });

  it("caps the stored reason at 200 chars", () => {
    const long = "x".repeat(500);
    const folded = foldDispositions([], harvestDispositions([rejected("F-001", long)], byId()), 1);
    expect(folded[0]?.reason.length).toBe(200);
  });
});

describe("mergeRegions", () => {
  const disp = (key: string, over: Record<string, unknown> = {}) => ({
    key,
    file: "app/flashcards-content.tsx",
    start_line: 100,
    end_line: 104,
    severity: "WARN" as const,
    categories: ["correctness" as const],
    reason: "r",
    ...over,
  });

  it("merges overlapping same-file dispositions: bounds/categories union, severity max, distinct_count", () => {
    const regions = mergeRegions([
      disp("1:F-001"),
      disp("1:F-002", {
        start_line: 107,
        end_line: 108,
        severity: "CRITICAL" as const,
        categories: ["quality" as const],
      }),
    ]);
    expect(regions.length).toBe(1);
    expect(regions[0]).toMatchObject({
      start_line: 100,
      end_line: 108,
      severity: "CRITICAL",
      distinct_count: 2,
    });
    expect(regions[0]?.categories.sort()).toEqual(["correctness", "quality"]);
  });

  it("keeps far-apart regions distinct (> REGION_WINDOW)", () => {
    const regions = mergeRegions([
      disp("1:F-001", { start_line: 100, end_line: 100 }),
      disp("1:F-002", { start_line: 200, end_line: 200 }),
    ]);
    expect(regions.length).toBe(2);
  });

  it("the NEWEST contributor's reason wins — numeric iteration order (10 > 2)", () => {
    const regions = mergeRegions([
      disp("10:F-001", { reason: "newest from iteration ten" }),
      disp("2:F-001", { reason: "older from iteration two" }),
    ]);
    expect(regions[0]?.reason).toBe("newest from iteration ten");
  });

  it("a retracted disposition's attributes are gone after re-derivation (no contamination)", () => {
    // Iteration 1 rejects a CRITICAL quality finding; the record is later
    // superseded away by the fold. Re-deriving from the SURVIVING records only
    // must not retain its severity/category/bounds.
    const all = [
      disp("1:F-001", { severity: "CRITICAL" as const, categories: ["quality" as const] }),
      disp("1:F-002", { start_line: 102, end_line: 103 }),
    ];
    const afterSupersede = all.filter((d) => d.key !== "1:F-001");
    const regions = mergeRegions(afterSupersede);
    expect(regions.length).toBe(1);
    expect(regions[0]).toMatchObject({
      severity: "WARN",
      distinct_count: 1,
      start_line: 102,
      end_line: 103,
    });
    expect(regions[0]?.categories).toEqual(["correctness"]);
  });
});
