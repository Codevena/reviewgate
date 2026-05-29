// tests/unit/gate-diff-incomplete.test.ts
//
// The gate must only treat a diff as INCOMPLETE when collectDiff actually
// appended its trailer marker — NOT when the literal marker string merely
// appears inside the diff body (e.g. when src/utils/git.ts itself, which
// defines the marker constant, is edited and shows up in the reviewed diff).
//
// collectDiff only ever appends the marker as the final trailing line:
//   `${out}\n\n${DIFF_INCOMPLETE_MARKER}\n`
// so a genuine signal is the marker at the END of the diff, whereas a marker
// buried in a diff hunk (file content) must NOT count.
import { describe, expect, it } from "bun:test";
import { diffMarkedIncomplete } from "../../src/cli/commands/gate.ts";
import { DIFF_INCOMPLETE_MARKER } from "../../src/utils/git.ts";

describe("diffMarkedIncomplete", () => {
  it("is true when collectDiff appended the trailer marker", () => {
    // Exactly how collectDiff appends it (git.ts:152).
    const diff = `diff --git a/foo b/foo\n+changed\n\n${DIFF_INCOMPLETE_MARKER}\n`;
    expect(diffMarkedIncomplete(diff)).toBe(true);
  });

  it("is true with no trailing newline after the marker", () => {
    const diff = `diff --git a/foo b/foo\n+changed\n\n${DIFF_INCOMPLETE_MARKER}`;
    expect(diffMarkedIncomplete(diff)).toBe(true);
  });

  it("is FALSE when the marker only appears inside a diff hunk (file content)", () => {
    // Simulates editing src/utils/git.ts where the marker constant is DEFINED:
    // the literal string lands in an added line of the reviewed diff, but the
    // collection was NOT truncated, so the diff does not END with the marker.
    const diff = [
      "diff --git a/src/utils/git.ts b/src/utils/git.ts",
      "@@ -41,2 +41,2 @@",
      "+export const DIFF_INCOMPLETE_MARKER =",
      `+  "${DIFF_INCOMPLETE_MARKER}";`,
      "diff --git a/other.ts b/other.ts",
      "+const x = 1;",
      "",
    ].join("\n");
    expect(diffMarkedIncomplete(diff)).toBe(false);
  });

  it("is false for an empty diff", () => {
    expect(diffMarkedIncomplete("")).toBe(false);
  });
});
