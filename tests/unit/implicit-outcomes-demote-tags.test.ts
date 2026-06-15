// tests/unit/implicit-outcomes-demote-tags.test.ts
//
// Finding 8: reasonOf() omitted the demote tags fp_cluster_match, fact_invalid,
// and grounding_demoted — the STRONGEST hallucination signals — so those
// demoted survivors produced NO learning outcome at all. They are now mapped to
// dedicated demote reasons (added to DEMOTE_REASONS).
import { describe, expect, it } from "bun:test";
import { deriveImplicitOutcomes } from "../../src/core/learnings/implicit-outcomes.ts";
import type { Finding } from "../../src/schemas/finding.ts";
import { DEMOTE_REASONS } from "../../src/schemas/implicit-outcome.ts";

const base = (over: Partial<Finding>): Finding =>
  ({
    id: "F",
    signature: "s",
    severity: "INFO",
    category: "correctness",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.5,
    consensus: "singleton",
    ...over,
  }) as Finding;

const ctx = { runId: "RUN", iter: 2, nowIso: "2026-06-15T00:00:00Z" };

describe("deriveImplicitOutcomes — the previously-omitted hallucination demote tags (Finding 8)", () => {
  it("DEMOTE_REASONS includes the three new reasons", () => {
    expect(DEMOTE_REASONS).toContain("fact_invalid");
    expect(DEMOTE_REASONS).toContain("grounding_demoted");
    expect(DEMOTE_REASONS).toContain("fp_cluster_match");
  });

  it("maps fact_invalid → fact_invalid", () => {
    const out = deriveImplicitOutcomes([base({ signature: "fi", fact_invalid: true })], [], ctx);
    expect(out).toHaveLength(1);
    expect(out[0]?.demote_reason).toBe("fact_invalid");
  });

  it("maps grounding_demoted → grounding_demoted", () => {
    const out = deriveImplicitOutcomes(
      [base({ signature: "gd", grounding_demoted: true })],
      [],
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.demote_reason).toBe("grounding_demoted");
  });

  it("maps fp_cluster_match → fp_cluster_match", () => {
    const out = deriveImplicitOutcomes(
      [
        base({
          signature: "fc",
          fp_cluster_match: { cluster_key: "rule@a.ts", member_ids: ["FP-1"], suppressed: true },
        }),
      ],
      [],
      ctx,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.demote_reason).toBe("fp_cluster_match");
  });

  it("ranks fact_invalid / grounding_demoted ahead of softer demotes, fp_cluster next to fp_ledger", () => {
    const demoted = [
      base({ signature: "fi", fact_invalid: true, scope_demoted: true, low_confidence: true }),
      base({ signature: "gd", grounding_demoted: true, scope_demoted: true }),
      base({
        signature: "fc",
        fp_cluster_match: { cluster_key: "k", member_ids: [], suppressed: true },
        reputation_demoted: true,
      }),
    ];
    const out = deriveImplicitOutcomes(demoted, [], ctx);
    const byReason = Object.fromEntries(out.map((o) => [o.signature, o.demote_reason]));
    expect(byReason).toEqual({
      fi: "fact_invalid", // beats scope_demoted + low_confidence
      gd: "grounding_demoted", // beats scope_demoted
      fc: "fp_cluster_match", // beats reputation_demoted
    });
  });

  it("critic_likely_fp still wins over fact_invalid (highest priority unchanged)", () => {
    const out = deriveImplicitOutcomes(
      [base({ signature: "x", critic_verdict: "likely_fp", fact_invalid: true })],
      [],
      ctx,
    );
    expect(out[0]?.demote_reason).toBe("critic_likely_fp");
  });
});
