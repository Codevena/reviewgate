// tests/unit/decisions-gate-acknowledge.test.ts
// N2 off-ramp: `acknowledged-low-value` is a valid disposition ONLY for an INFO/WARN
// finding that is not security/correctness. A CRITICAL or security/correctness finding
// can never be acknowledged away — it stays required (the gate keeps blocking).
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { evaluateDecisions } from "../../src/core/loop-driver.ts";
import { decisionsPath, pendingJsonPath } from "../../src/utils/paths.ts";

function setup(
  findings: Array<{ id: string; severity: string; category: string }>,
  decisions: Array<{ finding_id: string; action: string }>,
): { repo: string; iter: number } {
  const repo = mkdtempSync(join(tmpdir(), "rg-ack-"));
  mkdirSync(dirname(pendingJsonPath(repo)), { recursive: true });
  writeFileSync(
    pendingJsonPath(repo),
    JSON.stringify({
      findings: findings.map((f) => ({
        id: f.id,
        signature: `sig-${f.id}`,
        severity: f.severity,
        category: f.category,
        rule_id: "r",
        file: "a.ts",
        line_start: 1,
        line_end: 1,
        message: "m",
        details: "d",
        reviewer: { provider: "codex", model: "x", persona: "security" },
        confidence: 0.9,
        consensus: "singleton",
      })),
      counts: { critical: 0, warn: 0, info: 0 },
    }),
  );
  const iter = 1;
  mkdirSync(dirname(decisionsPath(repo, iter)), { recursive: true });
  writeFileSync(
    decisionsPath(repo, iter),
    `${decisions
      .map((d) =>
        JSON.stringify({
          schema: "reviewgate.decision.v1",
          finding_id: d.finding_id,
          verdict: "accepted",
          action: d.action,
        }),
      )
      .join("\n")}\n`,
  );
  return { repo, iter };
}

describe("decisions-gate acknowledged-low-value (N2)", () => {
  it("addresses a WARN/quality finding (off-ramp allowed)", () => {
    const { repo, iter } = setup(
      [{ id: "F-001", severity: "WARN", category: "quality" }],
      [{ finding_id: "F-001", action: "acknowledged-low-value" }],
    );
    const gate = evaluateDecisions(repo, iter, ["F-001"]);
    expect(gate.addressed).toBe(true);
    expect(gate.invalid).toHaveLength(0);
  });

  it("does NOT address a CRITICAL finding (stays blocking)", () => {
    const { repo, iter } = setup(
      [{ id: "F-001", severity: "CRITICAL", category: "quality" }],
      [{ finding_id: "F-001", action: "acknowledged-low-value" }],
    );
    const gate = evaluateDecisions(repo, iter, ["F-001"]);
    expect(gate.addressed).toBe(false);
    expect(gate.invalid.join(" ")).toContain("acknowledged-low-value");
  });

  it("does NOT address a security finding even at WARN (stays blocking)", () => {
    const { repo, iter } = setup(
      [{ id: "F-001", severity: "WARN", category: "security" }],
      [{ finding_id: "F-001", action: "acknowledged-low-value" }],
    );
    const gate = evaluateDecisions(repo, iter, ["F-001"]);
    expect(gate.addressed).toBe(false);
  });

  it("does NOT address a correctness finding (stays blocking)", () => {
    const { repo, iter } = setup(
      [{ id: "F-001", severity: "WARN", category: "correctness" }],
      [{ finding_id: "F-001", action: "acknowledged-low-value" }],
    );
    const gate = evaluateDecisions(repo, iter, ["F-001"]);
    expect(gate.addressed).toBe(false);
  });

  it("does NOT address a finding whose MEMBER is security even if the representative is quality (N2)", () => {
    // A wording-similarity merge can park a security concern as a MEMBER under a quality
    // representative — the off-ramp must look past the representative category (mirroring
    // the aggregator's touchesSecurityOrCorrectness) or a real security finding leaks through.
    const repo = mkdtempSync(join(tmpdir(), "rg-ack-mem-"));
    mkdirSync(dirname(pendingJsonPath(repo)), { recursive: true });
    writeFileSync(
      pendingJsonPath(repo),
      JSON.stringify({
        findings: [
          {
            id: "F-001",
            signature: "sig",
            severity: "WARN",
            category: "quality",
            rule_id: "r",
            file: "a.ts",
            line_start: 1,
            line_end: 1,
            message: "m",
            details: "d",
            reviewer: { provider: "codex", model: "x", persona: "security" },
            confidence: 0.9,
            consensus: "singleton",
            members: [{ signature: "s2", provider: "gemini", rule_id: "r2", category: "security" }],
          },
        ],
        counts: { critical: 0, warn: 1, info: 0 },
      }),
    );
    const iter = 1;
    mkdirSync(dirname(decisionsPath(repo, iter)), { recursive: true });
    writeFileSync(
      decisionsPath(repo, iter),
      `${JSON.stringify({
        schema: "reviewgate.decision.v1",
        finding_id: "F-001",
        verdict: "accepted",
        action: "acknowledged-low-value",
      })}\n`,
    );
    const gate = evaluateDecisions(repo, iter, ["F-001"]);
    expect(gate.addressed).toBe(false);
  });

  it("still accepts a normal fixed decision (regression)", () => {
    const { repo, iter } = setup(
      [{ id: "F-001", severity: "CRITICAL", category: "security" }],
      [{ finding_id: "F-001", action: "fixed" }],
    );
    const gate = evaluateDecisions(repo, iter, ["F-001"]);
    expect(gate.addressed).toBe(true);
  });
});
