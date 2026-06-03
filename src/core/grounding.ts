import type { Finding } from "../schemas/finding.ts";

// S6 grounding (layer 1) — deterministic, no LLM. A reviewer occasionally fabricates
// a CRITICAL by inventing a code fact (field report 2026-06-03: F-003 claimed a
// `--muted-bg: 210 40% 96.1%` CSS variable that does not exist). A correctness/
// security CRITICAL hard-FAILs the gate UNCONDITIONALLY (aggregator.ts:576-590) and
// is exempt from the confidence/consensus/reputation demotes, so such a fabrication
// blocks even a large reviewer panel. This pass demotes a CRITICAL one step (→WARN)
// when it cites a code-shaped token that is wholly ABSENT from the reviewed corpus
// (the diff + full content of changed files — exactly what the reviewer was shown),
// i.e. ungrounded relative to its own input. Layer 2 (an LLM grounding judge) is
// deferred — it covers semantic fabrications (wrong values) this pass cannot see.

// CSS custom properties: highly distinctive (`--` prefix), safe to extract even from
// prose. An absent `--foo-bar` is almost certainly invented (CSS vars are defined in
// the very files under review).
const CSS_VAR = /--[a-z][a-z0-9-]+/g;
// Backtick code-spans. We only treat a span as a groundable token when it is a
// dotted/namespaced member or path ref (`auth.refreshToken`, `src/x/y.ts`): the
// reviewer named a SPECIFIC symbol, so its absence is a strong fabrication signal.
// Bare single-word identifiers are deliberately NOT grounded — they may legitimately
// live in an unchanged file the corpus does not include (avoids false demotes).
const BACKTICK = /`([^`\n]{2,80})`/g;
const CODE_SHAPED = /^[\w$][\w$./-]*$/;

function citedTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(CSS_VAR)) out.add(m[0]);
  for (const m of text.matchAll(BACKTICK)) {
    const span = m[1]?.trim();
    if (span && CODE_SHAPED.test(span) && /[./]/.test(span)) out.add(span);
  }
  return [...out];
}

// Demote-only, CRITICAL-only, fail-safe. A finding with no extractable code token, or
// whose every cited token is present in the corpus, is returned UNCHANGED.
export function groundFindings(findings: Finding[], corpus: string): Finding[] {
  return findings.map((f) => {
    if (f.severity !== "CRITICAL") return f;
    const tokens = citedTokens(`${f.message} ${f.details}`);
    if (tokens.length === 0) return f;
    const absent = tokens.filter((t) => !corpus.includes(t));
    if (absent.length === 0) return f;
    const note = `\n\n↓ grounding: cites ${absent
      .map((t) => `\`${t}\``)
      .join(
        ", ",
      )} not found in the reviewed code — likely fabricated; demoted to advisory. Verify before treating as real.`;
    // Keep details within FindingSchema's 2000-char cap (truncate the original, never
    // the note) — same convention as the aggregator's scope/confidence demotes.
    return {
      ...f,
      severity: "WARN" as const,
      grounding_demoted: true,
      details: `${f.details.slice(0, 2000 - note.length)}${note}`,
    };
  });
}
