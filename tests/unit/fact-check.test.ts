// tests/unit/fact-check.test.ts
import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFindingFacts } from "../../src/core/fact-check.ts";
import { PolicyTraceRecorder } from "../../src/core/policy/trace.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function mkFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    signature: "sig1",
    severity: "CRITICAL",
    category: "correctness",
    rule_id: "some-rule",
    file: "real.ts",
    line_start: 1,
    line_end: 1,
    message: "msg",
    details: "details",
    reviewer: { provider: "gemini", model: "x", persona: "security" },
    confidence: 1.0,
    consensus: "singleton",
    ...over,
  };
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-factcheck-"));
  writeFileSync(join(dir, "empty.yaml"), ""); // 0 lines — the field-report F-003 case
  writeFileSync(join(dir, "real.ts"), "line1\nline2\nline3\n"); // 3 lines
  return dir;
}

describe("validateFindingFacts", () => {
  it("demotes a security CRITICAL citing an EMPTY file and records no category protection", () => {
    const dir = repo();
    const runtime = PolicyTraceRecorder.start({ runId: "fact-security", iter: 1, ablated: [] });
    const out = validateFindingFacts(
      [
        mkFinding({
          id: "F-1",
          file: "empty.yaml",
          line_start: 2,
          severity: "CRITICAL",
          category: "security",
        }),
      ],
      dir,
      new Set(),
      runtime,
    );
    expect(out[0]).toMatchObject({ severity: "INFO", fact_invalid: true });
    expect(out[0]?.details).toContain("fact-check");
    expect(runtime.summary("evidence.fact-location")).toMatchObject({
      considered: 1,
      opportunities: 1,
      would_apply: 1,
      applied: 1,
      protected: 0,
      blocking_removed: 1,
    });
    expect(out[0]?.policy_effects?.[0]).toMatchObject({
      pass_id: "evidence.fact-location",
      order: 10,
      action: "demoted",
      reason_code: "location-out-of-range",
    });
  });

  it("demotes a CRITICAL whose line is beyond the file's length (out of range)", () => {
    const dir = repo();
    const out = validateFindingFacts(
      [
        mkFinding({
          id: "F-2",
          file: "real.ts",
          line_start: 99,
          severity: "CRITICAL",
          category: "correctness",
        }),
      ],
      dir,
      new Set(),
    );
    expect(out[0]).toMatchObject({ severity: "INFO", fact_invalid: true });
  });

  it("leaves a finding whose cited line is IN range unchanged (real finding)", () => {
    const dir = repo();
    const out = validateFindingFacts(
      [
        mkFinding({
          id: "F-3",
          file: "real.ts",
          line_start: 3,
          severity: "CRITICAL",
          category: "security",
        }),
      ],
      dir,
      new Set(),
    );
    expect(out[0]?.severity).toBe("CRITICAL");
    expect(out[0]?.fact_invalid).toBeUndefined();
  });

  it("is FAIL-SAFE: leaves a finding on an ABSENT file untouched (cannot prove fabrication)", () => {
    const dir = repo();
    const out = validateFindingFacts(
      [mkFinding({ id: "F-4", file: "ghost.ts", line_start: 5, severity: "CRITICAL" })],
      dir,
      new Set(),
    );
    expect(out[0]?.severity).toBe("CRITICAL");
    expect(out[0]?.fact_invalid).toBeUndefined();
  });

  it("skips a file legitimately DELETED in the diff (not a fabrication)", () => {
    const dir = repo();
    const out = validateFindingFacts(
      [mkFinding({ id: "F-5", file: "removed.ts", line_start: 7, severity: "CRITICAL" })],
      dir,
      new Set(["removed.ts"]),
    );
    expect(out[0]?.severity).toBe("CRITICAL");
    expect(out[0]?.fact_invalid).toBeUndefined();
  });

  it("does not read THROUGH a path that escapes the repo (out-of-repo path skipped)", () => {
    const dir = repo();
    const out = validateFindingFacts(
      [mkFinding({ id: "F-6", file: "../../etc/hosts", line_start: 999, severity: "CRITICAL" })],
      dir,
      new Set(),
    );
    expect(out[0]?.severity).toBe("CRITICAL"); // skipped, not demoted
  });
});
