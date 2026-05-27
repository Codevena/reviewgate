import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectReferencedFileContents,
  extractReferencedPaths,
} from "../../src/research/plan-refs.ts";

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

function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "rg-planrefs-"));
  for (const [p, c] of Object.entries(files)) {
    const abs = join(repo, p);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, c);
  }
  return repo;
}

describe("collectReferencedFileContents — resolution & safety", () => {
  it("renders existing referenced files as fenced ### blocks (3)", async () => {
    const repo = repoWith({ "src/a.ts": "export const A = 1;", "src/b.ts": "export const B = 2;" });
    const out = await collectReferencedFileContents({
      repoRoot: repo,
      planText: "see `src/a.ts` and `src/b.ts`",
      budgetBytes: 32_000,
    });
    expect(out).toContain("### src/a.ts");
    expect(out).toContain("export const A = 1;");
    expect(out).toContain("### src/b.ts");
  });
  it("rejects ../ traversal (4)", async () => {
    const repo = repoWith({ "src/a.ts": "x" });
    const out = await collectReferencedFileContents({
      repoRoot: repo,
      planText: "`../../etc/passwd.ts`",
      budgetBytes: 32_000,
    });
    expect(out).toBe("");
  });
  it("rejects a final-component symlink, pointing outside (5)", async () => {
    const repo = repoWith({ "src/a.ts": "x" });
    const outsideDir = mkdtempSync(join(tmpdir(), "rg-outside-"));
    writeFileSync(join(outsideDir, "secret.ts"), "SECRET");
    symlinkSync(join(outsideDir, "secret.ts"), join(repo, "link.ts"));
    const out = await collectReferencedFileContents({
      repoRoot: repo,
      planText: "`link.ts`",
      budgetBytes: 32_000,
    });
    expect(out).not.toContain("SECRET");
    expect(out).toBe("");
  });
  it("rejects an INTERMEDIATE dir-symlink escape (5b — the CRITICAL case)", async () => {
    const repo = repoWith({ "src/a.ts": "x" });
    const outsideDir = mkdtempSync(join(tmpdir(), "rg-outside2-"));
    writeFileSync(join(outsideDir, "secret.ts"), "SECRET");
    symlinkSync(outsideDir, join(repo, "linkdir")); // dir symlink → outside
    const out = await collectReferencedFileContents({
      repoRoot: repo,
      planText: "`linkdir/secret.ts`",
      budgetBytes: 32_000,
    });
    expect(out).not.toContain("SECRET");
    expect(out).toBe("");
  });
  it("skips excludePaths / reviewgate.config.ts / .reviewgate / .git, case-insensitively (6)", async () => {
    const repo = repoWith({
      "src/a.ts": "AA",
      "reviewgate.config.ts": "CFG",
      ".reviewgate/x.ts": "RG",
      ".git/hooks/h.ts": "GIT",
      "src/changed.ts": "CHANGED",
    });
    const out = await collectReferencedFileContents({
      repoRoot: repo,
      planText:
        "`src/a.ts` `reviewgate.config.ts` `.ReviewGate/x.ts` `.git/hooks/h.ts` `src/changed.ts`",
      budgetBytes: 32_000,
      excludePaths: ["src/changed.ts"],
    });
    expect(out).toContain("AA");
    expect(out).not.toContain("CFG");
    expect(out).not.toContain("RG");
    expect(out).not.toContain("GIT");
    expect(out).not.toContain("CHANGED");
  });
  it("skips a file containing a NUL byte (7)", async () => {
    const repo = repoWith({ "src/bin.ts": "ok\0bad" });
    const out = await collectReferencedFileContents({
      repoRoot: repo,
      planText: "`src/bin.ts`",
      budgetBytes: 32_000,
    });
    expect(out).toBe("");
  });
  it("skips non-existent paths; returns '' when nothing resolves (9)", async () => {
    const repo = repoWith({ "src/a.ts": "x" });
    expect(
      await collectReferencedFileContents({
        repoRoot: repo,
        planText: "`src/nope.ts`",
        budgetBytes: 32_000,
      }),
    ).toBe("");
    expect(
      await collectReferencedFileContents({
        repoRoot: repo,
        planText: "no paths here",
        budgetBytes: 32_000,
      }),
    ).toBe("");
  });
});
