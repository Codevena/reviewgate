import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function f(over: Partial<Finding>): Finding {
  return {
    id: "F",
    signature: `${over.file ?? "a.ts"}:${over.line_start ?? 5}`,
    severity: "CRITICAL",
    category: "security",
    rule_id: "r",
    file: "a.ts",
    line_start: 5,
    line_end: 5,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "x", persona: "security" },
    confidence: 0.9,
    consensus: "unanimous",
    ...over,
  } as Finding;
}

const changedRanges = new Map([["a.ts", [[10, 14]] as Array<[number, number]>]]);

describe("aggregate scopeToDiff", () => {
  it("keeps a finding whose range overlaps a changed hunk", () => {
    const r = aggregate({
      findings: [f({ line_start: 11, line_end: 11 })],
      reviewersTotal: 1,
      changedRanges,
      scopeToDiff: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.dedupedFindings[0]?.scope_demoted).toBeUndefined();
    expect(r.verdict).toBe("FAIL");
  });

  it("demotes an out-of-diff finding to INFO and does not FAIL", () => {
    const r = aggregate({
      findings: [f({ line_start: 50, line_end: 50 })],
      reviewersTotal: 1,
      changedRanges,
      scopeToDiff: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.scope_demoted).toBe(true);
    expect(r.verdict).not.toBe("FAIL");
  });

  it("keeps findings when scopeToDiff is false", () => {
    const r = aggregate({
      findings: [f({ line_start: 50, line_end: 50 })],
      reviewersTotal: 1,
      changedRanges,
      scopeToDiff: false,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
  });

  it("demotes a finding whose file is not in the diff at all (default)", () => {
    // A hallucinated finding on an untouched file is the dominant false-positive
    // class. With the default (empty) outOfDiffBlocking it demotes to INFO.
    const r = aggregate({
      findings: [f({ file: "other.ts", line_start: 99 })],
      reviewersTotal: 1,
      changedRanges,
      scopeToDiff: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.scope_demoted).toBe(true);
    expect(r.verdict).not.toBe("FAIL");
  });

  it("keeps a file-not-in-diff finding blocking when its category is in outOfDiffBlocking", () => {
    // Escape hatch: legitimate cross-file impact (a changed export breaking an
    // untouched caller) stays blocking for the configured categories.
    const r = aggregate({
      findings: [f({ file: "other.ts", line_start: 99, category: "security" })],
      reviewersTotal: 1,
      changedRanges,
      scopeToDiff: true,
      outOfDiffBlocking: ["security"],
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.dedupedFindings[0]?.scope_demoted).toBeUndefined();
    expect(r.verdict).toBe("FAIL");
  });

  it("keeps an in-file but OUT-OF-HUNK finding blocking when its category is in outOfDiffBlocking (F-033)", () => {
    // File IS in the diff but the cited line is outside the changed hunk (e.g. the
    // enclosing function signature a few lines above the changed call). This case
    // must honor the SAME outOfDiffBlocking escape hatch as the file-absent case —
    // otherwise a real CRITICAL security finding silently demotes to INFO with no
    // config override.
    const r = aggregate({
      findings: [f({ file: "a.ts", line_start: 48, line_end: 48, category: "security" })],
      reviewersTotal: 1,
      changedRanges, // a.ts hunk is [10,14] → line 48 is in-file but out-of-hunk
      scopeToDiff: true,
      outOfDiffBlocking: ["security"],
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.dedupedFindings[0]?.scope_demoted).toBeUndefined();
    expect(r.verdict).toBe("FAIL");
  });

  it("still demotes an in-file out-of-hunk finding when its category is NOT in outOfDiffBlocking", () => {
    const r = aggregate({
      findings: [f({ file: "a.ts", line_start: 48, line_end: 48, category: "security" })],
      reviewersTotal: 1,
      changedRanges,
      scopeToDiff: true,
      // no outOfDiffBlocking → demote as before
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.scope_demoted).toBe(true);
  });

  it("merges findings that differ only by path shape (./a.ts vs a.ts)", () => {
    // normalizeRepoPath must apply BEFORE clustering, not only at the scope lookup.
    const r = aggregate({
      findings: [
        f({ file: "a.ts", line_start: 11, signature: "s1" }),
        f({
          file: "./a.ts",
          line_start: 11,
          signature: "s2",
          reviewer: { provider: "gemini", model: "m", persona: "security" },
        }),
      ],
      reviewersTotal: 2,
      changedRanges,
      scopeToDiff: true,
    });
    expect(r.dedupedFindings.length).toBe(1);
  });

  it("keeps a co-located out-of-diff SECURITY finding blocking under outOfDiffBlocking (N6: separated from the quality nit)", () => {
    // N6: the quality nit and the security concern are NOT merged across the
    // high-stakes boundary. The security finding stays blocking via
    // outOfDiffBlocking:["security"]; the quality nit demotes out-of-diff on its own.
    const r = aggregate({
      findings: [
        f({ file: "other.ts", line_start: 99, category: "quality", signature: "q1" }),
        f({
          file: "other.ts",
          line_start: 99,
          category: "security",
          signature: "q2",
          reviewer: { provider: "gemini", model: "m", persona: "security" },
        }),
      ],
      reviewersTotal: 2,
      changedRanges,
      scopeToDiff: true,
      outOfDiffBlocking: ["security"],
    });
    const sec = r.dedupedFindings.find((x) => x.category === "security");
    expect(sec?.severity).not.toBe("INFO"); // security stays blocking via outOfDiffBlocking
    expect(sec?.scope_demoted).toBeUndefined();
  });

  it("normalizes the finding path so a ./-prefixed in-diff finding stays blocking", () => {
    // "./a.ts" must match the changed-range key "a.ts" — otherwise an in-diff
    // finding would be wrongly treated as out-of-diff and demoted.
    const r = aggregate({
      findings: [f({ file: "./a.ts", line_start: 11, line_end: 11 })],
      reviewersTotal: 1,
      changedRanges,
      scopeToDiff: true,
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.dedupedFindings[0]?.scope_demoted).toBeUndefined();
  });

  it("keeps demoted details within the 2000-char FindingSchema cap", async () => {
    const { FindingSchema } = await import("../../src/schemas/finding.ts");
    const r = aggregate({
      findings: [f({ line_start: 50, line_end: 50, details: "x".repeat(2000) })],
      reviewersTotal: 1,
      changedRanges,
      scopeToDiff: true,
    });
    const demoted = r.dedupedFindings[0];
    expect(demoted?.scope_demoted).toBe(true);
    expect((demoted?.details ?? "").length).toBeLessThanOrEqual(2000);
    expect(demoted?.details ?? "").toContain("advisory only");
    expect(FindingSchema.safeParse(demoted).success).toBe(true);
  });
});
