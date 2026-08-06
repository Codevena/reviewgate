import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { neutralizeFences, neutralizeInjectionMarkers } from "../diff/sanitizer.ts";
import type { Finding } from "../schemas/finding.ts";
import { safeReadContained } from "../utils/safe-read.ts";

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
 * A cited line that does not exist is NOT automatically a fabrication. When the reviewer quoted
 * its own evidence and that quote is a real line of the cited file, the reviewer read real code
 * and mis-numbered it — mis-anchored, not hallucinated. Demoting that as a hallucination is a
 * false accusation against a finding we can PROVE is grounded (pilot-02 turn 2: a 0.90 path
 * traversal, quote verbatim at line 26, cited at 67, demoted with "almost certainly
 * hallucinated").
 *
 * `f.evidence_line` is UNTRUSTED reviewer-supplied input — it is never executed or taken on
 * trust by itself. It only ever earns a repair by matching, byte-for-byte after normalization,
 * real content already read from the working tree; a caller relaxing that normalization or the
 * match/identifier-token guards below would let the reviewer's own text decide the outcome.
 *
 * Returns the finding re-anchored to the quoted line, or null when nothing can be proven — in
 * which case the caller demotes exactly as before. This can only ever be reached for an
 * out-of-range anchor, so it can never move a valid one.
 *
 * Multiple matches resolve to the LAST matching occurrence — which, because this only ever runs on
 * a citation past EOF (the range check above always fires first), is also the occurrence NEAREST
 * the cited line; a tie cannot occur given the range-checked call site. Any matching occurrence is
 * a real instance of the reviewer's own quote, so this chooses among facts rather than inventing
 * one — and it must be deterministic, because the aggregator's clustering is deliberately
 * order-independent and keys on line_start.
 */
function reanchorByEvidence(f: Finding, text: string): Finding | null {
  const ev = typeof f.evidence_line === "string" ? f.evidence_line : null;
  if (ev === null || ev.length === 0) return null;
  const evN = normalizeLine(ev);
  if (evN.length === 0) return null; // quote was only whitespace/markers → no signal
  // A quote with no identifier-like token at all ("}", "},", "});" — zero [A-Za-z_$] characters
  // present) names no code: it matches dozens of lines and proves nothing about WHICH line the
  // reviewer read. That rejection holds at ANY length bound, since these quotes contain no
  // identifier character to begin with. The {1,} bound (2-character minimum) exists on top of
  // that only to exclude a bare single-letter quote ("x", "a") — it still accepts a genuine
  // 2-char token, including common JS keywords ("if", "do", "in", "of", "as"). Falling through to
  // the demote is fail-safe — it restores exactly the pre-repair behaviour for a quote that
  // carries no signal.
  if (!/[A-Za-z_$][A-Za-z0-9_$]{1,}/.test(evN)) return null;
  const lines = text.split("\n");
  const cited = f.line_start - 1;
  let best = -1;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw === undefined) continue;
    if (normalizeLine(raw) !== evN) continue;
    // Strict `<` with an ascending scan keeps the LAST match. Since `cited` is always past EOF
    // here, every match index is strictly below it and distance is monotonic in i, so "last
    // match" and "nearest match" are the same occurrence — no tie can arise to break.
    if (best === -1 || Math.abs(i - cited) < Math.abs(best - cited)) best = i;
  }
  if (best === -1) return null; // quote matches no line → the fabrication signal stands
  const line = best + 1;
  const total = lineCount(text);
  const note = `\n\n[reviewgate fact-check] the reviewer cited ${f.file}:${f.line_start}, which does not exist (the file has ${total} line${total === 1 ? "" : "s"}), but the evidence it quoted matches line ${line} verbatim — MIS-ANCHORED, not fabricated, so it has been re-anchored there. Treat the defect as real and check line ${line}.`;
  return {
    ...f,
    line_start: line,
    line_end: line,
    anchor_repaired: true,
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
    // Out of range. Before calling it a fabrication, consult the reviewer's OWN quoted evidence —
    // f.evidence_line is UNTRUSTED reviewer-supplied input, so this is a match against real file
    // content already read above, never a trust decision made from the quote alone: a quote that
    // matches a real line of THIS file proves the reviewer read the code and mis-numbered it,
    // which is not what this pass exists to catch.
    const repaired = reanchorByEvidence(f, text);
    if (repaired !== null) return repaired;
    const note = `\n\n[reviewgate fact-check] cited location ${file}:${f.line_start} does not exist in the working tree (file has ${lines} line${lines === 1 ? "" : "s"}) — almost certainly hallucinated; demoted to advisory. Verify before treating as real.`;
    return demote(f, note);
  });
}

// S4 (field report 2026-06-23): cap a single quoted line; bound the read like validateFindingFacts.
const MAX_EVIDENCE_READ_BYTES = 5_000_000;

// Normalize a source line for a forgiving, injection-safe comparison: defang any reviewer-supplied
// fence/marker (the quote is untrusted text), then collapse whitespace and trim. Whitespace-only
// differences (tabs vs spaces, indentation) must NEVER read as a mismatch (precision-first).
function normalizeLine(s: string): string {
  return neutralizeFences(neutralizeInjectionMarkers(s)).replace(/\s+/g, " ").trim();
}

// S4: RENDER-ONLY evidence attestation. When a finding self-quotes the source line it relied on
// (evidence_line), badge `evidence_mismatch` ONLY when that quote matches NO line of the cited file
// — a strong signal the reviewer reasoned on stale/absent/fabricated context (the moot lone-CRITICAL
// the field report hit, made without the resolving artifact). It NEVER changes severity. Fail-SAFE
// at every gap: no evidence_line, empty-after-normalize quote, unreadable/oversize file, line out of
// range, an exact match at the cited line, OR a match at ANY other line (a moved/deleted pre-image
// the agent relocated) → NO badge. So a badge means: the reviewer quoted a line that is simply not in
// the file. Pure + synchronous; reuses the O_NOFOLLOW-contained reader.
export function attestEvidence(findings: Finding[], repoRoot: string): Finding[] {
  return findings.map((f) => {
    const ev = typeof f.evidence_line === "string" ? f.evidence_line : null;
    if (ev === null || ev.length === 0) return f;
    if (!f.file || f.file === "." || f.line_start < 1) return f;
    const content = safeReadContained(repoRoot, f.file, MAX_EVIDENCE_READ_BYTES);
    if (content === null) return f; // unreadable / oversize / escapes repo → fail-safe (no badge)
    const evN = normalizeLine(ev);
    if (evN.length === 0) return f; // quote was only whitespace/markers → no signal
    const lines = content.split("\n");
    const cited = lines[f.line_start - 1];
    if (cited === undefined) return f; // out of range → validateFindingFacts owns the phantom case
    if (normalizeLine(cited) === evN) return f; // quote matches the cited line → good evidence
    if (lines.some((l) => normalizeLine(l) === evN)) return f; // matches elsewhere → moved, ambiguous
    return { ...f, evidence_mismatch: true }; // matches NO line → stale/absent/fabricated context
  });
}
