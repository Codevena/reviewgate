// tests/unit/review-output.test.ts
import { describe, expect, it } from "bun:test";
import {
  REVIEW_OUTPUT_SCHEMA,
  mapReviewOutputToFindings,
  parseReviewOutput,
} from "../../src/providers/review-output.ts";

describe("review-output", () => {
  it("exposes a strict all-required JSON schema", () => {
    const items = REVIEW_OUTPUT_SCHEMA.properties.findings.items;
    expect(items.required).toEqual([
      "severity",
      "category",
      "rule_id",
      "file",
      "line",
      "line_end",
      "message",
      "details",
      "confidence",
    ]);
    expect(items.additionalProperties).toBe(false);
    // line_end is strict-mode optional → nullable type, not omitted from required.
    expect(items.properties.line_end.type).toEqual(["integer", "null"]);
  });

  it("maps an optional line_end to a multi-line range; null/absent → single line", () => {
    const ctx = { provider: "codex", model: "m", persona: "security", workingDir: "/repo" };
    const base = {
      severity: "WARN" as const,
      category: "quality",
      rule_id: "r",
      file: "a.ts",
      message: "m",
      details: "d",
      confidence: 0.8,
    };
    const [multi] = mapReviewOutputToFindings(
      { verdict: "FAIL", findings: [{ ...base, line: 10, line_end: 14 }] },
      ctx,
    );
    expect(multi?.line_start).toBe(10);
    expect(multi?.line_end).toBe(14);

    const [single] = mapReviewOutputToFindings(
      { verdict: "FAIL", findings: [{ ...base, line: 10, line_end: null }] },
      ctx,
    );
    expect(single?.line_start).toBe(10);
    expect(single?.line_end).toBe(10); // null → single line (back-compat)

    // A backwards/garbage line_end is clamped to the start (never < line_start).
    const [backwards] = mapReviewOutputToFindings(
      { verdict: "FAIL", findings: [{ ...base, line: 10, line_end: 3 }] },
      ctx,
    );
    expect(backwards?.line_end).toBe(10);

    const [absent] = mapReviewOutputToFindings(
      { verdict: "FAIL", findings: [{ ...base, line: 7 }] },
      ctx,
    );
    expect(absent?.line_end).toBe(7); // absent → single line
  });

  it("parses a clean JSON string", () => {
    const r = parseReviewOutput('{"verdict":"FAIL","findings":[]}');
    expect(r?.verdict).toBe("FAIL");
  });

  it("strips ```json fences and surrounding prose before parsing", () => {
    const r = parseReviewOutput('here:\n```json\n{"verdict":"PASS","findings":[]}\n```\nthanks');
    expect(r?.verdict).toBe("PASS");
  });

  it("returns null on unrecoverable garbage", () => {
    expect(parseReviewOutput("not json at all")).toBeNull();
  });

  it("maps review findings into Finding with stable ids, signatures, pinned reviewer", () => {
    const findings = mapReviewOutputToFindings(
      {
        verdict: "FAIL",
        findings: [
          {
            severity: "CRITICAL",
            category: "security",
            rule_id: "insecure-compare",
            file: "/repo/src/auth.ts",
            line: 5,
            message: "m",
            details: "d",
            confidence: 0.9,
          },
        ],
      },
      { provider: "gemini", model: "gemini-3-pro", persona: "architecture", workingDir: "/repo" },
    );
    expect(findings.length).toBe(1);
    expect(findings[0]?.id).toBe("F-001");
    expect(findings[0]?.file).toBe("src/auth.ts");
    expect(findings[0]?.reviewer.provider).toBe("gemini");
    expect(findings[0]?.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(findings[0]?.consensus).toBe("singleton");
  });

  it("drops findings whose severity/category fail the Finding schema", () => {
    const findings = mapReviewOutputToFindings(
      {
        verdict: "FAIL",
        findings: [
          {
            severity: "BOGUS",
            category: "x",
            rule_id: "r",
            file: "a.ts",
            line: 1,
            message: "m",
            details: "d",
            confidence: 0.5,
          } as never,
        ],
      },
      { provider: "codex", model: "m", persona: "security", workingDir: "/repo" },
    );
    expect(findings.length).toBe(0);
  });
});
