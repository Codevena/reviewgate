// tests/unit/decisions-gate-out-of-session.test.ts
//
// S2 (field report 2026-06-23): "out-of-session" is the honest "this whole change-set is not my
// session's work" disposition for COMMITTED-foreign work. The decisions-gate accepts it ONLY when
//   - the finding is NOT session-attributable (session_attributable === false), AND
//   - the WHOLE diff has zero session-attributable files (whole_diff_attributable === false), AND
//   - the finding is not a deterministic check (R2).
// Every gap is fail-CLOSED (absent flag → attributable/whole-diff true → REJECTED).
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { evaluateDecisions } from "../../src/core/loop-driver.ts";
import { decisionsPath, pendingJsonPath } from "../../src/utils/paths.ts";

const REASON =
  "The entire change-set is the parallel SEO agent's committed work; not my session's.";

function setup(
  finding: {
    id: string;
    severity: string;
    category: string;
    session_attributable?: boolean;
    deterministic?: boolean;
  },
  decision: { action: string; reason?: string },
  wholeDiff: boolean | undefined,
): { repo: string; iter: number } {
  const repo = mkdtempSync(join(tmpdir(), "rg-oosession-"));
  mkdirSync(dirname(pendingJsonPath(repo)), { recursive: true });
  writeFileSync(
    pendingJsonPath(repo),
    JSON.stringify({
      findings: [
        {
          id: finding.id,
          signature: `sig-${finding.id}`,
          severity: finding.severity,
          category: finding.category,
          rule_id: "r",
          file: "seo-spec.ts",
          line_start: 1,
          line_end: 1,
          message: "m",
          details: "d",
          reviewer: { provider: "codex", model: "x", persona: "security" },
          confidence: 0.9,
          consensus: "singleton",
          ...(finding.session_attributable !== undefined
            ? { session_attributable: finding.session_attributable }
            : {}),
          ...(finding.deterministic ? { deterministic: true } : {}),
        },
      ],
      counts: { critical: 0, warn: 0, info: 0 },
      ...(wholeDiff !== undefined ? { whole_diff_attributable: wholeDiff } : {}),
    }),
  );
  const iter = 1;
  mkdirSync(dirname(decisionsPath(repo, iter)), { recursive: true });
  writeFileSync(
    decisionsPath(repo, iter),
    `${JSON.stringify({
      schema: "reviewgate.decision.v1",
      finding_id: finding.id,
      verdict: "accepted",
      action: decision.action,
      ...(decision.reason ? { reason: decision.reason } : {}),
    })}\n`,
  );
  return { repo, iter };
}

describe("decisions-gate out-of-session (S2)", () => {
  it("addresses a non-attributable finding when whole_diff_attributable is false", () => {
    const { repo, iter } = setup(
      { id: "F-001", severity: "CRITICAL", category: "security", session_attributable: false },
      { action: "out-of-session", reason: REASON },
      false,
    );
    const gate = evaluateDecisions(repo, iter, ["F-001"]);
    expect(gate.addressed).toBe(true);
    expect(gate.invalid).toHaveLength(0);
  });

  it("does NOT address an ATTRIBUTABLE finding (can't disown own work)", () => {
    const { repo, iter } = setup(
      { id: "F-001", severity: "WARN", category: "quality", session_attributable: true },
      { action: "out-of-session", reason: REASON },
      false,
    );
    const gate = evaluateDecisions(repo, iter, ["F-001"]);
    expect(gate.addressed).toBe(false);
    expect(gate.invalid.join(" ")).toContain("out-of-session");
  });

  it("does NOT address when whole_diff_attributable is TRUE (mixed-diff guard, Plan-Gate C4)", () => {
    const { repo, iter } = setup(
      { id: "F-001", severity: "CRITICAL", category: "security", session_attributable: false },
      { action: "out-of-session", reason: REASON },
      true,
    );
    const gate = evaluateDecisions(repo, iter, ["F-001"]);
    expect(gate.addressed).toBe(false);
  });

  it("does NOT address when whole_diff_attributable is ABSENT (single-agent fail-closed)", () => {
    const { repo, iter } = setup(
      { id: "F-001", severity: "WARN", category: "quality", session_attributable: false },
      { action: "out-of-session", reason: REASON },
      undefined,
    );
    const gate = evaluateDecisions(repo, iter, ["F-001"]);
    expect(gate.addressed).toBe(false);
  });

  it("does NOT address a DETERMINISTIC check via out-of-session (R2)", () => {
    const { repo, iter } = setup(
      {
        id: "F-001",
        severity: "CRITICAL",
        category: "correctness",
        session_attributable: false,
        deterministic: true,
      },
      { action: "out-of-session", reason: REASON },
      false,
    );
    const gate = evaluateDecisions(repo, iter, ["F-001"]);
    expect(gate.addressed).toBe(false);
  });

  it("rejects a too-short out-of-session reason (schema)", () => {
    const { repo, iter } = setup(
      { id: "F-001", severity: "WARN", category: "quality", session_attributable: false },
      { action: "out-of-session", reason: "not mine" },
      false,
    );
    const gate = evaluateDecisions(repo, iter, ["F-001"]);
    expect(gate.addressed).toBe(false);
  });
});
