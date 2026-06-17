import type { Finding } from "../schemas/finding.ts";

// #6 instrumentation (field report 2026-06-17): COUNT + tag (never demote) findings that
// invoke a project/house rule WITHOUT a verifiable file:line citation. F-004 was "CLAUDE.md
// says: DO NOT ADD ANY COMMENTS" — a hallucinated rule (the reviewer model's training prior).
// The #6 prompt directive asks reviewers to cite file+line for any rule claim; this gives that
// directive a MEASURABLE signal: each run records how many uncited rule-claim findings it saw
// (persisted in RunSummary → the timestamped audit trail), so the before/after rate is the data
// basis for deciding whether a deterministic hard-drop backstop is later warranted.
//
// NON-SUPPRESSING by construction: this only TAGS (a visible pending.md badge) + COUNTS. It
// never changes severity/verdict — so it cannot hide a real finding (the same fail-safe posture
// the deferred hard-drop backstop would have to earn before shipping).

// A claim that invokes a repo/project/house rule or convention — the meta-assertion ("the repo
// says X"), NOT the finding's own code issue. Keyed on a rules-FILE reference or explicit
// convention/house-rule language.
const RULE_ASSERTION =
  /\b(?:CLAUDE\.md|AGENTS\.md|GEMINI\.md|COPILOT\.md|house[\s-]*rules?|repo(?:sitory)?[\s-]+(?:convention|rule|standard|guideline)s?|project[\s-]+(?:convention|rule|standard|guideline)s?|coding[\s-]+(?:standard|convention|guideline)s?|style[\s-]*guide|the\s+(?:repo|project|team)\s+convention|per\s+(?:the|our|your)\s+(?:convention|guidelines?|standards?|style\s*guide|coding\s+standard))\b/i;

// A verifiable citation for WHERE the rule is written: a file:line pointer, or "line N"
// (optionally "line N of <file>"). If the reviewer cited ANY location we give the benefit of
// the doubt (keeps false-positives low — this is a measurement, not a gate).
const CITATION = /\b[\w./-]+\.[a-z][a-z0-9]*:\d+|\bline\s+\d+\b/i;

export interface RuleCitationResult {
  findings: Finding[];
  /** Number of findings this call flagged as asserting an uncited project/house rule. */
  uncitedCount: number;
}

/**
 * Tag (do NOT demote) findings that assert a project/house rule without a verifiable
 * file:line citation, and count them. Pure, deterministic, fail-safe (severity untouched).
 */
export function tagUncitedRuleClaims(findings: Finding[], enabled = true): RuleCitationResult {
  if (!enabled) return { findings, uncitedCount: 0 };
  let uncitedCount = 0;
  const tagged = findings.map((f) => {
    const text = `${f.message}\n${f.details}`;
    if (RULE_ASSERTION.test(text) && !CITATION.test(text)) {
      uncitedCount += 1;
      return f.rule_citation_unverified ? f : { ...f, rule_citation_unverified: true };
    }
    return f;
  });
  return { findings: tagged, uncitedCount };
}
