// tests/unit/review-output-mapping-failure.test.ts
import { describe, expect, test } from "bun:test";
import {
  coerceCategory,
  mapReviewOutputToFindingsCounted,
  mappingLooksLossy,
} from "../../src/providers/review-output.ts";

const ctx = { provider: "claude-code", model: "m", persona: "quality", workingDir: "/repo" };

describe("S2 — off-enum findings must not silently vanish into a PASS", () => {
  test("category synonyms coerce and survive (before signature computation)", () => {
    const out = {
      verdict: "FAIL",
      findings: [
        {
          severity: "CRITICAL",
          category: "vulnerability",
          file: "a.ts",
          line: 3,
          message: "sqli",
          rule_id: null,
          details: null,
          confidence: 0.9,
          line_end: null,
          evidence_line: null,
        },
      ],
    } as never;
    const mapped = mapReviewOutputToFindingsCounted(out, ctx);
    expect(mapped.findings).toHaveLength(1);
    expect(mapped.findings[0]?.category).toBe("security");
    expect(mapped.droppedCount).toBe(0);
  });

  test("unknown category is NOT silently coerced — it drops and counts", () => {
    const out = {
      verdict: "FAIL",
      findings: [
        {
          severity: "CRITICAL",
          category: "vibes",
          file: "a.ts",
          line: 3,
          message: "x",
          rule_id: null,
          details: null,
          confidence: 0.9,
          line_end: null,
          evidence_line: null,
        },
      ],
    } as never;
    const mapped = mapReviewOutputToFindingsCounted(out, ctx);
    expect(mapped.findings).toHaveLength(0);
    expect(mapped.droppedCount).toBe(1);
    // Priority order (round-10 W1): a dropped BLOCKING candidate wins over the
    // 0-survived reason — assert the higher-priority message.
    expect(mappingLooksLossy(out, mapped)).toContain("blocking-severity");
  });

  test("clean review (0 reported, 0 mapped) is not lossy", () => {
    const out = { verdict: "PASS", findings: [] } as never;
    expect(mappingLooksLossy(out, mapReviewOutputToFindingsCounted(out, ctx))).toBeNull();
  });

  test("PASS verdict + dropped BLOCKING candidate + surviving advisory is STILL lossy (round-7 W1)", () => {
    const out = {
      verdict: "PASS",
      findings: [
        {
          severity: "CRITICAL",
          category: "vibes",
          file: "a.ts",
          line: 1,
          message: "dropped blocking",
          rule_id: null,
          details: null,
          confidence: 0.9,
          line_end: null,
          evidence_line: null,
        },
        {
          severity: "INFO",
          category: "quality",
          file: "a.ts",
          line: 2,
          message: "nit",
          rule_id: null,
          details: null,
          confidence: 0.9,
          line_end: null,
          evidence_line: null,
        },
      ],
    } as never;
    const mapped = mapReviewOutputToFindingsCounted(out, ctx);
    expect(mapped.findings).toHaveLength(1);
    expect(mapped.droppedBlockingCount).toBe(1);
    expect(mappingLooksLossy(out, mapped)).toContain("blocking-severity");
  });

  test("dropped candidate with UNPARSEABLE severity counts as blocking (fail toward lossy)", () => {
    const out = {
      verdict: "PASS",
      findings: [
        {
          severity: "sev-9000",
          category: "vibes",
          file: "a.ts",
          line: 1,
          message: "x",
          rule_id: null,
          details: null,
          confidence: 0.9,
          line_end: null,
          evidence_line: null,
        },
        {
          severity: "INFO",
          category: "quality",
          file: "a.ts",
          line: 2,
          message: "nit",
          rule_id: null,
          details: null,
          confidence: 0.9,
          line_end: null,
          evidence_line: null,
        },
      ],
    } as never;
    const mapped = mapReviewOutputToFindingsCounted(out, ctx);
    expect(mapped.droppedBlockingCount).toBe(1);
    expect(mappingLooksLossy(out, mapped)).not.toBeNull();
  });

  test("dropped candidate that coerces to INFO with surviving findings is NOT lossy (advisory noise only)", () => {
    const out = {
      verdict: "PASS",
      findings: [
        {
          severity: "INFO",
          category: "vibes",
          file: "a.ts",
          line: 1,
          message: "dropped advisory",
          rule_id: null,
          details: null,
          confidence: 0.9,
          line_end: null,
          evidence_line: null,
        },
        {
          severity: "WARN",
          category: "quality",
          file: "a.ts",
          line: 2,
          message: "kept",
          rule_id: null,
          details: null,
          confidence: 0.9,
          line_end: null,
          evidence_line: null,
        },
      ],
    } as never;
    const mapped = mapReviewOutputToFindingsCounted(out, ctx);
    expect(mapped.droppedBlockingCount).toBe(0);
    expect(mappingLooksLossy(out, mapped)).toBeNull(); // droppedCount noted in statusDetail only
  });

  test("FAIL verdict + dropped CRITICAL + advisory survivor → the blocking-drop reason wins", () => {
    const out = {
      verdict: "FAIL",
      findings: [
        {
          severity: "CRITICAL",
          category: "vibes",
          file: "a.ts",
          line: 1,
          message: "dropped",
          rule_id: null,
          details: null,
          confidence: 0.9,
          line_end: null,
          evidence_line: null,
        },
        {
          severity: "INFO",
          category: "quality",
          file: "a.ts",
          line: 2,
          message: "nit",
          rule_id: null,
          details: null,
          confidence: 0.9,
          line_end: null,
          evidence_line: null,
        },
      ],
    } as never;
    const mapped = mapReviewOutputToFindingsCounted(out, ctx);
    expect(mapped.findings).toHaveLength(1);
    expect(mappingLooksLossy(out, mapped)).toContain("blocking-severity"); // priority (round-10 W1)
  });

  test("FAIL verdict, ZERO drops, only advisory findings → the no-blocking-survivor reason", () => {
    const out = {
      verdict: "FAIL",
      findings: [
        {
          severity: "INFO",
          category: "quality",
          file: "a.ts",
          line: 2,
          message: "nit",
          rule_id: null,
          details: null,
          confidence: 0.9,
          line_end: null,
          evidence_line: null,
        },
      ],
    } as never;
    const mapped = mapReviewOutputToFindingsCounted(out, ctx);
    expect(mapped.droppedBlockingCount).toBe(0);
    expect(mappingLooksLossy(out, mapped)).toContain("no blocking finding");
  });

  test("coercion table", () => {
    for (const [input, want] of [
      ["vulnerability", "security"],
      ["vuln", "security"],
      ["security-issue", "security"],
      ["bug", "correctness"],
      ["logic", "correctness"],
      ["defect", "correctness"],
      ["maintainability", "quality"],
      ["style", "quality"],
      ["code-quality", "quality"],
      ["perf", "performance"],
      ["test", "testing"],
      ["tests", "testing"],
      ["coverage", "testing"],
      ["doc", "docs"],
      ["documentation", "docs"],
      ["Security", "security"], // case
    ] as const) {
      expect(coerceCategory(input)).toBe(want);
    }
    expect(coerceCategory("vibes")).toBe("vibes"); // unknown → unchanged → safeParse rejects
    expect(coerceCategory(42)).toBe(42);
  });
});
