// tests/unit/decisions-gate-out-of-scope.test.ts
//
// Slice B (P2): "out-of-scope" is the honest "not mine" disposition. It satisfies the gate
// ONLY for a finding flagged foreign_to_session (Slice A's ownership snapshot) — fail-CLOSED
// otherwise so the agent can never out-of-scope its OWN code. Unlike acknowledged-low-value,
// it IS allowed on a CRITICAL/security finding (a foreign one), and requires a >= 20 reason.
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { evaluateDecisions } from "../../src/core/loop-driver.ts";
import { decisionsPath, pendingJsonPath } from "../../src/utils/paths.ts";

function setup(
  findings: Array<{ id: string; severity: string; category: string; foreign?: boolean }>,
  decisions: Array<{ finding_id: string; action: string; reason?: string }>,
  opts: { writeFinding?: boolean } = {},
): { repo: string; iter: number } {
  const repo = mkdtempSync(join(tmpdir(), "rg-oos-"));
  mkdirSync(dirname(pendingJsonPath(repo)), { recursive: true });
  writeFileSync(
    pendingJsonPath(repo),
    JSON.stringify({
      findings: (opts.writeFinding === false ? [] : findings).map((f) => ({
        id: f.id,
        signature: `sig-${f.id}`,
        severity: f.severity,
        category: f.category,
        rule_id: "r",
        file: "foreign.ts",
        line_start: 1,
        line_end: 1,
        message: "m",
        details: "d",
        reviewer: { provider: "codex", model: "x", persona: "security" },
        confidence: 0.9,
        consensus: "singleton",
        ...(f.foreign ? { foreign_to_session: true } : {}),
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
          ...(d.reason ? { reason: d.reason } : {}),
        }),
      )
      .join("\n")}\n`,
  );
  return { repo, iter };
}

const REASON = "This file belongs to the parallel SEO-sitemap agent; not my change to touch.";

describe("decisions-gate out-of-scope (P2)", () => {
  it("addresses a FOREIGN finding (incl. CRITICAL/security) with a >= 20 reason", () => {
    const { repo, iter } = setup(
      [{ id: "F-001", severity: "CRITICAL", category: "security", foreign: true }],
      [{ finding_id: "F-001", action: "out-of-scope", reason: REASON }],
    );
    const gate = evaluateDecisions(repo, iter, ["F-001"]);
    expect(gate.addressed).toBe(true);
    expect(gate.invalid).toHaveLength(0);
  });

  it("does NOT address a finding NOT flagged foreign (fail-closed — can't disown own code)", () => {
    const { repo, iter } = setup(
      [{ id: "F-001", severity: "WARN", category: "quality", foreign: false }],
      [{ finding_id: "F-001", action: "out-of-scope", reason: REASON }],
    );
    const gate = evaluateDecisions(repo, iter, ["F-001"]);
    expect(gate.addressed).toBe(false);
    expect(gate.invalid.join(" ")).toContain("out-of-scope");
  });

  it("does NOT address when the finding is absent from pending.json (no flag → fail-closed)", () => {
    const { repo, iter } = setup(
      [{ id: "F-001", severity: "WARN", category: "quality", foreign: true }],
      [{ finding_id: "F-001", action: "out-of-scope", reason: REASON }],
      { writeFinding: false },
    );
    const gate = evaluateDecisions(repo, iter, ["F-001"]);
    expect(gate.addressed).toBe(false);
  });

  it("rejects a too-short out-of-scope reason (schema)", () => {
    const { repo, iter } = setup(
      [{ id: "F-001", severity: "WARN", category: "quality", foreign: true }],
      [{ finding_id: "F-001", action: "out-of-scope", reason: "not mine" }],
    );
    const gate = evaluateDecisions(repo, iter, ["F-001"]);
    expect(gate.addressed).toBe(false);
  });
});
