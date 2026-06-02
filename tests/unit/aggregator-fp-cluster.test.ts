import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function mkFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    signature: "sig1",
    severity: "WARN",
    category: "correctness",
    rule_id: "prisma-attribute-corruption",
    file: "prisma/schema.prisma",
    line_start: 10,
    line_end: 10,
    message: "looks corrupted",
    details: "details",
    reviewer: { provider: "gemini", model: "x", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  };
}

describe("F3 Phase 2 aggregator — fpActiveClusters demote", () => {
  it("demotes WARN → INFO when finding's (rule_id_token0, file) matches an active cluster", () => {
    const f = mkFinding();
    const result = aggregate({
      findings: [f],
      reviewersTotal: 1,
      fpActiveClusters: new Map([
        [
          "prisma@prisma/schema.prisma",
          { key: "prisma@prisma/schema.prisma", member_ids: ["FP-001", "FP-002"] },
        ],
      ]),
    });
    expect(result.dedupedFindings).toHaveLength(1);
    const out = result.dedupedFindings[0];
    expect(out?.severity).toBe("INFO");
    expect(out?.fp_cluster_match?.cluster_key).toBe("prisma@prisma/schema.prisma");
    expect(out?.fp_cluster_match?.suppressed).toBe(true);
    expect(out?.fp_cluster_match?.member_ids).toEqual(["FP-001", "FP-002"]);
  });

  it("demotes CRITICAL → INFO too (one step is wrong for clusters; cluster matches use same demote-to-INFO semantic as fpActive)", () => {
    const f = mkFinding({ severity: "CRITICAL" });
    const result = aggregate({
      findings: [f],
      reviewersTotal: 1,
      fpActiveClusters: new Map([
        [
          "prisma@prisma/schema.prisma",
          { key: "prisma@prisma/schema.prisma", member_ids: ["FP-001"] },
        ],
      ]),
    });
    expect(result.dedupedFindings[0]?.severity).toBe("INFO");
  });

  it("DOES NOT demote when rule_id_token0 differs (singleton cluster, no aggregation)", () => {
    const f = mkFinding({ rule_id: "i18n-key-mismatch" });
    const result = aggregate({
      findings: [f],
      reviewersTotal: 1,
      fpActiveClusters: new Map([
        [
          "prisma@prisma/schema.prisma",
          { key: "prisma@prisma/schema.prisma", member_ids: ["FP-001"] },
        ],
      ]),
    });
    expect(result.dedupedFindings[0]?.severity).toBe("WARN");
    expect(result.dedupedFindings[0]?.fp_cluster_match).toBeUndefined();
  });

  it("matches a cluster key on a MEMBER's rule_id, not only the representative's", () => {
    // Two reports cluster (same file+region); the representative carries rule_id
    // "alpha-rule", the merged member carries "beta-rule". An FP cluster keyed on
    // the member's token0 (beta@…) must still demote — checking only the
    // representative's rule_id (alpha@…) misses it.
    const rep = mkFinding({
      signature: "sig-rep",
      rule_id: "alpha-rule",
      file: "x.ts",
      line_start: 1,
      line_end: 1,
      reviewer: { provider: "codex", model: "m", persona: "security" },
    });
    const mem = mkFinding({
      signature: "sig-mem",
      rule_id: "beta-rule",
      file: "x.ts",
      line_start: 1,
      line_end: 1,
      reviewer: { provider: "codex", model: "m", persona: "security" },
    });
    const result = aggregate({
      findings: [rep, mem],
      reviewersTotal: 1,
      fpActiveClusters: new Map([["beta@x.ts", { key: "beta@x.ts", member_ids: ["FP-9"] }]]),
    });
    expect(result.dedupedFindings).toHaveLength(1);
    expect(result.dedupedFindings[0]?.severity).toBe("INFO");
    expect(result.dedupedFindings[0]?.fp_cluster_match?.cluster_key).toBe("beta@x.ts");
  });

  it("DOES NOT demote when file differs", () => {
    const f = mkFinding({ file: "src/other.ts" });
    const result = aggregate({
      findings: [f],
      reviewersTotal: 1,
      fpActiveClusters: new Map([
        [
          "prisma@prisma/schema.prisma",
          { key: "prisma@prisma/schema.prisma", member_ids: ["FP-001"] },
        ],
      ]),
    });
    expect(result.dedupedFindings[0]?.severity).toBe("WARN");
    expect(result.dedupedFindings[0]?.fp_cluster_match).toBeUndefined();
  });

  it("stacks with fp_ledger_match: a finding matching BOTH gets both tags + demoted (idempotent INFO)", () => {
    const f = mkFinding();
    const result = aggregate({
      findings: [f],
      reviewersTotal: 1,
      fpActive: new Map([["sig1", { id: "FP-001" }]]),
      fpActiveClusters: new Map([
        [
          "prisma@prisma/schema.prisma",
          { key: "prisma@prisma/schema.prisma", member_ids: ["FP-001", "FP-002"] },
        ],
      ]),
    });
    const out = result.dedupedFindings[0];
    expect(out?.severity).toBe("INFO");
    expect(out?.fp_ledger_match?.pattern_id).toBe("FP-001");
    expect(out?.fp_cluster_match?.cluster_key).toBe("prisma@prisma/schema.prisma");
  });

  it("with no fpActiveClusters provided, no cluster demote happens (backward compat)", () => {
    const f = mkFinding();
    const result = aggregate({ findings: [f], reviewersTotal: 1 });
    expect(result.dedupedFindings[0]?.severity).toBe("WARN");
    expect(result.dedupedFindings[0]?.fp_cluster_match).toBeUndefined();
  });

  it("INFO finding stays INFO when cluster-matched (no demote-below-INFO, just tagging)", () => {
    const f = mkFinding({ severity: "INFO" });
    const result = aggregate({
      findings: [f],
      reviewersTotal: 1,
      fpActiveClusters: new Map([
        [
          "prisma@prisma/schema.prisma",
          { key: "prisma@prisma/schema.prisma", member_ids: ["FP-001"] },
        ],
      ]),
    });
    const out = result.dedupedFindings[0];
    expect(out?.severity).toBe("INFO");
    expect(out?.fp_cluster_match?.suppressed).toBe(true);
  });
});
