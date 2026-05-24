// tests/unit/repo-path.test.ts
//
// A reviewer may emit a finding's file path in many shapes (./src/x.ts,
// src\x.ts, an absolute path, redundant slashes). The diff's changed-range keys
// are canonical posix-relative ("src/x.ts"). Without a shared normalization the
// aggregator's changedRanges.get() misses → an in-diff finding is treated as
// out-of-diff. normalizeRepoPath canonicalizes both sides.
import { describe, expect, it } from "bun:test";
import { normalizeRepoPath } from "../../src/diff/repo-path.ts";

describe("normalizeRepoPath", () => {
  it("strips a leading ./", () => {
    expect(normalizeRepoPath("./src/x.ts")).toBe("src/x.ts");
  });

  it("converts backslashes to forward slashes", () => {
    expect(normalizeRepoPath("src\\a\\b.ts")).toBe("src/a/b.ts");
  });

  it("collapses redundant slashes", () => {
    expect(normalizeRepoPath("src//a.ts")).toBe("src/a.ts");
  });

  it("relativizes an absolute path under the working dir", () => {
    expect(normalizeRepoPath("/repo/src/x.ts", "/repo")).toBe("src/x.ts");
  });

  it("keeps an absolute path that escapes the working dir", () => {
    expect(normalizeRepoPath("/etc/passwd", "/repo")).toBe("/etc/passwd");
  });

  it("relativizes an in-repo file whose NAME starts with .. (not a parent escape)", () => {
    expect(normalizeRepoPath("/repo/..foo.ts", "/repo")).toBe("..foo.ts");
  });

  it("leaves /dev/null and empty untouched", () => {
    expect(normalizeRepoPath("/dev/null")).toBe("/dev/null");
    expect(normalizeRepoPath("")).toBe("");
  });

  it("is idempotent on an already-canonical path", () => {
    expect(normalizeRepoPath("src/x.ts")).toBe("src/x.ts");
  });

  it("does NOT lowercase (case-sensitive filesystems)", () => {
    expect(normalizeRepoPath("./Src/Foo.ts")).toBe("Src/Foo.ts");
  });
});
