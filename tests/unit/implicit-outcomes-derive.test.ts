import { describe, expect, it } from "bun:test";
import { deriveImplicitOutcomes } from "../../src/core/learnings/implicit-outcomes.ts";
import type { Finding } from "../../src/schemas/finding.ts";

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

describe("deriveImplicitOutcomes", () => {
  const ctx = { runId: "RUN", iter: 2, nowIso: "2026-06-02T00:00:00Z" };

  it("maps a critic-dropped finding to critic_dropped with the reviewer key", () => {
    const out = deriveImplicitOutcomes([], [base({ signature: "drp" })], ctx);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      signature: "drp",
      reviewer_key: "codex:security",
      demote_reason: "critic_dropped",
      run_id: "RUN",
      iter: 2,
    });
  });

  it("maps each demote tag with the documented priority", () => {
    const demoted = [
      base({ signature: "c", critic_verdict: "likely_fp" }),
      base({ signature: "s", scope_demoted: true }),
      base({ signature: "r", reputation_demoted: true }),
      base({ signature: "l", low_confidence: true }),
    ];
    const out = deriveImplicitOutcomes(demoted, [], ctx);
    const byReason = Object.fromEntries(out.map((o) => [o.signature, o.demote_reason]));
    expect(byReason).toEqual({
      c: "critic_likely_fp",
      s: "scope_demoted",
      r: "reputation_demoted",
      l: "low_confidence",
    });
  });

  it("ignores findings with no demote tag", () => {
    expect(deriveImplicitOutcomes([base({ severity: "WARN" })], [], ctx)).toEqual([]);
  });
});
