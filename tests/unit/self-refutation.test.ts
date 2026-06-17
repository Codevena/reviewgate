// tests/unit/self-refutation.test.ts
import { describe, expect, it } from "bun:test";
import { demoteSelfRefuting } from "../../src/core/self-refutation.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function mkFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    signature: "sig1",
    severity: "WARN",
    category: "quality",
    rule_id: "some-rule",
    file: "real.ts",
    line_start: 1,
    line_end: 1,
    message: "Potential issue with the regex",
    details: "Investigated the pattern.",
    reviewer: { provider: "codex", model: "x", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  };
}

function one(f: Finding): Finding {
  const out = demoteSelfRefuting([f])[0];
  if (!out) throw new Error("expected one finding");
  return out;
}

describe("demoteSelfRefuting — POSITIVE (must demote to INFO)", () => {
  const positives: Array<[string, Partial<Finding>]> = [
    ["message: This appears safe", { message: "Reviewed the call. This appears safe." }],
    ["message: No issue", { message: "Checked bounds. No issue." }],
    ["details: No defect", { details: "Looked at the loop carefully. No defect." }],
    ["details: trailing Safe.", { details: "Traced the data flow end to end. Safe." }],
    ["details: This is fine", { details: "The escaping is handled upstream, so this is fine." }],
    ["message: Not a problem", { message: "The cast is checked. Not a problem." }],
    ["details: No actual bug here", { details: "Re-read it. No actual bug here." }],
    [
      "details: therefore no issue",
      { details: "Params are bound via Prisma; therefore no issue." },
    ],
    [
      "details: ...so this is safe",
      { details: "The value is validated before use, so this is safe." },
    ],
    [
      "CRITICAL self-refute",
      {
        severity: "CRITICAL",
        category: "security",
        details: "On closer look the input is sanitized. No vulnerability here.",
      },
    ],
    [
      "correctness self-refute",
      {
        severity: "CRITICAL",
        category: "correctness",
        details: "Traced the index math carefully. This is fine.",
      },
    ],
  ];
  for (const [name, over] of positives) {
    it(`demotes: ${name}`, () => {
      const out = one(mkFinding(over));
      expect(out.severity).toBe("INFO");
      expect(out.self_refuted).toBe(true);
      expect(out.details).toContain("self-refutation");
    });
  }
});

describe("demoteSelfRefuting — NEGATIVE (must stay blocking)", () => {
  const negatives: Array<[string, Partial<Finding>]> = [
    [
      "conditional: would be safe IF",
      { details: "This would be safe IF X validated the input, but it does not." },
    ],
    ["negated: this is NOT safe", { details: "This is NOT safe." }],
    [
      "contrast: appears safe but unbounded",
      { details: "The handler appears safe but the loop is unbounded." },
    ],
    ["conditional: safe unless null", { details: "It is safe unless the caller passes null." }],
    [
      "contrast: no issue with naming but SQL injectable",
      { details: "No issue with the naming, but the SQL is injectable." },
    ],
    [
      "benign word mid-sentence, real issue after",
      { details: "The token is safe to log but it is also written to disk unencrypted." },
    ],
    [
      "ordinary finding, no conclusion",
      { message: "Unbounded recursion can overflow the stack", details: "No base case." },
    ],
    [
      "mentions safe path that is missing",
      {
        severity: "CRITICAL",
        details: "This would be safe if the caller escaped the value; it does not.",
      },
    ],
    // opus DoD: imperative-mood recommendations are NOT clearances — they imply the property
    // might not hold. These must stay blocking (the fail-open the brief asked us to close).
    [
      "imperative: verify the path is safe",
      {
        severity: "CRITICAL",
        details: "Builds a path from untrusted input. Verify the path is safe.",
      },
    ],
    ["imperative: make sure this is safe", { details: "Make sure this is safe." }],
    [
      "imperative: ensure the chain is valid",
      { severity: "CRITICAL", details: "Ensure the certificate chain is valid." },
    ],
    [
      "ambiguous correctness adjective is not a clearance",
      { severity: "CRITICAL", details: "Off-by-one in the loop. The bound is correct." },
    ],
    [
      "imperative: make sure the encoding is correct",
      { details: "Make sure the encoding is correct." },
    ],
  ];
  for (const [name, over] of negatives) {
    it(`keeps: ${name}`, () => {
      const out = one(mkFinding(over));
      expect(out.severity).not.toBe("INFO");
      expect(out.self_refuted).toBeUndefined();
    });
  }
});

describe("demoteSelfRefuting — guards", () => {
  it("is idempotent (re-running leaves an already-demoted INFO unchanged)", () => {
    const f = mkFinding({ details: "Looks correct. No issue." });
    const once = demoteSelfRefuting([f]);
    const twice = demoteSelfRefuting(once);
    expect(twice[0]).toEqual(once[0]);
  });

  it("never touches a deterministic check-tier finding", () => {
    const f = mkFinding({
      deterministic: true,
      severity: "CRITICAL",
      details: "tsc failed. No issue.",
    });
    expect(one(f).severity).toBe("CRITICAL");
  });

  it("leaves an already-INFO finding untouched (no flag, no double-demote)", () => {
    const f = mkFinding({ severity: "INFO", details: "No issue." });
    const out = one(f);
    expect(out.severity).toBe("INFO");
    expect(out.self_refuted).toBeUndefined();
  });

  it("is a no-op when disabled", () => {
    const f = mkFinding({ details: "No issue." });
    expect(demoteSelfRefuting([f], false)[0]?.severity).toBe("WARN");
  });

  it("keeps the demoted details within the 2000-char schema cap", () => {
    const f = mkFinding({ details: `${"x".repeat(1999)}. No issue.` });
    const out = one(f);
    expect(out.details.length).toBeLessThanOrEqual(2000);
  });
});
