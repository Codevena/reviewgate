import type { Finding } from "../schemas/finding.ts";

// Deterministic self-refutation filter — no LLM, no network. A reviewer frequently
// investigates a concern, narrates the analysis, and CONCLUDES the code is fine ("This
// appears safe", "No issue", "No defect", "Safe.") yet still emits a structured finding
// carrying a blocking severity it never reconciled with its own conclusion (field report
// 2026-06-17: ~6/14 findings self-refuted). Nothing downstream reads the finding's own
// conclusion, so a self-contradicting WARN/CRITICAL lands in pending.md as a blocking
// finding the agent must fix-or-reject. This pass demotes such a finding to INFO
// (advisory). The reviewer's OWN terminal retraction is a FIRST-PARTY signal — like
// fact-check's provably-non-existent line — so the demote is category-independent.
//
// FAIL-SAFE by construction (a suppressor MUST fail safe):
//   • POSITIVE-signal only — demote ONLY when the finding's CONCLUSION clause IS a benign
//     verdict; an unrecognized finding is left fully blocking, exactly as today.
//   • Demote to INFO, NEVER drop — the finding stays visible/attributable and the agent
//     can still act on it. (The DROP variant was rejected: one regex miss silently kills
//     a real finding.)
//   • Negation/conditional backstop — the conclusion is the LAST clause (split on sentence
//     terminators + contrastive/conditional conjunctions + dashes), and an all-clear
//     adjective ("safe/fine/correct") is rejected when negated or conditional, so "this
//     WOULD be safe IF X but X is missing" / "this is NOT safe" / "appears safe but the
//     loop is unbounded" are never softened.

// Split a field into clauses on sentence terminators, contrastive/conditional
// conjunctions, dashes and bullets so the LAST clause is the actual conclusion.
// "No issue with naming, but the SQL is injectable" → last clause "the SQL is injectable".
const CLAUSE_SPLIT =
  /[.!?;]+|\s*[—–]+\s*|\s+-\s+|\s*,?\s+(?:but|however|although|though|yet|unless|except|whereas|otherwise|still|so|therefore|thus|hence)\s+/i;

// Leading meta-connectors stripped from the conclusion clause before matching, so
// "therefore, no issue" matches the same as "no issue".
const LEAD_CONNECTOR =
  /^[\s,:;)\]-]*(?:overall|in summary|in conclusion|in short|conclusion|verdict|net(?:-net)?|ultimately|finally|to conclude)\b[\s,:;)\]-]*/i;

// Family A — a positive all-clear adjective. CAN be negated/conditional, so it is guarded
// by NEGATION_OR_CONDITIONAL below. Two shapes: a bare adjective ("Safe.") or
// "<short subject> <copula> <adjective>" ("the index is correct", "this appears safe").
const BENIGN_ADJ_BARE =
  /^(?:safe|fine|correct|valid|benign|harmless|all good|all clear|looks good|lgtm)$/i;
const BENIGN_ADJ_CLAUSE =
  /^[\w\s'’-]{0,40}?\b(?:is|are|was|were|appears?|seems?|looks?|remains?|stays?|reads?)\s+(?:to be\s+|now\s+|actually\s+|indeed\s+)?(?:safe|fine|correct|valid|ok|okay|benign|acceptable|harmless|sound|secure|right|reasonable)$/i;

// Family B — an inherently-benign no-defect retraction (a positive "nothing wrong").
const BENIGN_NEG =
  /^no\s+(?:real\s+|actual\s+|genuine\s+|apparent\s+)?(?:issue|defect|bug|problem|vuln(?:erability)?|concern|risk|error|flaw|threat)s?(?:\s+(?:here|found|exists?|detected|present|identified|seen|observed))?$|^not\s+(?:a|an)\s+(?:issue|problem|bug|concern|vuln(?:erability)?|defect|risk|threat)$|^nothing\s+(?:wrong|to fix|to flag|concerning|of concern|problematic|to worry about)$/i;

// A negation or conditional that flips a Family-A all-clear into a NON-clearance.
const NEGATION_OR_CONDITIONAL =
  /\b(?:not|never|isn'?t|aren'?t|wasn'?t|weren'?t|cannot|can'?t|won'?t|don'?t|doesn'?t|no longer|if|unless|when|whenever|would|could|should|might|may|provided|assuming|as long as|depends|depending|once|only)\b/i;

/** True when the field's CONCLUSION clause is a benign verdict (a self-refutation). */
function isSelfRefutingText(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  const parts = text
    .split(CLAUSE_SPLIT)
    .map((s) => (s ?? "").trim())
    .filter((s) => s.length > 0);
  const last = parts.at(-1) ?? "";
  const clause = last
    .replace(LEAD_CONNECTOR, "")
    .trim()
    .replace(/[)\]\s.,:;!]+$/, "")
    .trim();
  if (!clause) return false;
  if (BENIGN_NEG.test(clause)) return true;
  if (
    (BENIGN_ADJ_BARE.test(clause) || BENIGN_ADJ_CLAUSE.test(clause)) &&
    !NEGATION_OR_CONDITIONAL.test(clause)
  ) {
    return true;
  }
  return false;
}

// Append the self-refutation note, keeping details within FindingSchema's 2000-char cap
// (truncate the original, never the note — same convention as fact-check/grounding).
function demote(f: Finding, note: string): Finding {
  return {
    ...f,
    severity: "INFO" as const,
    self_refuted: true,
    details: `${f.details.slice(0, Math.max(0, 2000 - note.length))}${note}`,
  };
}

const NOTE =
  '\n\n[reviewgate self-refutation] the reviewer\'s own conclusion states this is not a defect ("…safe / no issue") — demoted to advisory. If this is a real issue, re-raise it with a concrete, non-self-contradicting description.';

/**
 * Demote findings whose own conclusion retracts them ("…appears safe", "No issue",
 * "No defect", "Safe.") to INFO (advisory). Demote-only, positive-signal, fail-safe.
 * Skips deterministic check-tier findings and findings already at INFO (idempotent).
 */
export function demoteSelfRefuting(findings: Finding[], enabled = true): Finding[] {
  if (!enabled) return findings;
  return findings.map((f) => {
    if (f.severity === "INFO") return f; // already advisory — idempotent no-op
    if (f.deterministic) return f; // check-tier ground truth — never demote
    if (isSelfRefutingText(f.message) || isSelfRefutingText(f.details)) {
      return demote(f, NOTE);
    }
    return f;
  });
}
