// src/diff/hunks.ts
// Parse a unified diff (collectDiff output: `git diff HEAD` + per-file
// `git diff --no-index /dev/null <file>` streams for untracked files) into
// per-file changed NEW-file line ranges. Pure, no I/O. Used by the M5 Part A
// `scopeToDiff` aggregator stage.

export type Range = [start: number, endExclusive: number];

// Strip a leading a// b/ prefix from a diff path; "/dev/null" stays as-is.
function stripPrefix(path: string): string {
  if (path === "/dev/null") return path;
  return path.replace(/^[ab]\//, "");
}

// Parse the `+++ ` header path, tolerating quotes and the b/ prefix.
function plusPath(line: string): string {
  let p = line.slice(4).trim(); // after "+++ "
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  return stripPrefix(p);
}

export function parseChangedRanges(diff: string): Map<string, Range[]> {
  const out = new Map<string, Range[]>();
  let currentFile: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = plusPath(line);
      currentFile = p === "/dev/null" ? null : p; // deleted file → no new-side
      if (currentFile && !out.has(currentFile)) out.set(currentFile, []);
      continue;
    }
    if (line.startsWith("@@") && currentFile) {
      // @@ -a,b +c,d @@ — new-file changed lines = [c, c+d); d omitted → 1.
      const m = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      if (count > 0) (out.get(currentFile) as Range[]).push([start, start + count]);
    }
  }
  return out;
}

// True if [lineStart, lineEnd] intersects any changed range.
export function rangeOverlapsChanged(lineStart: number, lineEnd: number, ranges: Range[]): boolean {
  const lo = Math.min(lineStart, lineEnd);
  const hi = Math.max(lineStart, lineEnd);
  return ranges.some(([s, e]) => lo < e && hi >= s);
}
