import type { Finding } from "../schemas/finding.ts";

// #2 severity floor (field report 2026-06-17 non-convergence): a CRITICAL must describe a
// PRESENT, demonstrable defect. A reviewer that concedes the code is "currently safe" yet raises
// a CRITICAL for HYPOTHETICAL future fragility (the field F-005: afterEach-ordering on a test file
// the reviewer's own text calls "currently safe") inflates attention into an unconditional
// hard-FAIL and feeds the non-convergence treadmill. This pass demotes such a CRITICAL ONE step
// to WARN — still surfaced (never dropped, never INFO), just no longer an unconditional hard-FAIL.
//
// Distinct from self-refutation (#1): that demotes a TERMINAL "no issue" retraction and its
// conditional guard (if/would/could) deliberately REJECTS forward-looking text — so "currently
// safe but a future change could break it" sails through it. This pass targets exactly that class.
//
// FAIL-SAFE by construction (mirrors grounding layer-1 / self-refutation):
//   • CRITICAL→WARN one step ONLY (never to INFO, never dropped) — a real present bug worded with
//     future flourish still surfaces as a blocking WARN.
//   • POSITIVE hypothetical marker REQUIRED; an unrecognized finding stays CRITICAL.
//   • PRESENT-DEFECT backstop: a finding asserting BOTH a present defect AND a future one stays
//     CRITICAL.
//   • SECURITY/CORRECTNESS EXEMPT — the markers are untrusted reviewer prose; an injected/confused
//     reviewer could append "currently safe" to a real vuln, and the codebase never softens the
//     hard-veto categories on a text signal (self-refutation.ts + grounding.ts do the same).

// A POSITIVE present-safe concession or an explicit hypothetical/future-conditional framing —
// i.e. the reviewer's own text says there is no PRESENT defect.
const HYPOTHETICAL =
  /\b(?:currently|presently|right now|for now|at present|as of now|today)\s+(?:this\s+)?(?:is\s+|are\s+|remains?\s+|stays?\s+)?(?:safe|fine|ok|okay|correct|valid|harmless|acceptable)\b|\bno\s+(?:current|present|immediate)\s+(?:issue|problem|defect|bug|risk|vulnerability|concern)s?\b|\bnot\s+(?:yet|currently|presently)\s+(?:a|an)\s+(?:problem|bug|issue|concern|defect|risk)\b|\bhypothetical(?:ly)?\b|\btheoretical(?:ly)?\s+(?:risk|issue|concern|problem|defect)\b|\b(?:if|should|were|when|once)\b[^.]{0,40}\bfuture\b|\bfuture\b[^.]{0,25}\b(?:change|refactor|version|caller|usage|edit|modification|addition)\b|\bpurely\s+(?:a\s+)?(?:future|hypothetical|theoretical)\b|\bif\s+(?:a|any|some|someone)\b[^.]{0,40}\b(?:later|in future|down the line)\b/i;

// A PRESENT, demonstrable defect — vetoes the demote (the finding is NOT merely hypothetical).
const PRESENT_DEFECT =
  /\b(?:currently|presently|right now|already|today)\s+(?:is\s+)?(?:broken|failing|fails|crashes|crashing|leaks|leaking|vulnerable|wrong|incorrect|unsafe|exploitable)\b|\bas\s+(?:written|is)\b[^.]{0,40}\b(?:breaks|fails|crashes|leaks|is\s+wrong|is\s+unsafe|is\s+exploitable)\b|\bthis\s+(?:call|line|change|code|test)\s+(?:breaks|fails|crashes|leaks|is\s+wrong|is\s+unsafe)\b|\balready\s+(?:broken|failing|wrong|crashes|leaks|exploitable)\b/i;

function demote(f: Finding, note: string): Finding {
  return {
    ...f,
    severity: "WARN" as const,
    hypothetical_demoted: true,
    details: `${f.details.slice(0, Math.max(0, 2000 - note.length))}${note}`,
  };
}

const NOTE =
  "\n\n[reviewgate severity-floor] the reviewer's own text frames this as currently-safe / hypothetical / future fragility, not a present demonstrable defect — demoted CRITICAL→WARN. A CRITICAL needs a present, reproducible defect; re-raise as CRITICAL only with one.";

/**
 * Demote a CRITICAL to WARN (one step) when the reviewer's own text concedes no PRESENT defect
 * (currently-safe / hypothetical / future-conditional) and asserts no present-defect backstop.
 * Demote-only, positive-signal, security/correctness-exempt, fail-safe.
 */
export function demoteHypotheticalCriticals(findings: Finding[], enabled = true): Finding[] {
  if (!enabled) return findings;
  return findings.map((f) => {
    if (f.severity !== "CRITICAL") return f; // CRITICAL-only
    if (f.deterministic) return f; // check-tier ground truth — never demote
    // Never soften the hard-veto categories on an untrusted text signal (mirror self-refutation).
    if (f.category === "security" || f.category === "correctness") return f;
    const text = `${f.message}\n${f.details}\n${f.suggested_fix ?? ""}`;
    if (!HYPOTHETICAL.test(text)) return f; // positive marker required
    if (PRESENT_DEFECT.test(text)) return f; // also asserts a present defect → stays CRITICAL
    return demote(f, NOTE);
  });
}
