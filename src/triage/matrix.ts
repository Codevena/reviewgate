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
    if (docReview?.enabled && matchesAnyGlob(facts.files.map((f) => f.path), docReview.globs)) {
      return {
        ...base,
        riskClass: "docs",
        runReview: true,
        budgetTier: "minimal",
        loopCap: 3,
        reviewerHint: [],
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
