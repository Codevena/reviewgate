// src/research/plan-refs.ts
const CODE_EXT = "ts|tsx|js|jsx|py|go|rs|java|kt|c|cc|cpp|h|hpp|rb|php|cs";
const EXT_RE = new RegExp(`\\.(?:${CODE_EXT})$`);
const PATH_CHARS = /[^A-Za-z0-9_./-]+/; // anything NOT allowed in a path token = a delimiter
const MAX_CANDIDATES = 200;

/** Extract repo-relative-looking code-file paths from arbitrary plan text (raw or
 *  a git-diff body — the `+`/`-`/` ` columns aren't in the token charset so they
 *  don't interfere). Dedupes, preserves first-seen order, caps the list. */
export function extractReferencedPaths(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // Split on delimiters first (linear), then test each short token — avoids the
  // O(n²) backtracking of one greedy regex over untrusted/long plan text.
  for (const tok of text.split(PATH_CHARS)) {
    if (!tok || tok.includes("..") || seen.has(tok)) continue;
    if (!EXT_RE.test(tok)) continue;
    seen.add(tok);
    out.push(tok);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}
