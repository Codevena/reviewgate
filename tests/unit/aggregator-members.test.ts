import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function f(over: Partial<Finding> & { provider?: string }): Finding {
  const { provider, ...rest } = over;
  return {
    id: "F",
    signature: "sig",
    severity: "WARN",
    category: "quality",
    rule_id: "r",
    file: "a.ts",
    line_start: 5,
    line_end: 5,
    message: "m",
    details: "d",
    reviewer: { provider: provider ?? "codex", model: "x", persona: "security" },
    confidence: 0.8,
    consensus: "singleton",
    ...rest,
  } as Finding;
}

describe("aggregate member provenance (B0)", () => {
  it("records each merged member's signature + base provider on the representative", () => {
    // Two findings in the same file+region (within 5 lines) from DIFFERENT providers
    // with DIFFERENT signatures → cluster into one representative carrying both members.
    // Same file + 5-line region (lines 2 & 3 → same dedup bucket) merges them
    // category-independently, even with different rule_ids/messages.
    const r = aggregate({
      findings: [
        f({ provider: "codex", signature: "sigA", rule_id: "x", line_start: 2, message: "alpha" }),
        f({ provider: "gemini", signature: "sigB", rule_id: "y", line_start: 3, message: "beta" }),
      ],
      reviewersTotal: 2,
    });
    expect(r.dedupedFindings).toHaveLength(1);
    const members = r.dedupedFindings[0]?.members ?? [];
    expect(members).toHaveLength(2);
    const bySig = Object.fromEntries(members.map((m) => [m.signature, m.provider]));
    expect(bySig.sigA).toBe("codex");
    expect(bySig.sigB).toBe("gemini");
  });

  it("a single finding gets a one-member provenance with its own provider", () => {
    const r = aggregate({
      findings: [f({ provider: "codex", signature: "sigZ" })],
      reviewersTotal: 1,
    });
    expect(r.dedupedFindings[0]?.members).toEqual([
      { signature: "sigZ", provider: "codex", rule_id: "r", category: "quality", confidence: 0.8 },
    ]);
  });
});
