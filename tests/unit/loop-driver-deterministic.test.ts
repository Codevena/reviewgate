import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateDecisions } from "../../src/core/loop-driver.ts";
import { decisionsPath, pendingJsonPath } from "../../src/utils/paths.ts";

function repoWithDeterministicFinding(): string {
  const repo = mkdtempSync(join(tmpdir(), "rg-det-dec-"));
  mkdirSync(join(repo, ".reviewgate", "decisions"), { recursive: true });
  const finding = {
    id: "check-typecheck",
    signature: "check:typecheck",
    severity: "CRITICAL",
    category: "correctness",
    rule_id: "deterministic-check/typecheck",
    file: "(deterministic check: typecheck)",
    line_start: 1,
    line_end: 1,
    message: "Deterministic check failed",
    details: "tsc error",
    reviewer: { provider: "checks", model: "deterministic", persona: "checks" },
    confidence: 1,
    consensus: "singleton",
    deterministic: true,
  };
  writeFileSync(
    pendingJsonPath(repo),
    JSON.stringify({ schema: "reviewgate.pending.v1", findings: [finding] }),
  );
  return repo;
}

describe("evaluateDecisions — deterministic findings are reject-forbidden", () => {
  it("treats a `rejected` decision for a deterministic finding as invalid", () => {
    const repo = repoWithDeterministicFinding();
    writeFileSync(
      decisionsPath(repo, 1),
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "check-typecheck", verdict: "rejected", reason: "I think the compiler is wrong about this one." })}\n`,
    );
    const gate = evaluateDecisions(repo, 1, ["check-typecheck"]);
    expect(gate.addressed).toBe(false);
    expect(gate.invalid.join(" ")).toContain("deterministic");
  });

  it("accepts an `accepted/fixed` decision for a deterministic finding", () => {
    const repo = repoWithDeterministicFinding();
    writeFileSync(
      decisionsPath(repo, 1),
      `${JSON.stringify({ schema: "reviewgate.decision.v1", finding_id: "check-typecheck", verdict: "accepted", action: "fixed", files_touched: ["src/x.ts"] })}\n`,
    );
    const gate = evaluateDecisions(repo, 1, ["check-typecheck"]);
    expect(gate.addressed).toBe(true);
  });
});
