// src/triage/matrix.ts
import type { DiffFacts } from "../research/diff-facts.ts";
import type { TriageDecision } from "../schemas/triage.ts";

export function triageFromFacts(facts: DiffFacts): TriageDecision {
  const base = { schema: "reviewgate.triage.v1" as const };
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
      reviewerHint: ["codex", "gemini", "claude-code", "openrouter"],
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
      reviewerHint: ["codex"],
      justification: "Tests-only diff.",
    };
  }
  return {
    ...base,
    riskClass: "default",
    runReview: true,
    budgetTier: "standard",
    loopCap: 3,
    reviewerHint: ["codex", "gemini", "claude-code"],
    justification: "Default code change.",
  };
}
