// src/triage/matrix.ts
import type { DiffFacts } from "../research/diff-facts.ts";
import type { TriageDecision } from "../schemas/triage.ts";

// reviewerHint semantics: an EMPTY hint means "run every reviewer the user
// configured" (the orchestrator falls back to the full configured panel). A
// non-empty hint NARROWS to those providers. We deliberately keep the hint
// empty for all review-running tiers so triage never SILENTLY DROPS a reviewer
// the user explicitly enabled (e.g. an OpenRouter/DeepSeek reviewer) — only the
// risk class, budget, and loop cap differ. Narrowing by provider id is reserved
// for a future per-risk policy.

export interface DocReviewPolicy {
  enabled: boolean;
  globs: string[];
  persona: string;
}

// N1: a diff at or below this many changed lines (added + removed), in a low-risk
// tier, is "small" — its soft iteration cap drops to SMALL_DIFF_MAX_ITERATIONS so a
// trivial fix isn't forced through the full adversarial loop. Sensitive/docs diffs
// are never small-gated (they keep the global cap regardless of size). Tunable here
// (not config): the cap is not review CONTENT, so it never affects the review cache.
export const SMALL_DIFF_LINES = 30;
export const SMALL_DIFF_MAX_ITERATIONS = 2;

// True when any changed path matches any glob. Uses Bun.Glob (built-in). An
// invalid glob is skipped with a warning and never throws — matching fails open
// to "no match" so a bad pattern can never crash the gate.
function matchesAnyGlob(paths: string[], globs: string[]): boolean {
  for (const g of globs) {
    let glob: InstanceType<typeof Bun.Glob>;
    try {
      glob = new Bun.Glob(g);
    } catch {
      console.warn(`reviewgate: invalid docReview glob ignored: ${g}`);
      continue;
    }
    for (const p of paths) {
      if (glob.match(p)) return true;
    }
  }
  return false;
}

export function triageFromFacts(facts: DiffFacts, docReview?: DocReviewPolicy): TriageDecision {
  const base = { schema: "reviewgate.triage.v1" as const };
  // N1: small low-risk diffs cap to fewer iterations. Sensitive/docs tiers below set
  // this to null explicitly (never small-gated). Empty/doc-skip tiers don't review.
  const smallCap =
    facts.totalAdded + facts.totalRemoved <= SMALL_DIFF_LINES ? SMALL_DIFF_MAX_ITERATIONS : null;
  if (facts.files.length === 0) {
    // Nothing to review (empty diff, or everything was Reviewgate-managed and
    // excluded). Skip the panel entirely instead of spawning reviewers on noise.
    return {
      ...base,
      riskClass: "trivial",
      runReview: false,
      budgetTier: "trivial",
      loopCap: 1,
      reviewerHint: [],
      maxIterationsOverride: null,
      justification: "No reviewable changes in the diff.",
    };
  }
  if (facts.docOnly) {
    if (
      docReview?.enabled &&
      matchesAnyGlob(
        facts.files.map((f) => f.path),
        docReview.globs,
      )
    ) {
      return {
        ...base,
        riskClass: "docs",
        runReview: true,
        budgetTier: "minimal",
        loopCap: 3,
        reviewerHint: [],
        maxIterationsOverride: null,
        justification: "Plan/doc review (matched docReview globs).",
      };
    }
    return {
      ...base,
      riskClass: "trivial",
      runReview: false,
      budgetTier: "trivial",
      loopCap: 1,
      reviewerHint: [],
      maxIterationsOverride: null,
      justification: "Doc-only diff; review skipped.",
    };
  }
  if (facts.sensitivityTags.length > 0) {
    return {
      ...base,
      riskClass: "sensitive",
      runReview: true,
      budgetTier: "expanded",
      loopCap: 5,
      reviewerHint: [],
      maxIterationsOverride: null, // sensitive paths are never small-gated
      justification: `Sensitive paths: ${facts.sensitivityTags.join(", ")}.`,
    };
  }
  if (facts.lockfileOnly) {
    // Regenerated lockfiles still get reviewed (supply-chain relevance: new or
    // swapped packages, registry/integrity drift) but at the minimal tier — a
    // full default panel on thousands of generated lines is noise. Checked
    // AFTER sensitivity so a sensitivity-tagged path always wins.
    return {
      ...base,
      riskClass: "minimal",
      runReview: true,
      budgetTier: "minimal",
      loopCap: 2,
      reviewerHint: [],
      maxIterationsOverride: smallCap,
      justification: "Lockfile-only diff.",
    };
  }
  if (facts.testsOnly) {
    return {
      ...base,
      riskClass: "minimal",
      runReview: true,
      budgetTier: "minimal",
      loopCap: 2,
      reviewerHint: [],
      maxIterationsOverride: smallCap,
      justification: "Tests-only diff.",
    };
  }
  return {
    ...base,
    riskClass: "default",
    runReview: true,
    budgetTier: "standard",
    loopCap: 3,
    reviewerHint: [],
    maxIterationsOverride: smallCap,
    justification: "Default code change.",
  };
}
