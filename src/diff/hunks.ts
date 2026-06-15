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

// C-unquote a git-quoted header path. With core.quotePath on (git's default) a
// path with non-ASCII/space/control bytes is wrapped in double quotes and
// C-escaped (octal `\351`, plus `\t \n \" \\` …) in `+++ `/`--- ` headers.
// collectDiff now passes `-c core.quotePath=false` so the live path is raw, but
// this stays defensively: a quoted header from any other diff source must still
// resolve to the REAL repo path, else the hunk loses range attribution and the
// finding is wrongly demoted to INFO. Bytes decode as UTF-8 (git quotes the raw
// UTF-8 octets). Returns the input unchanged if it isn't a quoted token.
function gitUnquotePath(token: string): string {
  if (!(token.length >= 2 && token.startsWith('"') && token.endsWith('"'))) return token;
  const body = token.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c !== "\\") {
      bytes.push(body.charCodeAt(i));
      continue;
    }
    const n = body[i + 1];
    if (n === undefined) {
      bytes.push(0x5c);
      break;
    }
    if (n >= "0" && n <= "7") {
      let oct = n;
      let j = i + 2;
      while (oct.length < 3) {
        const d = body[j];
        if (d === undefined || d < "0" || d > "7") break;
        oct += d;
        j++;
      }
      bytes.push(Number.parseInt(oct, 8) & 0xff);
      i = j - 1;
      continue;
    }
    const simple: Record<string, number> = {
      a: 0x07,
      b: 0x08,
      t: 0x09,
      n: 0x0a,
      v: 0x0b,
      f: 0x0c,
      r: 0x0d,
      '"': 0x22,
      "\\": 0x5c,
    };
    bytes.push(simple[n] ?? n.charCodeAt(0));
    i++;
  }
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes));
  } catch {
    return token;
  }
}

// Parse the `+++ ` header path, tolerating quotes (C-unescaping them) and the
// b/ prefix.
function plusPath(line: string): string {
  let p = line.slice(4).trim(); // after "+++ "
  if (p.startsWith('"') && p.endsWith('"')) p = gitUnquotePath(p);
  return stripPrefix(p);
}

export function parseChangedRanges(diff: string): Map<string, Range[]> {
  const out = new Map<string, Range[]>();
  let currentFile: string | null = null;
  // Diff-state aware: a `+++ ` line is a FILE HEADER only in the per-file header
  // section (after a `diff ` line, before the first `@@`). Inside a hunk body an
  // added line whose content begins with `++` also renders as `+++ …`; without
  // this gate it would be mis-read as a header and mis-attribute later hunks.
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff ")) {
      // New file header section (git diff --git / --no-index both emit this).
      currentFile = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      const p = plusPath(line);
      currentFile = p === "/dev/null" ? null : p; // deleted file → no new-side
      if (currentFile && !out.has(currentFile)) out.set(currentFile, []);
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      if (!currentFile) continue;
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

// Repo-relative paths that were DELETED in the diff (`+++ /dev/null` with a real
// `--- a/<path>` source side). The fact-check pass uses this so a finding commenting
// on removed code isn't mistaken for a hallucination (the file is legitimately gone
// from the working tree). Pure, no I/O.
export function parseDeletedPaths(diff: string): Set<string> {
  const out = new Set<string>();
  let minusPath: string | null = null;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff ")) {
      minusPath = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith("--- ")) {
      let p = line.slice(4).trim();
      if (p.startsWith('"') && p.endsWith('"')) p = gitUnquotePath(p);
      minusPath = p === "/dev/null" ? null : stripPrefix(p);
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      if (plusPath(line) === "/dev/null" && minusPath) out.add(minusPath);
      continue;
    }
    if (line.startsWith("@@")) inHunk = true;
  }
  return out;
}
