import { describe, expect, test } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

// Slice A (P1, field report 2026-06-22): a blocking finding on a file FOREIGN to this session
// (in input.foreignFiles — provably byte-identical to its SessionStart baseline) is demoted to
// advisory INFO + tagged foreign_to_session, so a parallel agent's uncommitted work doesn't
// block this session. STRUCTURAL demote: → INFO, NEVER demoted_from_critical (G0-exempt).
function mk(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    signature: "sig-1",
    severity: "CRITICAL",
    category: "correctness",
    rule_id: "rule.x",
    file: "src/foreign.ts",
    line_start: 10,
    line_end: 10,
    message: "a finding on a parallel agent's file",
    details: "not this session's work",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  } as Finding;
}

describe("Slice A: session-ownership (foreign-file) demote", () => {
  test("demotes a foreign CRITICAL to advisory INFO + foreign_to_session, NO from-critical (G0-exempt)", () => {
    const r = aggregate({
      findings: [mk()],
      reviewersTotal: 1,
      foreignFiles: new Set(["src/foreign.ts"]),
    });
    const f = r.dedupedFindings[0];
    expect(f?.severity).toBe("INFO");
    expect(f?.foreign_to_session).toBe(true);
    // STRUCTURAL scope demote — must NOT carry value-judgment G0 provenance (else it would
    // stay SOFT-PASS-blocking and never converge out of the gate).
    expect(f?.demoted_from_critical).toBeUndefined();
    expect(r.verdict).not.toBe("FAIL");
  });

  test("does NOT demote a finding on a file the session owns (not in foreignFiles)", () => {
    const r = aggregate({
      findings: [mk({ file: "src/mine.ts" })],
      reviewersTotal: 1,
      foreignFiles: new Set(["src/foreign.ts"]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.dedupedFindings[0]?.foreign_to_session).toBeUndefined();
    expect(r.verdict).toBe("FAIL");
  });

  test("own CRITICAL still blocks while a foreign CRITICAL goes advisory (the reported mix)", () => {
    const own = mk({ id: "F-001", file: "src/mine.ts", signature: "s-own", message: "my bug" });
    const foreign = mk({
      id: "F-002",
      file: "src/foreign.ts",
      signature: "s-foreign",
      message: "their bug",
    });
    const r = aggregate({
      findings: [own, foreign],
      reviewersTotal: 1,
      foreignFiles: new Set(["src/foreign.ts"]),
    });
    const byFile = new Map(r.dedupedFindings.map((f) => [f.file, f]));
    expect(byFile.get("src/mine.ts")?.severity).toBe("CRITICAL");
    expect(byFile.get("src/foreign.ts")?.severity).toBe("INFO");
    expect(byFile.get("src/foreign.ts")?.foreign_to_session).toBe(true);
    expect(r.verdict).toBe("FAIL"); // own bug still blocks
  });

  test("outOfDiffBlocking keeps a foreign finding BLOCKING but still tags it (out-of-scope path)", () => {
    const r = aggregate({
      findings: [mk({ category: "security" })],
      reviewersTotal: 1,
      foreignFiles: new Set(["src/foreign.ts"]),
      outOfDiffBlocking: ["security"],
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL"); // escape hatch keeps it blocking
    expect(r.dedupedFindings[0]?.foreign_to_session).toBe(true); // but tagged → out-of-scope OK
    expect(r.verdict).toBe("FAIL");
  });

  test("is a no-op when foreignFiles is absent or empty (full review = fail-closed default)", () => {
    expect(aggregate({ findings: [mk()], reviewersTotal: 1 }).verdict).toBe("FAIL");
    expect(
      aggregate({ findings: [mk()], reviewersTotal: 1, foreignFiles: new Set() }).verdict,
    ).toBe("FAIL");
  });

  test("normalizes the finding path before matching (./src/foreign.ts == src/foreign.ts)", () => {
    const r = aggregate({
      findings: [mk({ file: "./src/foreign.ts" })],
      reviewersTotal: 1,
      foreignFiles: new Set(["src/foreign.ts"]),
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.foreign_to_session).toBe(true);
  });
});
