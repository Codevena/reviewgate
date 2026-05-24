// src/diff/repo-path.ts
import { isAbsolute, relative } from "node:path";

// Canonicalize a file path to a repo-relative, posix-separated form so a
// reviewer-emitted finding path ("./src/x.ts", "src\\x.ts", an absolute path)
// matches the diff's changed-range keys ("src/x.ts"). Deliberately does NOT
// lowercase — that would conflate distinct files on case-sensitive filesystems.
// An absolute path that escapes `workingDir` is kept as-is (it genuinely is not
// in the repo). "/dev/null" and empty pass through unchanged.
export function normalizeRepoPath(raw: string, workingDir?: string): string {
  if (!raw || raw === "/dev/null") return raw;
  if (workingDir && isAbsolute(raw)) {
    const rel = relative(workingDir, raw).replace(/\\/g, "/");
    // Adopt the repo-relative form unless it genuinely escapes workingDir. relative()
    // returns "" for the dir itself, exactly ".." or a "../"-prefixed path for a
    // parent escape — but a file whose NAME merely starts with ".." (e.g. "..foo.ts")
    // is still INSIDE the repo and must be relativized, not kept absolute.
    if (rel !== "" && rel !== ".." && !rel.startsWith("../")) {
      return rel.replace(/\/{2,}/g, "/");
    }
    return raw;
  }
  return raw
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
}
