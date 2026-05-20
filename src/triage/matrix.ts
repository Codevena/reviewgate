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

export function triageFromFacts(facts: DiffFacts): TriageDecision {
  const base = { schema: "reviewgate.triage.v1" as const };
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
      justification: "No reviewable changes in the diff.",
    };
  }
  if (facts.docOnly) {
    return {
      ...base,
      riskClass: "trivial",
      runReview: false,
      budgetTier: "trivial",
      loopCap: 1,
      reviewerHint: [],
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
      justification: `Sensitive paths: ${facts.sensitivityTags.join(", ")}.`,
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
    justification: "Default code change.",
  };
}
