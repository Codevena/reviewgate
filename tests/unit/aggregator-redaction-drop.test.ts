import { describe, expect, test } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

// Minimal valid Finding factory — override per case.
function mkFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    signature: "sig-1",
    severity: "CRITICAL",
    category: "correctness",
    rule_id: "rule.x",
    file: "src/foo.ts",
    line_start: 10,
    line_end: 10,
    message: "a problem",
    details: "some details",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  } as Finding;
}

describe("Slice 1: redaction-artifact drop", () => {
  test("drops a non-security finding whose message is the REDACTED placeholder", () => {
    const f = mkFinding({ message: "undefined variable <REDACTED:HIGH_ENTROPY>" });
    const r = aggregate({ findings: [f], reviewersTotal: 1 });
    expect(r.dedupedFindings).toHaveLength(0);
    expect(r.redactionDropped).toHaveLength(1);
    expect(r.redactionDroppedCount).toBe(1);
  });

  test("drops when REDACTED is only in suggested_fix (non-security, no lead word)", () => {
    const f = mkFinding({ message: "fix this", suggested_fix: "remove <REDACTED:HIGH_ENTROPY>" });
    const r = aggregate({ findings: [f], reviewersTotal: 1 });
    expect(r.dedupedFindings).toHaveLength(0);
    expect(r.redactionDroppedCount).toBe(1);
  });

  test("KEEPS a security finding mentioning REDACTED (gate 2: possible real leak)", () => {
    const f = mkFinding({ category: "security", message: "exposed value <REDACTED:HIGH_ENTROPY>" });
    const r = aggregate({ findings: [f], reviewersTotal: 1 });
    expect(r.dedupedFindings).toHaveLength(1);
    expect(r.redactionDroppedCount).toBe(0);
  });

  test("KEEPS a non-security finding whose message names a secret (gate 3 backstop)", () => {
    const f = mkFinding({ message: "Hardcoded api_key <REDACTED:HIGH_ENTROPY> committed" });
    const r = aggregate({ findings: [f], reviewersTotal: 1 });
    expect(r.dedupedFindings).toHaveLength(1);
    expect(r.redactionDroppedCount).toBe(0);
  });

  test("KEEPS when the secret lead word is only in suggested_fix (gate 3 scans both fields)", () => {
    const f = mkFinding({
      message: "remove this committed value <REDACTED:HIGH_ENTROPY>",
      suggested_fix: "delete the hardcoded api_key",
    });
    const r = aggregate({ findings: [f], reviewersTotal: 1 });
    expect(r.dedupedFindings).toHaveLength(1);
    expect(r.redactionDroppedCount).toBe(0);
  });

  test("KEEPS when REDACTED appears only in details (context, not subject)", () => {
    const f = mkFinding({ message: "a real bug", details: "near <REDACTED:HIGH_ENTROPY> here" });
    const r = aggregate({ findings: [f], reviewersTotal: 1 });
    expect(r.dedupedFindings).toHaveLength(1);
    expect(r.redactionDroppedCount).toBe(0);
  });

  test("a clean co-located finding is unaffected by a dropped one", () => {
    const dropped = mkFinding({ id: "F-001", message: "undefined <REDACTED:HIGH_ENTROPY>" });
    const clean = mkFinding({
      id: "F-002",
      signature: "sig-2",
      message: "real bug",
      line_start: 11,
    });
    const r = aggregate({ findings: [dropped, clean], reviewersTotal: 1 });
    expect(r.dedupedFindings).toHaveLength(1);
    expect(r.dedupedFindings[0]?.message).toBe("real bug");
    expect(r.redactionDroppedCount).toBe(1);
  });
});
