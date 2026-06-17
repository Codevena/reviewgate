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

// A path that can plausibly HOLD a written rule/convention — a docs file (.md/.rst/…), a data/
// config file (.json/.yaml/.toml/…), or a `*.config.*` (e.g. reviewgate.config.ts where
// houseRules live). NOT an arbitrary code file: citing `src/foo.ts:42` points at the VIOLATION
// site, not at where the rule is written, so it must not count as a rule citation (codex DoD).
const RULE_SOURCE = String.raw`[\w./-]*(?:\.(?:md|mdx|markdown|rst|txt|json|jsonc|ya?ml|toml|ini|cfg)|\.config\.[a-z0-9]+)`;

// A verifiable citation to WHERE the rule is written: a rule-source `file:line`, or a rule-source
// file paired with a line ("CLAUDE.md line 5", "line 5 of CLAUDE.md"). A BARE "line N" or a code
// file:line is deliberately NOT accepted — both point at the violation, not the rule (codex DoD).
const CITATION = new RegExp(
  `(?:${RULE_SOURCE}):\\d+` +
    `|(?:${RULE_SOURCE})\\s+lines?\\s+\\d+` +
    `|\\blines?\\s+\\d+\\s+(?:of|in)\\s+(?:${RULE_SOURCE})`,
  "i",
);

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
