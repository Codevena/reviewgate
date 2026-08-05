// tests/unit/fact-check-reanchor.test.ts
//
// pilot-02 turn 2: the fact-check demoted a 0.90 path-traversal finding as "almost certainly
// hallucinated" because it cited line 67 of a 27-line file — while the reviewer's OWN
// evidence_line matched line 26 of that file verbatim. Mis-anchored, not fabricated. These
// guards pin the distinction, and pin that the fabrication protection the pass was built for
// (a CRITICAL citing a line in an EMPTY file) is untouched.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFindingFacts } from "../../src/core/fact-check.ts";
import type { Finding } from "../../src/schemas/finding.ts";

// Temp dirs created by repo(), removed after the run whether tests pass or fail.
const createdDirs: string[] = [];
afterAll(() => {
  for (const dir of createdDirs) rmSync(dir, { recursive: true, force: true });
});

const EVIDENCE = "  return readFileSync(`./templates/${name}`, 'utf8')";

function mkFinding(over: Partial<Finding> = {}): Finding {
  return {
    id: "F-001",
    signature: "sig1",
    severity: "CRITICAL",
    category: "security",
    rule_id: "path-traversal",
    file: "store.ts",
    line_start: 67,
    line_end: 67,
    message: "Path traversal vulnerability in readTemplate.",
    details: "details",
    reviewer: { provider: "openrouter", model: "deepseek/deepseek-v3.2", persona: "security" },
    confidence: 0.9,
    consensus: "singleton",
    ...over,
  };
}

function repo(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-reanchor-"));
  createdDirs.push(dir);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "store.ts"), content);
  writeFileSync(join(dir, "empty.yaml"), "");
  return dir;
}

// 5 lines, the quoted evidence at line 3.
const FIVE_LINES = `${["const a = 1", "const b = 2", EVIDENCE, "const d = 4", "const e = 5"].join("\n")}\n`;

describe("validateFindingFacts — mis-anchored vs fabricated", () => {
  // GUARD 1. WITHOUT the mechanism: severity INFO + fact_invalid -> 0 blocking.
  //          WITH it: CRITICAL kept at the quoted line 3 + anchor_repaired -> 1 blocking.
  it("re-anchors an out-of-range finding whose evidence_line matches a real line", () => {
    const dir = repo(FIVE_LINES);
    const out = validateFindingFacts(
      [mkFinding({ line_start: 67, line_end: 67, evidence_line: EVIDENCE })],
      dir,
      new Set(),
    );
    expect(out[0]?.severity).toBe("CRITICAL");
    expect(out[0]?.line_start).toBe(3);
    expect(out[0]?.line_end).toBe(3);
    expect(out[0]?.anchor_repaired).toBe(true);
    expect(out[0]?.fact_invalid).toBeUndefined();
    expect(out[0]?.details).toContain("re-anchored");
  });

  // GUARD 2 (passes on current code — MUTATION-CHECKED in Step 3).
  // WITHOUT the evidence gate (repair unconditionally): fact_invalid absent.
  // WITH it: fact_invalid true. This is the empty-file field-report case.
  it("still demotes an out-of-range finding that carries NO evidence_line", () => {
    const dir = repo(FIVE_LINES);
    const out = validateFindingFacts(
      [mkFinding({ file: "empty.yaml", line_start: 2, line_end: 2 })],
      dir,
      new Set(),
    );
    expect(out[0]?.severity).toBe("INFO");
    expect(out[0]?.fact_invalid).toBe(true);
    expect(out[0]?.anchor_repaired).toBeUndefined();
  });

  // GUARD 3 (passes on current code — MUTATION-CHECKED in Step 3).
  // WITHOUT the match test: fact_invalid absent. WITH it: fact_invalid true.
  it("still demotes when the evidence_line matches NO line of the cited file", () => {
    const dir = repo(FIVE_LINES);
    const out = validateFindingFacts(
      [mkFinding({ line_start: 67, evidence_line: "this line is nowhere in the file" })],
      dir,
      new Set(),
    );
    expect(out[0]?.severity).toBe("INFO");
    expect(out[0]?.fact_invalid).toBe(true);
    expect(out[0]?.anchor_repaired).toBeUndefined();
  });

  // GUARD 4. WITHOUT the nearest-match rule (first match wins): line_start 2.
  //          WITH it: line_start 8. Deterministic either way, but only one is the rule.
  it("resolves a multi-match to the occurrence NEAREST the cited line", () => {
    const dup = `${["a", EVIDENCE, "c", "d", "e", "f", "g", EVIDENCE, "i", "j"].join("\n")}\n`;
    const dir = repo(dup);
    const out = validateFindingFacts(
      [mkFinding({ line_start: 20, line_end: 20, evidence_line: EVIDENCE })],
      dir,
      new Set(),
    );
    expect(out[0]?.line_start).toBe(8);
    expect(out[0]?.anchor_repaired).toBe(true);
  });

  // GUARD 5 (passes on current code — MUTATION-CHECKED in Step 3).
  // WITHOUT the range check first (repair before it): line_start moves to 3.
  // WITH the correct order: line_start stays 1. The pass must never move a VALID anchor.
  it("never touches a finding whose cited line is IN range", () => {
    const dir = repo(FIVE_LINES);
    const out = validateFindingFacts(
      [mkFinding({ line_start: 1, line_end: 1, evidence_line: EVIDENCE })],
      dir,
      new Set(),
    );
    expect(out[0]?.line_start).toBe(1);
    expect(out[0]?.anchor_repaired).toBeUndefined();
    expect(out[0]?.fact_invalid).toBeUndefined();
  });

  // Robustness: the match runs under normalizeLine, so indentation/whitespace differences in
  // the reviewer's quote must not defeat it. WITHOUT normalization: no match -> demoted.
  // WITH it: re-anchored to line 3.
  it("matches the quote whitespace-insensitively", () => {
    const dir = repo(FIVE_LINES);
    const out = validateFindingFacts(
      [
        mkFinding({
          line_start: 67,
          evidence_line: "return readFileSync(`./templates/${name}`,   'utf8')",
        }),
      ],
      dir,
      new Set(),
    );
    expect(out[0]?.line_start).toBe(3);
    expect(out[0]?.anchor_repaired).toBe(true);
  });
});
