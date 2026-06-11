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
  it("parses a filename that contains the literal substring ' b/'", () => {
    // `diff --git a/<X> b/<X>` is symmetric: a lazy a-side capture stops at the
    // FIRST " b/" inside the filename, mis-splitting the header. The path must be
    // recovered as the real b-side, not "c.ts b/src/a b/c.ts".
    const diff =
      "diff --git a/src/a b/c.ts b/src/a b/c.ts\n--- a/src/a b/c.ts\n+++ b/src/a b/c.ts\n@@ -1 +1 @@\n-x\n+y\n";
    const f = computeDiffFacts(diff);
    expect(f.files.map((x) => x.path)).toEqual(["src/a b/c.ts"]);
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

  it("counts removed content lines starting with '--' (SQL comments render as '--- …') — F-14", () => {
    // Deleting a commented-out SQL block: every removed line `-- foo` renders in
    // the diff as `--- foo`. The old header-prefix filter excluded them all →
    // added=0/removed=0 → file filtered → empty facts → triage skip → unreviewed.
    const f = computeDiffFacts(`diff --git a/db/cleanup.sql b/db/cleanup.sql
--- a/db/cleanup.sql
+++ b/db/cleanup.sql
@@ -1,3 +1,1 @@
--- drop the old table
--- (kept for reference)
 SELECT 1;
`);
    expect(f.files.length).toBe(1);
    expect(f.files[0]?.removed).toBe(2);
    expect(f.sensitivityTags).toContain("sql");
  });

  it("counts added content lines starting with '++' (`++i;` renders as '+++i;') — F-14", () => {
    const f = computeDiffFacts(`diff --git a/src/loop.c b/src/loop.c
--- a/src/loop.c
+++ b/src/loop.c
@@ -1,2 +1,3 @@
 int i = 0;
+++i;
---i;
`);
    expect(f.files[0]?.added).toBe(1);
    expect(f.files[0]?.removed).toBe(1);
  });

  it("still excludes the '---'/'+++' FILE HEADERS from the counts (F-14 state tracking)", () => {
    const f = computeDiffFacts(DIFF);
    const ts = f.files.find((x) => x.path === "src/auth/token.ts");
    // Header lines `--- a/…` / `+++ b/…` sit BEFORE the @@ and are never counted.
    expect(ts?.added).toBe(2);
    expect(ts?.removed).toBe(1);
  });

  it("flags a lockfile-only diff as lockfileOnly (F-17)", () => {
    const f = computeDiffFacts(`diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1 +1 @@
-  "version": "1.0.0",
+  "version": "1.0.1",
`);
    expect(f.files[0]?.kind).toBe("lockfile");
    expect(f.lockfileOnly).toBe(true);
  });

  it("does NOT flag a mixed lockfile+code diff as lockfileOnly (F-17)", () => {
    const f = computeDiffFacts(`diff --git a/bun.lock b/bun.lock
--- a/bun.lock
+++ b/bun.lock
@@ -1 +1 @@
-x
+y
diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -1 +1 @@
-a
+b
`);
    expect(f.lockfileOnly).toBe(false);
    expect(computeDiffFacts("").lockfileOnly).toBe(false); // empty diff is not lockfile-only
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
