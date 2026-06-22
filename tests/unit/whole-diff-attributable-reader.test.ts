// tests/unit/whole-diff-attributable-reader.test.ts
//
// S2 (field report 2026-06-23): the decisions-gate readers for the out-of-session handoff.
// POLARITY TRAP (Plan-Gate v2): unlike foreignFlagsById (absent flag → false), these must
// default absent/missing/malformed → the FAIL-CLOSED direction so a single-agent run, a cache-hit
// PASS, and an ERROR write all DISABLE disown:
//   wholeDiffAttributable → TRUE  (the session has skin in the diff → disown unavailable)
//   sessionAttributableById per finding → TRUE (attributable → that finding is non-disownable)
import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sessionAttributableById, wholeDiffAttributable } from "../../src/core/loop-driver.ts";
import { pendingJsonPath } from "../../src/utils/paths.ts";

function repoWith(report: unknown): string {
  const repo = mkdtempSync(join(tmpdir(), "rg-wda-"));
  mkdirSync(dirname(pendingJsonPath(repo)), { recursive: true });
  writeFileSync(
    pendingJsonPath(repo),
    typeof report === "string" ? report : JSON.stringify(report),
  );
  return repo;
}

describe("wholeDiffAttributable reader (absent → TRUE, fail-closed)", () => {
  it("reads an explicit false", () => {
    expect(wholeDiffAttributable(repoWith({ whole_diff_attributable: false, findings: [] }))).toBe(
      false,
    );
  });
  it("reads an explicit true", () => {
    expect(wholeDiffAttributable(repoWith({ whole_diff_attributable: true, findings: [] }))).toBe(
      true,
    );
  });
  it("defaults a MISSING key to true (single-agent / non-main writeReport path)", () => {
    expect(wholeDiffAttributable(repoWith({ findings: [] }))).toBe(true);
  });
  it("defaults a missing pending.json to true", () => {
    const repo = mkdtempSync(join(tmpdir(), "rg-wda-none-"));
    expect(wholeDiffAttributable(repo)).toBe(true);
  });
  it("defaults malformed JSON to true", () => {
    expect(wholeDiffAttributable(repoWith("{not json"))).toBe(true);
  });
});

describe("sessionAttributableById reader (absent → TRUE per finding, fail-closed)", () => {
  it("maps explicit false/true and defaults absent to true", () => {
    const repo = repoWith({
      findings: [
        { id: "F-1", session_attributable: false },
        { id: "F-2", session_attributable: true },
        { id: "F-3" },
      ],
    });
    const m = sessionAttributableById(repo);
    expect(m.get("F-1")).toBe(false);
    expect(m.get("F-2")).toBe(true);
    expect(m.get("F-3")).toBe(true); // absent → attributable → non-disownable
  });
});
