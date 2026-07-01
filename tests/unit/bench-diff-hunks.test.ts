// tests/unit/bench-diff-hunks.test.ts
// reviewgate bench — unified-diff parser (spec §12 P1b step 5). Corpus diffs are
// UNTRUSTED input, so the parser must extract NEW-side hunk ranges for the matcher,
// decode git-quoted paths, and refuse anything it cannot parse safely (malformed
// @@, combined diffs, binary) or that git apply would write outside the sandbox
// (absolute / `..` / reserved control dir). Pure and fully offline.
import { describe, expect, it } from "bun:test";
import {
  collectChangedHunks,
  parseUnifiedDiff,
  unsafePathReason,
  validateDiffPaths,
} from "../../src/bench/diff-hunks.ts";

function ok(patch: string) {
  const r = parseUnifiedDiff(patch);
  if (!r.ok) throw new Error(`expected ok parse, got: ${r.reason}`);
  return r.files;
}

describe("parseUnifiedDiff — NEW-side ranges", () => {
  it("parses a single modification hunk to its new-side range", () => {
    const patch = [
      "diff --git a/src/db.ts b/src/db.ts",
      "index 111..222 100644",
      "--- a/src/db.ts",
      "+++ b/src/db.ts",
      "@@ -40,3 +40,4 @@ function q() {",
      " ctx",
      "-old",
      "+new1",
      "+new2",
      " ctx",
      "",
    ].join("\n");
    const files = ok(patch);
    expect(files).toHaveLength(1);
    expect(files[0]?.oldPath).toBe("src/db.ts");
    expect(files[0]?.newPath).toBe("src/db.ts");
    expect(files[0]?.hunks).toEqual([{ file: "src/db.ts", start: 40, end: 43 }]);
  });

  it("parses multiple hunks in one file", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,2 @@",
      " x",
      "+y",
      "@@ -10,1 +11,3 @@",
      " z",
      "+p",
      "+q",
      "",
    ].join("\n");
    const files = ok(patch);
    expect(files[0]?.hunks).toEqual([
      { file: "a.ts", start: 1, end: 2 },
      { file: "a.ts", start: 11, end: 13 },
    ]);
  });

  it("parses a new file (/dev/null source) starting at line 1", () => {
    const patch = [
      "diff --git a/new.ts b/new.ts",
      "new file mode 100644",
      "index 000..abc",
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,3 @@",
      "+a",
      "+b",
      "+c",
      "",
    ].join("\n");
    const files = ok(patch);
    expect(files[0]?.oldPath).toBeNull();
    expect(files[0]?.newPath).toBe("new.ts");
    expect(files[0]?.hunks).toEqual([{ file: "new.ts", start: 1, end: 3 }]);
  });

  it("parses a deleted file (/dev/null target) with no new-side hunks", () => {
    const patch = [
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-a",
      "-b",
      "",
    ].join("\n");
    const files = ok(patch);
    expect(files[0]?.oldPath).toBe("gone.ts");
    expect(files[0]?.newPath).toBeNull();
    expect(files[0]?.hunks).toEqual([]);
  });

  it("anchors a zero-length deletion hunk to a single clamped line", () => {
    const patch = [
      "diff --git a/mod.ts b/mod.ts",
      "--- a/mod.ts",
      "+++ b/mod.ts",
      "@@ -5,3 +4,0 @@",
      "-x",
      "-y",
      "-z",
      "",
    ].join("\n");
    const files = ok(patch);
    expect(files[0]?.hunks).toEqual([{ file: "mod.ts", start: 4, end: 4 }]);
  });

  it("clamps a zero-length deletion at the file start to line 1", () => {
    const patch = ["--- a/m.ts", "+++ b/m.ts", "@@ -1,3 +0,0 @@", "-x", "-y", "-z", ""].join("\n");
    const files = ok(patch);
    expect(files[0]?.hunks).toEqual([{ file: "m.ts", start: 1, end: 1 }]);
  });
});

describe("parseUnifiedDiff — renames / copies / mode-only", () => {
  it("parses a pure rename (no content change) with no hunks", () => {
    const patch = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
      "",
    ].join("\n");
    const files = ok(patch);
    expect(files[0]?.oldPath).toBe("old.ts");
    expect(files[0]?.newPath).toBe("new.ts");
    expect(files[0]?.hunks).toEqual([]);
  });

  it("parses a rename with content change and attributes hunks to the new path", () => {
    const patch = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 80%",
      "rename from old.ts",
      "rename to new.ts",
      "index abc..def 100644",
      "--- a/old.ts",
      "+++ b/new.ts",
      "@@ -1,3 +1,4 @@",
      " a",
      "-b",
      "+b2",
      "+b3",
      " c",
      "",
    ].join("\n");
    const files = ok(patch);
    expect(files[0]?.newPath).toBe("new.ts");
    expect(files[0]?.hunks).toEqual([{ file: "new.ts", start: 1, end: 4 }]);
  });

  it("parses a copy header (copy from/to)", () => {
    const patch = [
      "diff --git a/src.ts b/dst.ts",
      "similarity index 100%",
      "copy from src.ts",
      "copy to dst.ts",
      "",
    ].join("\n");
    const files = ok(patch);
    expect(files[0]?.oldPath).toBe("src.ts");
    expect(files[0]?.newPath).toBe("dst.ts");
  });

  it("parses a mode-only change with no hunks", () => {
    const patch = ["diff --git a/exec.sh b/exec.sh", "old mode 100644", "new mode 100755", ""].join(
      "\n",
    );
    const files = ok(patch);
    expect(files[0]?.oldPath).toBe("exec.sh");
    expect(files[0]?.newPath).toBe("exec.sh");
    expect(files[0]?.hunks).toEqual([]);
  });

  it("does NOT mis-split an ambiguous `diff --git` path containing ` b/` (fail-closed)", () => {
    // git emits `a/P b/P` for a mode-only change (same path on both sides). A path
    // literally containing ` b/` makes the naive greedy regex mis-split into bogus
    // paths that could desync from git apply — so the fallback must yield null
    // paths (defer to the authoritative ---/+++ headers) rather than guess.
    const patch = [
      "diff --git a/foo b/evil b/foo b/evil",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n");
    const files = ok(patch);
    expect(files[0]?.oldPath).toBeNull();
    expect(files[0]?.newPath).toBeNull();
  });
});

describe("parseUnifiedDiff — quoted paths", () => {
  it("decodes a git C-quoted path containing a space", () => {
    const patch = [
      'diff --git "a/foo bar.ts" "b/foo bar.ts"',
      '--- "a/foo bar.ts"',
      '+++ "b/foo bar.ts"',
      "@@ -1,1 +1,2 @@",
      " x",
      "+y",
      "",
    ].join("\n");
    const files = ok(patch);
    expect(files[0]?.newPath).toBe("foo bar.ts");
    expect(files[0]?.hunks).toEqual([{ file: "foo bar.ts", start: 1, end: 2 }]);
  });

  it("decodes octal / backslash escapes in a quoted path", () => {
    const patch = ["--- /dev/null", '+++ "b/caf\\303\\251.ts"', "@@ -0,0 +1,1 @@", "+x", ""].join(
      "\n",
    );
    const files = ok(patch);
    expect(files[0]?.newPath).toBe("café.ts");
  });
});

describe("parseUnifiedDiff — rejects unparseable / unscorable input", () => {
  it("rejects a malformed @@ header", () => {
    const patch = ["--- a/x.ts", "+++ b/x.ts", "@@ this is not a hunk header @@", "+y", ""].join(
      "\n",
    );
    const r = parseUnifiedDiff(patch);
    expect(r.ok).toBe(false);
  });

  it("rejects a combined (merge) diff", () => {
    const patch = [
      "diff --cc x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@@ -1,1 -1,1 +1,2 @@@",
      "++y",
      "",
    ].join("\n");
    const r = parseUnifiedDiff(patch);
    expect(r.ok).toBe(false);
  });

  it("rejects a binary patch", () => {
    const patch = [
      "diff --git a/img.png b/img.png",
      "index 111..222 100644",
      "Binary files a/img.png and b/img.png differ",
      "",
    ].join("\n");
    const r = parseUnifiedDiff(patch);
    expect(r.ok).toBe(false);
  });

  it("rejects a GIT binary patch block", () => {
    const patch = [
      "diff --git a/img.png b/img.png",
      "GIT binary patch",
      "literal 5",
      "abcde",
      "",
    ].join("\n");
    const r = parseUnifiedDiff(patch);
    expect(r.ok).toBe(false);
  });

  it("rejects an un-terminated quoted path", () => {
    const patch = ["--- /dev/null", '+++ "b/broken', "@@ -0,0 +1,1 @@", "+x", ""].join("\n");
    const r = parseUnifiedDiff(patch);
    expect(r.ok).toBe(false);
  });

  it("rejects a quoted path with invalid UTF-8 bytes (fail-closed, not U+FFFD)", () => {
    // \200 (0x80) is a lone UTF-8 continuation byte — invalid. Decoding it must
    // THROW rather than silently produce a replacement char, so the validated path
    // never desyncs from the raw bytes git apply would write.
    const patch = ["--- /dev/null", '+++ "b/\\200.ts"', "@@ -0,0 +1,1 @@", "+x", ""].join("\n");
    const r = parseUnifiedDiff(patch);
    expect(r.ok).toBe(false);
  });

  it("rejects a hunk header with an absurd (out-of-bound) line count", () => {
    // A crafted count near 2^53 must not propagate into a HunkRange; bound it.
    const patch = ["--- /dev/null", "+++ b/x.ts", "@@ -0,0 +1,9007199254740991 @@", "+y", ""].join(
      "\n",
    );
    const r = parseUnifiedDiff(patch);
    expect(r.ok).toBe(false);
  });

  it("rejects a hunk header with an absurd start line", () => {
    const patch = ["--- a/x.ts", "+++ b/x.ts", "@@ -1,1 +9999999999,1 @@", " a", "+b", ""].join(
      "\n",
    );
    const r = parseUnifiedDiff(patch);
    expect(r.ok).toBe(false);
  });

  it("returns an empty file list for an empty diff", () => {
    const r = parseUnifiedDiff("   \n");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.files).toEqual([]);
  });

  it("rejects a symlink file mode (120000) — cannot hydrate a link that escapes the sandbox", () => {
    const patch = [
      "diff --git a/link b/link",
      "new file mode 120000",
      "--- /dev/null",
      "+++ b/link",
      "@@ -0,0 +1,1 @@",
      "+/etc/passwd",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    const r = parseUnifiedDiff(patch);
    expect(r.ok).toBe(false);
  });

  it("rejects a gitlink (submodule) mode (160000)", () => {
    const patch = ["diff --git a/sub b/sub", "new file mode 160000", ""].join("\n");
    const r = parseUnifiedDiff(patch);
    expect(r.ok).toBe(false);
  });

  it("truncates an untrusted diff line before putting it in the error reason", () => {
    const patch = ["--- a/x.ts", "+++ b/x.ts", `@@ ${"X".repeat(5000)} @@`, "+y", ""].join("\n");
    const r = parseUnifiedDiff(patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason.length).toBeLessThan(400);
  });
});

describe("collectChangedHunks", () => {
  it("flattens new-side ranges across all files", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,2 @@",
      " x",
      "+y",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -5,1 +5,2 @@",
      " z",
      "+w",
      "",
    ].join("\n");
    const files = ok(patch);
    expect(collectChangedHunks(files)).toEqual([
      { file: "a.ts", start: 1, end: 2 },
      { file: "b.ts", start: 5, end: 6 },
    ]);
  });
});

describe("unsafePathReason / validateDiffPaths", () => {
  it("accepts a normal repo-relative path", () => {
    expect(unsafePathReason("src/db.ts")).toBeNull();
  });

  it("rejects an absolute path", () => {
    expect(unsafePathReason("/etc/passwd")).not.toBeNull();
  });

  it("rejects a parent-traversal path", () => {
    expect(unsafePathReason("../../etc/passwd")).not.toBeNull();
  });

  it("rejects a reserved control directory", () => {
    expect(unsafePathReason(".reviewgate/state.json")).not.toBeNull();
    expect(unsafePathReason(".git/config")).not.toBeNull();
    expect(unsafePathReason(".claude/settings.json")).not.toBeNull();
  });

  it("rejects a reserved control directory regardless of case (case-insensitive FS)", () => {
    // On macOS/Windows `.Git` aliases `.git`; a case-sensitive Set check would let
    // a corpus diff write into the sandbox's real control dir. Case-fold the check.
    expect(unsafePathReason(".Git/config")).not.toBeNull();
    expect(unsafePathReason(".GIT/hooks/pre-commit")).not.toBeNull();
    expect(unsafePathReason(".Reviewgate/state.json")).not.toBeNull();
    expect(unsafePathReason(".CLAUDE/settings.json")).not.toBeNull();
  });

  it("rejects a control character in the path", () => {
    expect(unsafePathReason("src/x\u0001.ts")).not.toBeNull();
  });

  it("rejects the ASCII DEL (0x7f) control character", () => {
    expect(unsafePathReason("src/x\u007f.ts")).not.toBeNull();
  });

  it("validates a quoted mode-only path (no ---/+++ headers) instead of skipping it", () => {
    // A pure mode-only change carries no ---/+++; its only paths are the quoted
    // `diff --git` header. Those must be decoded and validated, not left null.
    const files = ok(
      ['diff --git "a/.git/config" "b/.git/config"', "old mode 100644", "new mode 100755", ""].join(
        "\n",
      ),
    );
    expect(files[0]?.newPath).toBe(".git/config");
    expect(validateDiffPaths(files).ok).toBe(false);
  });

  it("validateDiffPaths flags a rename that targets a reserved dir", () => {
    const files = ok(
      [
        "diff --git a/ok.ts b/ok.ts",
        "similarity index 100%",
        "rename from ok.ts",
        "rename to ok.ts",
        "",
      ].join("\n"),
    );
    // Rewrite the parsed new path to an escaping target to exercise the validator
    // independent of parser quirks.
    const tampered = files.map((f) => ({ ...f, newPath: ".git/hooks/pre-commit" }));
    expect(validateDiffPaths(tampered).ok).toBe(false);
  });

  it("validateDiffPaths passes a clean modification", () => {
    const files = ok(
      ["--- a/src/x.ts", "+++ b/src/x.ts", "@@ -1,1 +1,2 @@", " a", "+b", ""].join("\n"),
    );
    expect(validateDiffPaths(files).ok).toBe(true);
  });

  it("validateDiffPaths ignores /dev/null (null) sides", () => {
    const files = ok(["--- /dev/null", "+++ b/src/new.ts", "@@ -0,0 +1,1 @@", "+a", ""].join("\n"));
    expect(validateDiffPaths(files).ok).toBe(true);
  });
});
