// tests/unit/diff-facts.test.ts
import { describe, expect, it } from "bun:test";
import { computeDiffFacts } from "../../src/research/diff-facts.ts";

const DIFF = `diff --git a/src/auth/token.ts b/src/auth/token.ts
--- a/src/auth/token.ts
+++ b/src/auth/token.ts
@@ -1,2 +1,2 @@
-export const x = 1;
+export const x = 2;
+export const y = 3;
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-# hi
+# hello
`;

describe("computeDiffFacts", () => {
  it("lists changed files with per-file added/removed counts", () => {
    const f = computeDiffFacts(DIFF);
    const ts = f.files.find((x) => x.path === "src/auth/token.ts");
    expect(ts?.added).toBe(2);
    expect(ts?.removed).toBe(1);
  });
  it("classifies file kinds (code / docs)", () => {
    const f = computeDiffFacts(DIFF);
    expect(f.files.find((x) => x.path === "README.md")?.kind).toBe("docs");
    expect(f.files.find((x) => x.path === "src/auth/token.ts")?.kind).toBe("code");
  });
  it("tags sensitive paths (auth/)", () => {
    const f = computeDiffFacts(DIFF);
    expect(f.sensitivityTags).toContain("auth");
  });
  it("flags doc-only diffs", () => {
    const docOnly = computeDiffFacts(`diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-a
+b
`);
    expect(docOnly.docOnly).toBe(true);
  });

  it("does not count a pure rename (no content change) as a changed file", () => {
    // git mv src/foo.ts src/bar.ts with no edits: header + rename lines, no @@.
    const f = computeDiffFacts(`diff --git a/src/foo.ts b/src/bar.ts
similarity index 100%
rename from src/foo.ts
rename to src/bar.ts
`);
    expect(f.files.length).toBe(0);
  });

  it("does not count a binary file change as a reviewable changed file", () => {
    const f = computeDiffFacts(`diff --git a/logo.png b/logo.png
index e69de29..d95f3ad 100644
Binary files a/logo.png and b/logo.png differ
`);
    expect(f.files.length).toBe(0);
  });

  it("counts a rename that also has content edits", () => {
    const f = computeDiffFacts(`diff --git a/src/foo.ts b/src/bar.ts
similarity index 90%
rename from src/foo.ts
rename to src/bar.ts
@@ -1 +1 @@
-export const x = 1;
+export const x = 2;
`);
    expect(f.files.length).toBe(1);
    expect(f.files[0]?.path).toBe("src/bar.ts");
    expect(f.files[0]?.added).toBe(1);
    expect(f.files[0]?.removed).toBe(1);
  });

  it("classifies a markdown file under tests/ as tests, not docs", () => {
    const f = computeDiffFacts(`diff --git a/tests/fixtures/expected.md b/tests/fixtures/expected.md
--- a/tests/fixtures/expected.md
+++ b/tests/fixtures/expected.md
@@ -1 +1 @@
-a
+b
`);
    expect(f.files.find((x) => x.path === "tests/fixtures/expected.md")?.kind).toBe("tests");
    expect(f.testsOnly).toBe(true);
    expect(f.docOnly).toBe(false);
  });
});
