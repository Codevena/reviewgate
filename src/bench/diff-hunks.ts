// reviewgate bench — unified-diff parser (spec §12 P1b step 5).
//
// Corpus diffs are UNTRUSTED. This parser extracts the NEW-side line ranges the
// matcher needs (so an in-region finding can be scored) and validates every path
// git apply would touch. It deliberately refuses anything it cannot parse *safely*
// — malformed `@@` headers, combined (merge) diffs, binary patches, un-decodable
// quoted paths — rather than guess; the runner turns any refusal into a
// benchmark-invalid case. Pure, no I/O.

export interface HunkRange {
  /** NEW-side path the range lives on. */
  file: string;
  start: number;
  end: number;
}

export interface DiffFile {
  /** OLD-side path, or null for an added file (/dev/null source). */
  oldPath: string | null;
  /** NEW-side path, or null for a deleted file (/dev/null target). */
  newPath: string | null;
  /** NEW-side ranges; empty for a pure delete / rename-only / mode-only change. */
  hunks: HunkRange[];
}

export type ParseDiffResult = { ok: true; files: DiffFile[] } | { ok: false; reason: string };

// Directories bench must never let a corpus diff write into: they control the
// gate's own behaviour (or git internals). git apply on an empty tree would also
// reject a write into .git, but we fail earlier and louder.
const RESERVED_TOP_DIRS = new Set([".reviewgate", ".git", ".claude"]);

/** Reason a path is unsafe to hydrate into the sandbox, or null when it is safe. */
export function unsafePathReason(path: string): string | null {
  if (path.length === 0) return "empty path";
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return "control character in path";
  }
  if (path.startsWith("/") || path.startsWith("\\")) return "absolute path";
  if (/^[A-Za-z]:/.test(path)) return "windows drive path";
  const segs = path.split(/[\\/]/);
  for (const seg of segs) {
    if (seg.length === 0) return "empty path segment";
    if (seg === "." || seg === "..") return "`.`/`..` path segment";
  }
  // Case-fold the reserved-dir check: on a case-insensitive filesystem (macOS,
  // Windows) `.Git`/`.Reviewgate` alias the real control dir, so a case-sensitive
  // Set lookup would let an untrusted diff write into it.
  const first = segs[0];
  if (first !== undefined && RESERVED_TOP_DIRS.has(first.toLowerCase())) {
    return `reserved control directory: ${first}`;
  }
  return null;
}

/** Validate every OLD/NEW path a diff touches; null (/dev/null) sides are skipped. */
export function validateDiffPaths(files: DiffFile[]): { ok: true } | { ok: false; reason: string } {
  for (const f of files) {
    for (const p of [f.oldPath, f.newPath]) {
      if (p === null) continue;
      const reason = unsafePathReason(p);
      if (reason) return { ok: false, reason: `${reason}: ${JSON.stringify(p)}` };
    }
  }
  return { ok: true };
}

/** Flatten NEW-side hunk ranges across all files, in file/hunk order. */
export function collectChangedHunks(files: DiffFile[]): HunkRange[] {
  const out: HunkRange[] = [];
  for (const f of files) out.push(...f.hunks);
  return out;
}

// Decode a git C-quoted path (`"…"` with C-style escapes). Git only quotes a path
// when it contains a special char; an unquoted path is returned verbatim. Throws on
// a malformed quote so the caller can mark the case invalid rather than mis-hydrate.
function unquoteGitPath(raw: string): string {
  if (!raw.startsWith('"')) return raw;
  if (!raw.endsWith('"') || raw.length < 2) throw new Error(`unterminated quoted path: ${raw}`);
  const body = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== "\\") {
      bytes.push(body.charCodeAt(i));
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) throw new Error(`dangling escape in quoted path: ${raw}`);
    // Octal escape \NNN (git emits 3 octal digits for non-ASCII bytes).
    if (next >= "0" && next <= "7") {
      const oct = body.slice(i + 1, i + 4);
      if (!/^[0-7]{1,3}$/.test(oct)) throw new Error(`bad octal escape in quoted path: ${raw}`);
      bytes.push(Number.parseInt(oct, 8) & 0xff);
      i += oct.length;
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
    const code = simple[next];
    if (code === undefined) throw new Error(`unknown escape \\${next} in quoted path: ${raw}`);
    bytes.push(code);
    i += 1;
  }
  // git-quoted octal escapes are UTF-8 bytes; decode the byte sequence as UTF-8.
  // fatal:true — invalid UTF-8 THROWS (caught → case invalid) rather than silently
  // becoming U+FFFD, which would desync the validated path from the raw bytes git
  // apply writes (the module's fail-closed contract).
  return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
}

// Strip a leading `a/` or `b/` diff prefix. Applied AFTER unquoting.
function stripAbPrefix(p: string): string {
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

// Parse a `---`/`+++` header value into a path (null for /dev/null). Throws on a
// malformed quote (→ invalid case).
function parseHeaderPath(rest: string): string | null {
  // git does not append a timestamp; a bare value remains. Trim a trailing CR only.
  const value = rest.replace(/\r$/, "");
  if (value === "/dev/null") return null;
  const unquoted = unquoteGitPath(value);
  if (unquoted === "/dev/null") return null;
  return stripAbPrefix(unquoted);
}

// Best-effort path extraction from a `diff --git a/X b/Y` line. This is used ONLY
// to seed paths for a block carrying no authoritative ---/+++ or rename/copy
// headers (i.e. a mode-only change), for which git ALWAYS emits the SAME path on
// both sides. We accept the result ONLY when both halves are identical — the
// mode-only invariant — so a genuinely ambiguous / mismatched split that could
// desync from git apply returns null and the authoritative headers (or git apply)
// decide. Quoted paths are DECODED (both sides are separately C-quoted) so a
// mode-only change to a reserved/escaping path is still validated, not skipped.
function parseGitHeaderPaths(rest: string): { old: string | null; new: string | null } | null {
  if (rest.startsWith('"')) {
    // Two space-separated C-quoted tokens: `"a/P" "b/P"`.
    const q = rest.match(/^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/);
    if (!q || q[1] === undefined || q[2] === undefined) return null;
    const oldP = stripAbPrefix(unquoteGitPath(q[1]));
    const newP = stripAbPrefix(unquoteGitPath(q[2]));
    if (oldP !== newP) return null;
    return { old: oldP, new: newP };
  }
  const m = rest.match(/^a\/(.+) b\/(.+)$/);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  if (m[1] !== m[2]) return null; // not the a/P b/P mode-only shape → don't guess
  return { old: m[1], new: m[2] };
}

// Upper bound on a hunk's line numbers. No real source file approaches this; a
// larger value in an untrusted corpus diff is treated as malformed so a crafted
// count (e.g. near 2^53) can never propagate into a HunkRange the matcher stores.
const MAX_DIFF_LINE = 1_000_000_000;

function parseHunkHeader(line: string): { newStart: number; newCount: number } | null {
  const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
  if (!m || m[1] === undefined) return null;
  const newStart = Number.parseInt(m[1], 10);
  const newCount = m[2] === undefined ? 1 : Number.parseInt(m[2], 10);
  if (newStart > MAX_DIFF_LINE || newCount > MAX_DIFF_LINE) return null;
  return { newStart, newCount };
}

// Sanitize an UNTRUSTED diff line for interpolation into an error `reason` that
// lands in the result JSON / terminal: strip control chars (ANSI escapes, stray
// newlines) and hard-truncate so a crafted multi-megabyte / escape-laden line
// can't corrupt rendering or bloat the file.
function safeSnippet(line: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally stripping control bytes from untrusted input
  const cleaned = line.replace(/[\u0000-\u001f\u007f]/g, "?");
  return cleaned.length > 120 ? `${cleaned.slice(0, 120)}…` : cleaned;
}

/** Parse a unified diff into per-file NEW-side ranges, or refuse it (ok:false). */
export function parseUnifiedDiff(patch: string): ParseDiffResult {
  const lines = patch.split("\n");
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;

  const push = () => {
    if (cur) files.push(cur);
    cur = null;
  };

  try {
    for (const line of lines) {
      if (line.startsWith("diff --git ")) {
        push();
        cur = { oldPath: null, newPath: null, hunks: [] };
        const guess = parseGitHeaderPaths(line.slice("diff --git ".length).replace(/\r$/, ""));
        if (guess) {
          cur.oldPath = guess.old;
          cur.newPath = guess.new;
        }
        continue;
      }
      if (line.startsWith("diff --cc ") || line.startsWith("diff --combined ")) {
        // Merge/combined diff — a different, multi-parent format we do not score.
        return { ok: false, reason: "combined (merge) diff is not supported" };
      }
      // A hunk/header line before any file block: tolerate a bare diff that starts
      // straight at `--- ` (no `diff --git`).
      if (line.startsWith("--- ")) {
        if (!cur) cur = { oldPath: null, newPath: null, hunks: [] };
        cur.oldPath = parseHeaderPath(line.slice(4));
        continue;
      }
      if (line.startsWith("+++ ")) {
        if (!cur) cur = { oldPath: null, newPath: null, hunks: [] };
        cur.newPath = parseHeaderPath(line.slice(4));
        continue;
      }
      if (line.startsWith("rename from ") || line.startsWith("copy from ")) {
        if (!cur) cur = { oldPath: null, newPath: null, hunks: [] };
        cur.oldPath = parseHeaderPath(line.slice(line.indexOf(" from ") + 6));
        continue;
      }
      if (line.startsWith("rename to ") || line.startsWith("copy to ")) {
        if (!cur) cur = { oldPath: null, newPath: null, hunks: [] };
        cur.newPath = parseHeaderPath(line.slice(line.indexOf(" to ") + 4));
        continue;
      }
      if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
        return { ok: false, reason: "binary patch cannot be line-scored" };
      }
      // Reject non-regular git modes: 120000 = symlink (a hydrated link could
      // escape the sandbox and expose host files to reviewers), 160000 = gitlink
      // (submodule pointer). Matches `new file mode`, `deleted file mode`, `old
      // mode`, `new mode`. Untrusted corpus → fail-closed.
      const mode = line.match(/^(?:new file|deleted file|old|new) mode (\d{6})$/);
      if (mode && (mode[1] === "120000" || mode[1] === "160000")) {
        return { ok: false, reason: `unsupported git file mode ${mode[1]} (symlink/gitlink)` };
      }
      if (line.startsWith("@@@")) {
        return { ok: false, reason: "combined (merge) diff is not supported" };
      }
      if (line.startsWith("@@")) {
        const parsed = parseHunkHeader(line);
        if (!parsed) return { ok: false, reason: `malformed @@ hunk header: ${safeSnippet(line)}` };
        if (!cur) cur = { oldPath: null, newPath: null, hunks: [] };
        // A deleted file (/dev/null target) has no new-side lines to match.
        if (cur.newPath !== null) {
          const { newStart, newCount } = parsed;
          const start = Math.max(1, newStart);
          const end = newCount === 0 ? start : Math.max(start, newStart + newCount - 1);
          cur.hunks.push({ file: cur.newPath, start, end });
        }
      }
      // Any other line — context / +/- body, `\ No newline`, index, mode, similarity
      // — carries no path or range we track; it is skipped.
    }
    push();
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  return { ok: true, files };
}
