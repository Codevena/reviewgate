// tests/unit/diff-nonascii-quotepath.test.ts
//
// Regression tests for the core.quotePath / C-quoted-header audit findings:
//
//   F1 (HIGH, fail-open): collectDiff's tracked `git diff` did not pass
//       `-c core.quotePath=false`, so a non-ASCII tracked path was C-quoted in
//       the `diff --git` header (`"a/\351\233\242.ts"`). The header regex in
//       computeDiffFacts didn't match the quoted form → the file was dropped
//       from triage facts → a non-ASCII-only change skip-PASSed UNREVIEWED.
//
//   F2 (MEDIUM): parseChangedRanges (hunks.ts) parsed the same quoted header
//       form → the file's hunks lost range attribution → real findings demoted
//       to INFO. Defensive C-unescape added so a quoted header from ANY diff
//       source still resolves to the real repo path.
//
// Both fixes: collectDiff + the untracked --no-index call now pass
// `-c core.quotePath=false` (raw UTF-8 headers); diff-facts.ts and hunks.ts
// additionally tolerate a quoted header defensively.
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChangedRanges, parseDeletedPaths } from "../../src/diff/hunks.ts";
import { computeDiffFacts } from "../../src/research/diff-facts.ts";
import { collectDiff } from "../../src/utils/git.ts";

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "rg-quotepath-"));
  spawnSync("git", ["init", "-q"], { cwd: dir });
  spawnSync("git", ["config", "user.email", "e@e"], { cwd: dir });
  spawnSync("git", ["config", "user.name", "e"], { cwd: dir });
  return dir;
}
function commit(dir: string, msg = "init"): void {
  spawnSync("git", ["add", "."], { cwd: dir });
  spawnSync("git", ["-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "-m", msg], {
    cwd: dir,
  });
}

describe("F1: collectDiff emits raw (unquoted) headers for non-ASCII paths", () => {
  it("a TRACKED non-ASCII-only change is parsed by computeDiffFacts (not dropped)", async () => {
    const dir = repo();
    writeFileSync(join(dir, "離点.ts"), "export const x = 1;\n");
    commit(dir);
    // The ONLY change in the batch is to a non-ASCII tracked file. Before the
    // `-c core.quotePath=false` fix the header was C-quoted, computeDiffFacts
    // matched nothing → files:[] → triage skip-PASSes unreviewed code.
    writeFileSync(join(dir, "離点.ts"), "export const x = 2;\n");

    const diff = await collectDiff(dir, null);
    // Header must be RAW (not C-quoted).
    expect(diff).toContain("diff --git a/離点.ts b/離点.ts");
    expect(diff).not.toContain("\\351");

    const facts = computeDiffFacts(diff);
    const f = facts.files.find((x) => x.path === "離点.ts");
    expect(f).toBeDefined();
    expect(f?.kind).toBe("code");
    expect(facts.files.length).toBeGreaterThan(0); // NOT skip-PASSed
  });

  it("an UNTRACKED non-ASCII file gets a raw header (parsed, range-attributed)", async () => {
    const dir = repo();
    commit(dir); // empty initial commit
    writeFileSync(join(dir, "新規.ts"), "export const a = 1;\n");

    const diff = await collectDiff(dir, null);
    expect(diff).toContain("diff --git a/新規.ts b/新規.ts");
    expect(diff).not.toContain("\\346"); // not C-quoted

    const facts = computeDiffFacts(diff);
    expect(facts.files.some((x) => x.path === "新規.ts")).toBe(true);

    const ranges = parseChangedRanges(diff);
    expect(ranges.has("新規.ts")).toBe(true);
    expect((ranges.get("新規.ts") ?? []).length).toBeGreaterThan(0);
  });
});

describe("F1 defensive: computeDiffFacts tolerates a C-quoted header", () => {
  it("parses a quoted non-ASCII tracked header instead of dropping the file", () => {
    // Synthesized as git would emit with core.quotePath=true (\351\233\242 = 離).
    const diff = [
      'diff --git "a/\\351\\233\\242.ts" "b/\\351\\233\\242.ts"',
      '--- "a/\\351\\233\\242.ts"',
      '+++ "b/\\351\\233\\242.ts"',
      "@@ -1 +1 @@",
      "-export const x = 1;",
      "+export const x = 2;",
      "",
    ].join("\n");

    const facts = computeDiffFacts(diff);
    // The quoted octal must decode to the real UTF-8 path, NOT leak escapes.
    expect(facts.files.map((x) => x.path)).toEqual(["離.ts"]);
    expect(facts.files[0]?.added).toBe(1);
    expect(facts.files[0]?.removed).toBe(1);
  });
});

describe("F2 defensive: parseChangedRanges tolerates a C-quoted header", () => {
  it("attributes the hunk to the C-unescaped real path", () => {
    const diff = [
      'diff --git "a/\\351\\233\\242.ts" "b/\\351\\233\\242.ts"',
      '--- "a/\\351\\233\\242.ts"',
      '+++ "b/\\351\\233\\242.ts"',
      "@@ -1,2 +1,3 @@",
      " keep",
      "+added one",
      "+added two",
      "",
    ].join("\n");

    const ranges = parseChangedRanges(diff);
    // The hunk must be keyed by the REAL path "離.ts", not the escaped token —
    // a finding on 離.ts:2 would otherwise lose range attribution → INFO demote.
    expect([...ranges.keys()]).toEqual(["離.ts"]);
    expect(ranges.get("離.ts")).toEqual([[1, 4]]);
  });

  it("parseDeletedPaths C-unescapes a quoted deleted path", () => {
    const diff = [
      'diff --git "a/\\351\\233\\242.ts" "b/\\351\\233\\242.ts"',
      '--- "a/\\351\\233\\242.ts"',
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone",
      "",
    ].join("\n");

    expect([...parseDeletedPaths(diff)]).toEqual(["離.ts"]);
  });
});
