// tests/unit/aggregator-claude-scope.test.ts
//
// M-B5(c) / I-17 done diff-awarely (reviewer F-003): the .claude/ harness config
// (where Reviewgate installs its hooks) is NOT blanket-excluded — an IN-DIFF hook
// change IS a supply-chain change worth reviewing. But the every-branch
// "repo-local hooks = RCE" wolf-cry on PRE-EXISTING (off-diff) .claude config is
// exploration noise: the aggregator demotes a finding on .claude/ to INFO when the
// file is NOT in the diff, regardless of category (even the security out-of-diff
// escape hatch). In-diff .claude findings still block.
import { describe, expect, it } from "bun:test";
import { aggregate } from "../../src/core/aggregator.ts";
import type { Finding } from "../../src/schemas/finding.ts";

function f(over: Partial<Finding>): Finding {
  return {
    id: "F",
    signature: `${over.file ?? "a.ts"}:${over.line_start ?? 5}`,
    severity: "CRITICAL",
    category: "security",
    rule_id: "r",
    file: "a.ts",
    line_start: 5,
    line_end: 5,
    message: "m",
    details: "d",
    reviewer: { provider: "codex", model: "x", persona: "security" },
    confidence: 0.9,
    consensus: "unanimous",
    ...over,
  } as Finding;
}

describe("aggregate — diff-aware .claude harness scoping (I-17 / F-003)", () => {
  it("demotes an OFF-DIFF security CRITICAL on .claude/settings.json (every-branch RCE noise)", () => {
    const r = aggregate({
      findings: [f({ file: ".claude/settings.json", line_start: 8 })],
      reviewersTotal: 1,
      changedRanges: new Map([["src/foo.ts", [[1, 5]] as Array<[number, number]>]]), // .claude NOT in diff
      scopeToDiff: true,
      outOfDiffBlocking: ["security"], // would normally keep it blocking
    });
    expect(r.dedupedFindings[0]?.severity).toBe("INFO");
    expect(r.dedupedFindings[0]?.scope_demoted).toBe(true);
    expect(r.verdict).not.toBe("FAIL");
  });

  it("KEEPS an IN-DIFF .claude/settings.json finding blocking (malicious hook edits stay reviewed)", () => {
    const r = aggregate({
      findings: [f({ file: ".claude/settings.json", line_start: 8, line_end: 8 })],
      reviewersTotal: 1,
      changedRanges: new Map([[".claude/settings.json", [[6, 10]] as Array<[number, number]>]]),
      scopeToDiff: true,
      outOfDiffBlocking: ["security"],
    });
    expect(r.dedupedFindings[0]?.severity).toBe("CRITICAL");
    expect(r.verdict).toBe("FAIL");
  });
});
