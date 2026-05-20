// src/triage/triage-engine.ts
import type { TriageDecision } from "../schemas/triage.ts";

const TIER_RANK: Record<TriageDecision["budgetTier"], number> = {
  trivial: 0,
  minimal: 1,
  standard: 2,
  expanded: 3,
};

export type TriageLlm =
  | (() => Promise<{ riskClass?: string; budgetTier?: string; justification?: string }>)
  | null;

export async function refineTriage(
  det: TriageDecision,
  opts: { llm: TriageLlm },
): Promise<TriageDecision> {
  if (!opts.llm) return det;
  let out: { riskClass?: string; budgetTier?: string; justification?: string };
  try {
    out = await opts.llm();
  } catch {
    return det;
  }
  const detRank = TIER_RANK[det.budgetTier];
  const llmTier =
    out.budgetTier && out.budgetTier in TIER_RANK
      ? (out.budgetTier as TriageDecision["budgetTier"])
      : det.budgetTier;
  const cappedTier = TIER_RANK[llmTier] <= detRank ? llmTier : det.budgetTier;
  return {
    ...det,
    budgetTier: cappedTier,
    ...(out.justification
      ? { justification: `${det.justification} | LLM: ${out.justification.slice(0, 200)}` }
      : {}),
  };
}
