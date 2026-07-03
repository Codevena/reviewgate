// tests/unit/delta-scope.test.ts
//
// T4 / R2 (field report 2026-07-03): delta-scope policy demote. The field's #1
// pain: every fix re-reviewed the FULL batch diff, and each round the panel drew
// fresh nits from the unchanged 95%. On iteration >= 2 the GATING scope narrows
// to what changed since the prior reviewed snapshot (+ files of prior blocking
// findings); a new blocking finding outside it renders as INFO (demote-not-drop).
import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import { computeDeltaScope } from "../../src/core/reviewed-snapshot.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    severity: "WARN",
    category: "quality",
    rule_id: "r",
    file: "src/unchanged.ts",
    line_start: 10,
    line_end: 12,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "x", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    signature: "sig-1",
    ...over,
  } as Finding;
}

const P = { status: "present" as const };

describe("computeDeltaScope", () => {
  it("null prior snapshot → null (pass inert, full scope)", () => {
    expect(computeDeltaScope({ "a.ts": { ...P, hash: "h1" } }, null, [])).toBeNull();
  });

  it("changed hash, new file, and prior-blocking files are in scope; unchanged files are not", () => {
    const scope = computeDeltaScope(
      {
        "src/changed.ts": { ...P, hash: "NEW" },
        "src/unchanged.ts": { ...P, hash: "SAME" },
        "src/added.ts": { ...P, hash: "h3" },
      },
      {
        files: {
          "src/changed.ts": { ...P, hash: "OLD" },
          "src/unchanged.ts": { ...P, hash: "SAME" },
        },
      },
      ["./src/contested.ts"],
    );
    expect(scope).not.toBeNull();
    expect([...(scope as Set<string>)].sort()).toEqual([
      "src/added.ts",
      "src/changed.ts",
      "src/contested.ts", // normalized from ./src/contested.ts
    ]);
  });

  it("hash:null on either side keeps the file in scope (fail-safe)", () => {
    const scope = computeDeltaScope(
      {
        "src/unreadable-now.ts": { status: "unreadable", hash: null },
        "src/unreadable-then.ts": { ...P, hash: "h" },
      },
      {
        files: {
          "src/unreadable-now.ts": { ...P, hash: "h" },
          "src/unreadable-then.ts": { status: "unreadable", hash: null },
        },
      },
      [],
    );
    expect([...(scope as Set<string>)].sort()).toEqual([
      "src/unreadable-now.ts",
      "src/unreadable-then.ts",
    ]);
  });

  it("status change (present → deleted) is in scope even with equal-null hashes", () => {
    const scope = computeDeltaScope(
      { "src/gone.ts": { status: "deleted", hash: null } },
      { files: { "src/gone.ts": { ...P, hash: "h" } } },
      [],
    );
    expect([...(scope as Set<string>)]).toEqual(["src/gone.ts"]);
  });
});

describe("aggregator delta-scope pass (R2)", () => {
  const SCOPE = new Set(["src/changed.ts"]);

  it("demotes an out-of-delta quality WARN to INFO with the badge flag", () => {
    const agg = aggregate({
      findings: [finding({})], // src/unchanged.ts, not in scope
      reviewersTotal: 2,
      deltaScope: SCOPE,
    });
    const f = agg.dedupedFindings[0];
    expect(f?.severity).toBe("INFO");
    expect(f?.delta_scope_demoted).toBe(true);
    expect(f?.demoted_from_critical).toBeUndefined(); // structural demote, G0-exempt
    expect(agg.verdict).toBe("PASS");
  });

  it("a finding on an in-scope file stays blocking", () => {
    const agg = aggregate({
      findings: [finding({ file: "src/changed.ts" })],
      reviewersTotal: 2,
      deltaScope: SCOPE,
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("WARN");
    expect(agg.dedupedFindings[0]?.delta_scope_demoted).toBeUndefined();
  });

  it("security/correctness (any member) out-of-delta stays blocking", () => {
    const sec = aggregate({
      findings: [finding({ category: "security", severity: "CRITICAL" })],
      reviewersTotal: 2,
      deltaScope: SCOPE,
    });
    expect(sec.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(sec.verdict).toBe("FAIL");
    // Two same-wording findings on the same lines merge into one cluster whose
    // members span quality + correctness — the exemption must look past the
    // representative's own category.
    const a = finding({
      signature: "sig-a",
      category: "correctness",
      message: "identical wording so the two findings merge into one cluster",
    });
    const b = finding({
      signature: "sig-b",
      category: "quality",
      rule_id: "other-rule",
      message: "identical wording so the two findings merge into one cluster",
    });
    const corrMember = aggregate({
      findings: [a, b],
      reviewersTotal: 2,
      deltaScope: SCOPE,
    });
    expect(corrMember.dedupedFindings[0]?.members?.length).toBe(2);
    expect(corrMember.dedupedFindings[0]?.severity).toBe("WARN"); // untouched
    expect(corrMember.dedupedFindings[0]?.delta_scope_demoted).toBeUndefined();
  });

  it("a §4.3 claimed-fixed recurrence out-of-delta stays pinned blocking", () => {
    const agg = aggregate({
      findings: [finding({ signature: "sig-pin" })],
      reviewersTotal: 2,
      deltaScope: SCOPE,
      claimedFixed: new Map([["sig-pin", 1]]),
    });
    const f = agg.dedupedFindings[0];
    expect(f?.severity).toBe("WARN");
    expect(f?.claimed_fixed_recurred).toEqual({ iter: 1 });
    expect(f?.delta_scope_demoted).toBeUndefined();
  });

  it("honors the outOfDiffBlocking escape hatch (configured category stays blocking out-of-delta)", () => {
    const agg = aggregate({
      findings: [finding({ category: "performance" })],
      reviewersTotal: 2,
      deltaScope: SCOPE,
      outOfDiffBlocking: ["performance"],
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("WARN");
    expect(agg.dedupedFindings[0]?.delta_scope_demoted).toBeUndefined();
  });

  it("never pushes a demoted_from_critical WARN to INFO (G0 alignment)", () => {
    const agg = aggregate({
      findings: [finding({ demoted_from_critical: true })],
      reviewersTotal: 2,
      deltaScope: SCOPE,
    });
    expect(agg.dedupedFindings[0]?.severity).toBe("WARN");
    expect(agg.dedupedFindings[0]?.delta_scope_demoted).toBeUndefined();
  });

  it("no deltaScope input → pass inert (iteration-1 / one-shot behavior unchanged)", () => {
    const agg = aggregate({ findings: [finding({})], reviewersTotal: 2 });
    expect(agg.dedupedFindings[0]?.severity).toBe("WARN");
    expect(agg.dedupedFindings[0]?.delta_scope_demoted).toBeUndefined();
  });

  it("normalizes reviewer path variants ('./src/changed.ts' matches the scope)", () => {
    const agg = aggregate({
      findings: [finding({ file: "./src/changed.ts" })],
      reviewersTotal: 2,
      deltaScope: SCOPE,
    });
    expect(agg.dedupedFindings[0]?.delta_scope_demoted).toBeUndefined();
    expect(agg.dedupedFindings[0]?.severity).toBe("WARN");
  });
});
