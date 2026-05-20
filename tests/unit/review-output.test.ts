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
      "message",
      "details",
      "confidence",
    ]);
    expect(items.additionalProperties).toBe(false);
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
