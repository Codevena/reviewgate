// src/research/plan-refs.ts
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { neutralizeFences, neutralizeInjectionMarkers } from "../diff/sanitizer.ts";
import { spawnCapture } from "../utils/spawn-capture.ts";

function defangSentinels(s: string): string {
  return s
    .replace(/<<UNTRUSTED_DIFF>>/gi, "<!UNTRUSTED_DIFF!>")
    .replace(/<<END_UNTRUSTED>>/gi, "<!END_UNTRUSTED!>");
}

const CODE_EXT = "ts|tsx|js|jsx|py|go|rs|java|kt|c|cc|cpp|h|hpp|rb|php|cs";
const CODE_EXT_RE = new RegExp(`\\.(?:${CODE_EXT})$`);
// S3 (field report 2026-06-23): doc/plan/spec references resolve moot CRITICALs raised on a spec
// reviewed in isolation (e.g. "the slug source is defined in docs/plan.md"). Extract a doc path
// ONLY when it carries a directory component (a real repo-relative reference like docs/plan.md) —
// NEVER a bare prose mention (README.md, notes.md), which would flood the reviewer prompt with
// every doc casually named in the diff. Read/safety caps are extension-independent (R7).
const DOC_EXT = "md|mdx|txt|rst";
const DOC_EXT_RE = new RegExp(`\\.(?:${DOC_EXT})$`);
const PATH_CHARS = /[^A-Za-z0-9_./-]+/; // anything NOT allowed in a path token = a delimiter
const MAX_CANDIDATES = 200;

/** Extract repo-relative-looking code/doc-file paths from arbitrary plan text (raw or
 *  a git-diff body — the `+`/`-`/` ` columns aren't in the token charset so they
 *  don't interfere). Code files match by extension anywhere; doc/plan files (S3) match
 *  only when path-like (containing `/`). Dedupes, preserves first-seen order, caps the list. */
export function extractReferencedPaths(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Split on delimiters first (linear), then test each short token — avoids the
  // O(n²) backtracking of one greedy regex over untrusted/long plan text.
  for (const tok of text.split(PATH_CHARS)) {
    if (!tok || tok.includes("..") || seen.has(tok)) continue;
    const isCode = CODE_EXT_RE.test(tok);
    const isDoc = !isCode && DOC_EXT_RE.test(tok) && tok.includes("/");
    if (!isCode && !isDoc) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

export interface ReferencedFilesInput {
  repoRoot: string;
  planText: string;
  budgetBytes: number;
  maxFiles?: number;
  excludePaths?: string[];
  signal?: AbortSignal;
}

const PROTECTED_PREFIXES = [".reviewgate/", ".git/", ".hg/", ".svn/"];
const PROTECTED_FILES = ["reviewgate.config.ts"];

// agy's .antigravitycli artifact can appear at any depth (agy run in a subdir),
// so match it as a path component anywhere — not just a root prefix.
export function isAgyArtifactPath(path: string): boolean {
  return /(^|\/)\.antigravitycli(\/|$)/i.test(path);
}

/**
 * Returns the subset of `paths` that git does NOT ignore, or `null` on a real
 * gate failure (timeout / truncated / null status / status > 1).
 * Callers must fail closed (inject nothing) on `null`.
 *
 * Exit-code semantics:
 *   0 = some paths are ignored (they're listed on stdout — drop them)
 *   1 = no paths are ignored (keep all)
 *   Both 0 and 1 are SUCCESS. Anything else (incl. 128 "not a git repo" /
 *   corrupt repo) is fail-closed: in production Reviewgate always runs inside a
 *   git repo, so a non-0/1 exit means the privacy-determining gitignore state is
 *   unknown — inject nothing rather than risk leaking an ignored file.
 */
async function gitignoreGate(
  repoRoot: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<string[] | null> {
  if (paths.length === 0) return [];
  const r = await spawnCapture("git", ["check-ignore", "--", ...paths], {
    cwd: repoRoot,
    timeoutMs: 10_000,
    signal,
  });
  // exit 0 = some ignored (listed on stdout); 1 = none ignored. Both are success.
  if (r.timedOut || r.truncated || r.status === null || r.status > 1) return null; // fail closed
  const ignored = new Set(
    (r.stdout ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return paths.filter((p) => !ignored.has(p));
}

export async function collectReferencedFileContents(input: ReferencedFilesInput): Promise<string> {
  try {
    const { repoRoot, planText } = input;
    const exclude = new Set((input.excludePaths ?? []).map((p) => p.toLowerCase()));
    let repoReal: string;
    try {
      repoReal = realpathSync(repoRoot);
    } catch {
      return "";
    }
    // Drop absolute paths BEFORE the gate: an out-of-repo path makes
    // `git check-ignore` exit 128, which would fail-close the WHOLE batch and
    // silently suppress all legit candidates. They'd be rejected by the
    // downstream repo-relative guard anyway, so nothing is lost.
    const candidates = extractReferencedPaths(planText).filter((p) => !isAbsolute(p));
    const gated = await gitignoreGate(repoRoot, candidates, input.signal);
    if (gated === null) return ""; // gate failure → fail closed
    const budget = input.budgetBytes;
    const maxFiles = input.maxFiles ?? 20;
    let out = "";
    let used = 0;
    let rendered = 0;
    const omit = (f: string): boolean => {
      const note = `### ${f}\n(omitted — context budget exceeded)\n`;
      out += note;
      used += Buffer.byteLength(note, "utf8");
      return used >= budget;
    };
    for (const rel of gated) {
      if (input.signal?.aborted) break;
      if (rendered >= maxFiles) break; // silent cap — no marker
      const lower = rel.toLowerCase();
      if (exclude.has(lower)) continue;
      if (PROTECTED_FILES.includes(lower)) continue;
      if (PROTECTED_PREFIXES.some((p) => lower.startsWith(p))) continue;
      if (isAgyArtifactPath(lower)) continue;

      const abs = join(repoRoot, rel);
      const relCheck = relative(repoRoot, abs);
      if (relCheck.startsWith("..") || isAbsolute(relCheck)) continue;

      // realpath containment — catches intermediate-dir-symlink escape that lstat misses.
      let rp: string;
      try {
        rp = realpathSync(abs);
      } catch {
        continue; // non-existent
      }
      const relReal = relative(repoReal, rp);
      if (relReal.startsWith("..") || isAbsolute(relReal)) continue;

      // ACCEPTED residual: a narrow intermediate-directory symlink TOCTOU remains —
      // between this realpath check and the open below, an attacker with write access
      // to the working tree could swap an intermediate path component to a symlink that
      // openSync (which follows intermediate components; O_NOFOLLOW only guards the
      // final one) then traverses outside the repo. Fully closing it needs per-component
      // openat(O_NOFOLLOW) / Linux RESOLVE_BENEATH, neither portable nor exposed by
      // Bun/Node fs. This is immaterial at our threat model (the attacker already has
      // working-tree write access to the repo under review) and matches the existing
      // collectChangedFileContents (git.ts) posture; this is best-effort context, not an
      // auth boundary.

      // lstatSync (no-follow): reject a final-component symlink/dir/special.
      // This must stay BEFORE the open so we never open a symlink target.
      try {
        if (!lstatSync(abs).isFile()) continue;
      } catch {
        continue;
      }

      // Open + fstat + read on the SAME inode to close the lstat→read TOCTOU window.
      // O_NOFOLLOW: atomically refuses a final-component symlink (ELOOP on Darwin/Linux),
      // closing the lstat→open race — even if a symlink is swapped in between our
      // lstatSync check and the open, this open will fail rather than follow it.
      let fd: number;
      try {
        fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch {
        continue; // ELOOP (final-component symlink) or ENOENT/EACCES → skip
      }
      let content: string;
      try {
        const fst = fstatSync(fd);
        if (!fst.isFile()) continue; // defensive: opened inode must be a regular file
        if (fst.size > budget - used) {
          if (omit(relCheck)) break;
          continue;
        }
        content = readFileSync(fd, "utf8"); // read the SAME opened inode (no path re-resolution)
      } finally {
        closeSync(fd);
      }
      if (content.includes("\0")) continue; // required binary guard

      content = neutralizeFences(defangSentinels(neutralizeInjectionMarkers(content)));

      const block = `### ${relCheck}\n\`\`\`\n${content}\n\`\`\`\n`;
      if (used + Buffer.byteLength(block, "utf8") > budget) {
        if (omit(relCheck)) break;
        continue;
      }
      out += block;
      used += Buffer.byteLength(block, "utf8");
      rendered += 1;
    }
    return out;
  } catch {
    return ""; // fail-safe: never throw
  }
}
