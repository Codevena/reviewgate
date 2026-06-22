// tests/unit/evidence-attestation.test.ts
//
// S4 (field report 2026-06-23): a RENDER-ONLY evidence-attestation badge. The reviewer self-quotes
// the exact source line it relies on (evidence_line); a deterministic cross-check flags a CLEAR
// mismatch vs the working-tree line, or a null evidence on a blocking finding. NEVER changes
// severity — it only makes the moot/good lone-CRITICAL split (P4) visible. Any ambiguity → no badge.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attestEvidence } from "../../src/core/fact-check.ts";
import { DOC_REVIEW_PROMPT_PREAMBLE, REVIEW_PROMPT_PREAMBLE } from "../../src/core/orchestrator.ts";
import {
  REVIEW_OUTPUT_SCHEMA,
  mapReviewOutputToFindings,
} from "../../src/providers/review-output.ts";
import { FindingSchema } from "../../src/schemas/finding.ts";

function finding(over: Record<string, unknown>) {
  return FindingSchema.parse({
    id: "F-001",
    signature: "s",
    severity: "CRITICAL",
    category: "correctness",
    rule_id: "r",
    file: "a.ts",
    line_start: 2,
    line_end: 2,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "x", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  });
}

const baseRf = {
  severity: "CRITICAL" as const,
  category: "correctness",
  rule_id: "r",
  file: "a.ts",
  line: 2,
  line_end: null,
  message: "m",
  details: "d",
  confidence: 0.9,
};
const ctx = { provider: "codex" as const, model: "x", persona: "security", workingDir: "." };

describe("S4.1 evidence_line schema + carry-through", () => {
  it("REVIEW_OUTPUT_SCHEMA: evidence_line is a nullable string listed in required (strict-mode safe)", () => {
    const item = REVIEW_OUTPUT_SCHEMA.properties.findings.items as {
      required: readonly string[];
      properties: Record<string, { type?: unknown } | undefined>;
    };
    expect(item.required).toContain("evidence_line");
    expect(item.properties.evidence_line?.type).toEqual(["string", "null"]);
  });

  it("mapReviewOutputToFindings carries evidence_line through to the Finding", () => {
    const out = {
      verdict: "FAIL" as const,
      findings: [{ ...baseRf, evidence_line: "const x = foo()" }],
      memory_proposals: [],
    };
    const findings = mapReviewOutputToFindings(out, ctx);
    expect(findings[0]?.evidence_line).toBe("const x = foo()");
  });

  it("a missing evidence_line maps to absent (back-compat with non-cooperating reviewers)", () => {
    const out = { verdict: "FAIL" as const, findings: [{ ...baseRf }], memory_proposals: [] };
    const findings = mapReviewOutputToFindings(out, ctx);
    expect(findings[0]?.evidence_line).toBeUndefined();
  });

  it("FindingSchema accepts evidence_line and defaults to absent", () => {
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
    expect(FindingSchema.parse({ ...base, evidence_line: "x" }).evidence_line).toBe("x");
    expect(FindingSchema.parse(base).evidence_line).toBeUndefined();
  });
});

function tmpRepoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-evi-"));
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  return dir;
}

describe("S4.2 evidence_line preamble directive", () => {
  it("both review preambles instruct the reviewer to quote evidence_line", () => {
    for (const p of [REVIEW_PROMPT_PREAMBLE, DOC_REVIEW_PROMPT_PREAMBLE]) {
      expect(p.toLowerCase()).toContain("evidence_line");
    }
  });
});

describe("S4.3 attestEvidence (render-only evidence_mismatch badge)", () => {
  it("a quote that matches the cited line → NO badge, severity unchanged", () => {
    const repo = tmpRepoWith({ "a.ts": "line1\nconst x = foo()\nline3\n" });
    const out = attestEvidence([finding({ evidence_line: "const x = foo()" })], repo);
    expect(out[0]?.evidence_mismatch).toBeUndefined();
    expect(out[0]?.severity).toBe("CRITICAL");
  });

  it("a quote that matches NO line in the cited file → evidence_mismatch badge, severity UNCHANGED", () => {
    const repo = tmpRepoWith({ "a.ts": "line1\nconst x = foo()\nline3\n" });
    const out = attestEvidence([finding({ evidence_line: "const y = bar(1,2,3)" })], repo);
    expect(out[0]?.evidence_mismatch).toBe(true);
    expect(out[0]?.severity).toBe("CRITICAL"); // render-only: never demotes
  });

  it("a quote that matches a DIFFERENT line in the file (moved/deleted pre-image) → NO badge", () => {
    const repo = tmpRepoWith({ "a.ts": "const moved = 1\nline2\nline3\n" });
    // cited line_start=2 but the quote matches line 1 (the reviewer reasoned on a moved line)
    const out = attestEvidence([finding({ evidence_line: "const moved = 1" })], repo);
    expect(out[0]?.evidence_mismatch).toBeUndefined();
  });

  it("whitespace-only difference → normalized match → NO badge", () => {
    const repo = tmpRepoWith({ "a.ts": "x\n    const x = foo()\ny\n" });
    const out = attestEvidence([finding({ evidence_line: "const x = foo()" })], repo);
    expect(out[0]?.evidence_mismatch).toBeUndefined();
  });

  it("cited line out of range / unreadable file / no evidence_line → NO badge (fail-safe)", () => {
    const repo = tmpRepoWith({ "a.ts": "only-one-line\n" });
    const oor = attestEvidence([finding({ line_start: 99, evidence_line: "whatever" })], repo);
    expect(oor[0]?.evidence_mismatch).toBeUndefined();
    const noEv = attestEvidence([finding({})], repo);
    expect(noEv[0]?.evidence_mismatch).toBeUndefined();
    const absent = attestEvidence([finding({ file: "ghost.ts", evidence_line: "x" })], repo);
    expect(absent[0]?.evidence_mismatch).toBeUndefined();
  });
});
