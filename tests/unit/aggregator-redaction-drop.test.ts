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

describe("Slice 1: redaction-artifact demote (not drop — keeps a mis-worded real leak visible)", () => {
  test("demotes a non-security finding whose message is the REDACTED placeholder to advisory INFO", () => {
    const f = mkFinding({ message: "undefined variable <REDACTED:HIGH_ENTROPY>" });
    const r = aggregate({ findings: [f], reviewersTotal: 1 });
    expect(r.dedupedFindings).toHaveLength(1); // kept (visible), not dropped
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.redaction_demoted).toBe(true);
    expect(r.verdict).not.toBe("FAIL"); // no longer blocks the gate
  });

  test("demotes when REDACTED is only in suggested_fix (non-security, no lead word)", () => {
    const f = mkFinding({ message: "fix this", suggested_fix: "remove <REDACTED:HIGH_ENTROPY>" });
    const r = aggregate({ findings: [f], reviewersTotal: 1 });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.redaction_demoted).toBe(true);
  });

  test("KEEPS BLOCKING a security finding mentioning REDACTED (gate 2: possible real leak)", () => {
    const f = mkFinding({ category: "security", message: "exposed value <REDACTED:HIGH_ENTROPY>" });
    const r = aggregate({ findings: [f], reviewersTotal: 1 });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.dedupedFindings[0]?.redaction_demoted).toBeUndefined();
  });

  test("KEEPS BLOCKING a non-security finding whose message names a secret (gate 3 backstop)", () => {
    const f = mkFinding({ message: "Hardcoded api_key <REDACTED:HIGH_ENTROPY> committed" });
    const r = aggregate({ findings: [f], reviewersTotal: 1 });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.dedupedFindings[0]?.redaction_demoted).toBeUndefined();
  });

  test("KEEPS BLOCKING when the secret lead word is only in suggested_fix (gate 3 scans both fields)", () => {
    const f = mkFinding({
      message: "remove this committed value <REDACTED:HIGH_ENTROPY>",
      suggested_fix: "delete the hardcoded api_key",
    });
    const r = aggregate({ findings: [f], reviewersTotal: 1 });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
  });

  test("KEEPS BLOCKING when REDACTED appears only in details (context, not subject)", () => {
    const f = mkFinding({ message: "a real bug", details: "near <REDACTED:HIGH_ENTROPY> here" });
    const r = aggregate({ findings: [f], reviewersTotal: 1 });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.dedupedFindings[0]?.redaction_demoted).toBeUndefined();
  });

  test("KEEPS BLOCKING a lowercase <redacted:…> (gate is case-sensitive; sanitizer only emits uppercase)", () => {
    const f = mkFinding({ message: "foo <redacted:HIGH_ENTROPY> bar" });
    const r = aggregate({ findings: [f], reviewersTotal: 1 });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.dedupedFindings[0]?.redaction_demoted).toBeUndefined();
  });

  test("a real co-located finding still BLOCKS — the demoted INFO artifact never masks it", () => {
    // Demote happens pre-cluster, so the artifact (now INFO) can never be the cluster
    // representative. Placed far apart (lines 10 vs 50) so they don't merge: assert both
    // independently — the artifact is advisory, the real bug still fails the gate.
    const artifact = mkFinding({
      id: "F-001",
      message: "undefined <REDACTED:HIGH_ENTROPY>",
      line_start: 10,
    });
    const real = mkFinding({
      id: "F-002",
      signature: "sig-2",
      message: "real bug",
      line_start: 50,
    });
    const r = aggregate({ findings: [artifact, real], reviewersTotal: 1 });
    const realF = r.dedupedFindings.find((x) => x.message === "real bug");
    const artF = r.dedupedFindings.find((x) => x.message.includes("REDACTED"));
    expect(realF?.severity).toBe("CRITICAL");
    expect(artF?.severity).toBe("INFO");
    expect(artF?.redaction_demoted).toBe(true);
    expect(r.verdict).toBe("FAIL"); // the real bug blocks
  });
});
