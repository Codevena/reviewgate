import { describe, expect, it } from "bun:test";
import { parseChangedRanges, rangeOverlapsChanged } from "../../src/diff/hunks.ts";

const MODIFY = [
  "diff --git a/src/lib/foo.ts b/src/lib/foo.ts",
  "index 111..222 100644",
  "--- a/src/lib/foo.ts",
  "+++ b/src/lib/foo.ts",
  "@@ -10,3 +10,4 @@ export function foo() {",
  " context",
  "+added line",
  " context",
  "@@ -40,0 +41,2 @@ other",
  "+two",
  "+lines",
].join("\n");

const NEWFILE = [
  "diff --git a/new.ts b/new.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.ts",
  "@@ -0,0 +1,3 @@",
  "+a",
  "+b",
  "+c",
].join("\n");

const DELETED = [
  "diff --git a/gone.ts b/gone.ts",
  "deleted file mode 100644",
  "--- a/gone.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-x",
  "-y",
].join("\n");

describe("parseChangedRanges", () => {
  it("collects multi-hunk new-file ranges, repo-relative, stripping b/ prefix", () => {
    expect(parseChangedRanges(MODIFY).get("src/lib/foo.ts")).toEqual([
      [10, 14],
      [41, 43],
    ]);
  });
  it("covers all lines of an added file", () => {
    expect(parseChangedRanges(NEWFILE).get("new.ts")).toEqual([[1, 4]]);
  });
  it("yields no entry for a deleted file (new-side /dev/null)", () => {
    expect(parseChangedRanges(DELETED).has("gone.ts")).toBe(false);
  });
  it("ignores deletion-only hunks (+c,0)", () => {
    const d = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -5,2 +5,0 @@",
      "-g1",
      "-g2",
    ].join("\n");
    expect(parseChangedRanges(d).get("x.ts") ?? []).toEqual([]);
  });
  it("parses concatenated diff streams", () => {
    expect(parseChangedRanges(`${MODIFY}\n${NEWFILE}`).size).toBe(2);
  });
});

describe("rangeOverlapsChanged", () => {
  const ranges = [
    [10, 14],
    [41, 43],
  ] as Array<[number, number]>;
  it("true when the finding range intersects a changed range", () => {
    expect(rangeOverlapsChanged(11, 11, ranges)).toBe(true);
    expect(rangeOverlapsChanged(8, 12, ranges)).toBe(true);
    expect(rangeOverlapsChanged(42, 42, ranges)).toBe(true);
  });
  it("false when entirely outside every changed range", () => {
    expect(rangeOverlapsChanged(20, 25, ranges)).toBe(false);
  });
});
