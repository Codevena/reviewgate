import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { Finding } from "../schemas/finding.ts";

// Deterministic finding fact-check — no LLM, no network. Two independent production
// field reports hit the same trust-killer: a single reviewer emitted a 0.97/1.00
// CRITICAL citing content in an EMPTY file (`pnpm-workspace.yaml:2` — the file has
// zero lines). At panel size 1 every suppression layer (consensus, FP-ledger,
// reputation, critic) is inert and grounding exempts security/correctness, so such a
// fabrication hard-FAILs the gate with full authority. This pass catches the most
// basic, cheaply-verifiable lie a reviewer can tell — "there is a problem at line N"
// when the cited file has fewer than N lines — and demotes it to INFO (advisory).
//
// PRECISION-FIRST: we ONLY demote when the file EXISTS at the cited path (so the path
// is provably correct) and `line_start` is beyond the file's line count. That case has
// ZERO false-positive risk — if a file has 3 lines, a finding on line 99 is
// unambiguously fabricated, regardless of category. We deliberately do NOT demote on
// an ABSENT file (a reviewer's path-format quirk could make a real finding look
// absent) — fail-safe: any uncertainty leaves the finding untouched and blocking.
//
// Unlike grounding, this does NOT exempt security/correctness: a non-existent line is
// a fabrication in any category, and demoting a phantom is strictly safer than
// blocking on it. Demote-only — it can never promote or drop a finding.

// Reading a cited file just to count its lines: cap to avoid pulling a pathologically
// large (e.g. generated/vendored) file into memory on the gate's hot path.
const MAX_READ_BYTES = 5_000_000;

// Number of lines in file content. "a\nb\nc\n" → 3, "a\nb" → 2, "" → 0, "x" → 1.
function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

// Append the fact-check note, keeping details within FindingSchema's 2000-char cap
// (truncate the original, never the note — same convention as groundingDemote).
function demote(f: Finding, note: string): Finding {
  return {
    ...f,
    severity: "INFO" as const,
    fact_invalid: true,
    details: `${f.details.slice(0, 2000 - note.length)}${note}`,
  };
}

/**
 * Demote findings whose cited file:line provably does not exist (file present but the
 * line is out of range / the file is empty). Pure, synchronous, fail-safe.
 *
 * @param findings    parsed reviewer findings (pre-aggregation)
 * @param repoRoot    the gate's working-tree root
 * @param deletedPaths repo-relative paths legitimately removed in the reviewed diff —
 *                     a finding on one of these is commentary on removed code, not a
 *                     fabrication, so it is skipped.
 */
export function validateFindingFacts(
  findings: Finding[],
  repoRoot: string,
  deletedPaths: Set<string>,
): Finding[] {
  let repoReal: string;
  try {
    repoReal = realpathSync(repoRoot);
  } catch {
    return findings; // can't establish a safe root → demote nothing
  }
  return findings.map((f) => {
    const file = f.file;
    if (!file || file === "." || deletedPaths.has(file)) return f;
    if (f.line_start < 1) return f;
    // Reject a path that escapes the repo BEFORE touching the filesystem.
    const abs = join(repoRoot, file);
    const rel = relative(repoRoot, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) return f;
    // Realpath-contain the PARENT directory (catches intermediate-symlink escape that
    // a final-component lstat would miss); then validate the leaf inside it.
    let parentReal: string;
    try {
      parentReal = realpathSync(dirname(abs));
    } catch {
      return f; // parent unresolved (absent dir / perm) → can't prove anything
    }
    const parentRel = relative(repoReal, parentReal);
    if (parentRel.startsWith("..") || isAbsolute(parentRel)) return f; // escapes repo
    const leaf = join(parentReal, file.slice(file.lastIndexOf("/") + 1));
    // Open with O_NOFOLLOW so a symlink-swapped leaf fails CLOSED (ELOOP) instead of
    // following OUT of the repo, then fstat + read THROUGH the same fd — no path
    // re-resolution between the type check and the read, so there is no check-then-use
    // (TOCTOU) window. Mirrors the project's O_NOFOLLOW convention for host-side reads
    // of reviewer-influenced paths. Absent leaf (ENOENT) / symlink (ELOOP) / unreadable
    // → fail-safe (do not demote; a path quirk or a race must never weaken a finding).
    let fd: number;
    try {
      fd = openSync(leaf, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      return f;
    }
    let text: string;
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.size > MAX_READ_BYTES) return f; // dir/special/oversize → skip
      const buf = Buffer.alloc(st.size);
      if (st.size > 0) readSync(fd, buf, 0, st.size, 0);
      text = buf.toString("utf8");
    } catch {
      return f; // unreadable (e.g. binary perms) → fail-safe
    } finally {
      try {
        closeSync(fd);
      } catch {
        /* already closed / invalid fd */
      }
    }
    const lines = lineCount(text);
    if (f.line_start <= lines) return f; // cited line exists → real finding, untouched
    const note = `\n\n[reviewgate fact-check] cited location ${file}:${f.line_start} does not exist in the working tree (file has ${lines} line${lines === 1 ? "" : "s"}) — almost certainly hallucinated; demoted to advisory. Verify before treating as real.`;
    return demote(f, note);
  });
}
