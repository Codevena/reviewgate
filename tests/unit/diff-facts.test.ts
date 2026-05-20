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
});
