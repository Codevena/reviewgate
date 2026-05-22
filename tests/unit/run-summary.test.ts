// tests/unit/run-summary.test.ts
import { describe, expect, it } from "bun:test";
import { buildRunSummary } from "../../src/core/run-summary.ts";
import type { ProviderId } from "../../src/providers/registry.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function finding(over: Partial<Finding>): Finding {
  return {
    id: "F",
    signature: "s",
    severity: "CRITICAL",
    category: "security",
    rule_id: "r",
    file: "a.ts",
    line_start: 1,
    line_end: 1,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "m", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  } as Finding;
}

const run = (
  provider: ProviderId,
  persona: string,
  status: string,
  costUsd: number,
  durationMs: number,
) => ({
  res: { reviewerId: `${provider}-${persona}`, status, usage: { costUsd } } as never,
  provider,
  persona,
  durationMs,
});

describe("buildRunSummary", () => {
  it("attributes findings/demoted to the REPRESENTATIVE provider only", () => {
    const findings = [
      finding({
        signature: "s1",
        severity: "CRITICAL",
        reviewer: { provider: "codex", model: "m", persona: "security" },
      }),
      finding({
        signature: "s2",
        severity: "INFO",
        scope_demoted: true,
        reviewer: { provider: "openrouter", model: "m", persona: "security" },
      }),
    ];
    const s = buildRunSummary({
      verdict: "FAIL",
      source: "panel",
      counts: { critical: 1, warn: 0, info: 1 },
      durationMs: 100,
      criticCostUsd: 0,
      findings,
      runs: [
        run("codex", "security", "ok", 0.02, 90),
        run("openrouter", "security", "ok", 0.03, 80),
      ],
    });
    const codex = s.providers.find((p) => p.provider === "codex");
    const or = s.providers.find((p) => p.provider === "openrouter");
    expect(codex?.findings).toBe(1);
    expect(codex?.demoted).toBe(0);
    expect(or?.findings).toBe(1);
    expect(or?.demoted).toBe(1);
    expect(s.demoted).toBe(1);
    expect(s.cost_usd).toBeCloseTo(0.05);
    expect(s.signatures.sort()).toEqual(["s1"]);
  });

  it("groups multiple personas of one provider into one row with runs/errors", () => {
    const s = buildRunSummary({
      verdict: "PASS",
      source: "panel",
      counts: { critical: 0, warn: 0, info: 0 },
      durationMs: 10,
      criticCostUsd: 0,
      findings: [],
      runs: [
        run("codex", "security", "ok", 0.01, 50),
        run("codex", "architecture", "timeout", 0, 60),
      ],
    });
    const codex = s.providers.find((p) => p.provider === "codex");
    expect(codex?.runs).toBe(2);
    expect(codex?.errors).toBe(1);
    expect(codex?.personas.sort()).toEqual(["architecture", "security"]);
  });

  it("counts demoted from scope_demoted OR fp_ledger_match OR critic likely_fp; caps signatures at 20", () => {
    const findings = [
      finding({ signature: "a", fp_ledger_match: { suppressed: true } as never }),
      finding({ signature: "b", critic_verdict: "likely_fp", severity: "INFO" }),
      ...Array.from({ length: 25 }, (_, i) => finding({ signature: `w${i}`, severity: "WARN" })),
    ];
    const s = buildRunSummary({
      verdict: "FAIL",
      source: "panel",
      counts: { critical: 0, warn: 25, info: 2 },
      durationMs: 1,
      criticCostUsd: 0,
      findings,
      runs: [run("codex", "security", "ok", 0, 1)],
    });
    expect(s.demoted).toBe(2);
    expect(s.signatures.length).toBe(20);
  });

  it("builds an empty summary for a skipped/cache source", () => {
    const s = buildRunSummary({
      verdict: "PASS",
      source: "cache",
      counts: { critical: 0, warn: 0, info: 0 },
      durationMs: 3,
      criticCostUsd: 0,
      findings: [],
      runs: [],
    });
    expect(s).toEqual({
      verdict: "PASS",
      source: "cache",
      counts: { critical: 0, warn: 0, info: 0 },
      cost_usd: 0,
      duration_ms: 3,
      demoted: 0,
      signatures: [],
      providers: [],
    });
  });
});
