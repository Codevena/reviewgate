import { describe, expect, it } from "bun:test";
import { extractReferencedPaths } from "../../src/research/plan-refs.ts";

describe("extractReferencedPaths", () => {
  it("extracts code-extension paths (backtick + bare), dedup, ordered; ignores prose/non-code", () => {
    const text =
      "Use `src/a.ts` and src/b.tsx; see architecture notes.md and src/a.ts again. (src/c.py)";
    expect(extractReferencedPaths(text)).toEqual(["src/a.ts", "src/b.tsx", "src/c.py"]);
  });
  it("works on a git diff body (+/- prefixed lines)", () => {
    const diff = "diff --git a/p.md b/p.md\n@@ -1 +1 @@\n+references `src/d.ts` here\n";
    expect(extractReferencedPaths(diff)).toContain("src/d.ts");
  });
  it("drops tokens containing .. and caps the candidate list at 200", () => {
    expect(extractReferencedPaths("../../etc/passwd.ts")).toEqual([]);
    const many = Array.from({ length: 300 }, (_, i) => `src/f${i}.ts`).join(" ");
    expect(extractReferencedPaths(many).length).toBe(200);
  });
  it("a URL yields a non-repo token (downstream rejects) without suppressing a real path", () => {
    const r = extractReferencedPaths("docs at https://github.com/o/r/x.ts and `src/y.ts`");
    expect(r).toContain("src/y.ts");
  });
});
