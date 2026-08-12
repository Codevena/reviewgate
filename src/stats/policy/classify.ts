import { POLICY_PASS_IDS, POLICY_PASSES, type PolicyPassId } from "../../core/policy/catalog.ts";
import { POLICY_MEASUREMENT_THRESHOLDS, type PolicyClassification } from "../../core/policy/measurement-contract.ts";
import {
  type PolicyMeasurement,
  type PolicyPassClassification,
  type PolicyPassEvidence,
} from "../../schemas/policy-measurement.ts";

export type PolicyPassEvidenceInput = PolicyPassEvidence;
export type PolicyInteractionEvidenceInput = PolicyMeasurement["interactions"][number];

type DogfoodDisposition = "tp" | "fp";
type DogfoodEffect = "suppressed" | "preserved" | "none";

/** Identity-level facts are assembled from schema-validated source artifacts by Task 8. */
export interface PolicyPassClassificationFacts {
  readonly pass_id: PolicyPassId;
  readonly ground_truth_harms: readonly { readonly identity: string; readonly evidence_ref: string }[];
  readonly dogfood_dispositions: readonly {
    readonly identity: string;
    readonly run_id: string;
    readonly iter: number;
    readonly disposition: DogfoodDisposition;
    readonly effect: DogfoodEffect;
    readonly evidence_ref: string;
  }[];
  readonly beneficial_effects: readonly {
    readonly identity: string;
    readonly evidence_ref: string;
    readonly reproduced_by_pass_ids: readonly PolicyPassId[];
  }[];
}

export interface PolicyPassClassificationContext {
  readonly passFacts?: readonly PolicyPassClassificationFacts[];
  readonly interactions?: readonly PolicyInteractionEvidenceInput[];
}

type PolicyClassificationReason = NonNullable<PolicyPassClassification["reasons"]>[number];
type SafetyVeto = PolicyPassClassification["vetoes"][number];

const EMPTY_FACTS: PolicyPassClassificationFacts = {
  pass_id: "evidence.fact-location",
  ground_truth_harms: [],
  dogfood_dispositions: [],
  beneficial_effects: [],
};

function addReason(reasons: PolicyClassificationReason[], reason: PolicyClassificationReason): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function uniqueByIdentity<T extends { readonly identity: string }>(rows: readonly T[]): boolean {
  const identities = new Set<string>();
  for (const row of rows) {
    if (identities.has(row.identity)) return false;
    identities.add(row.identity);
  }
  return true;
}

function codeUnitSortedByIdentity<T extends { readonly identity: string }>(rows: readonly T[]): boolean {
  return rows.every((row, index) => index === 0 || (rows[index - 1]?.identity ?? "") < row.identity);
}

function allEligibleLanesAuthoritative(evidence: PolicyPassEvidence): boolean {
  return (!evidence.eligibility.stateless || evidence.authority.stateless) &&
    (!evidence.eligibility.stateful || evidence.authority.stateful) &&
    (!evidence.eligibility.dogfood || evidence.authority.dogfood);
}

function stableStatelessDirection(evidence: PolicyPassEvidence): boolean {
  const effects = evidence.statistics.raw_effects;
  if (effects.length !== 3) return false;
  const positive = effects.filter((effect) => effect > 0).length;
  const negative = effects.filter((effect) => effect < 0).length;
  return (positive >= 2 && negative === 0) || (negative >= 2 && positive === 0) ||
    (positive === 0 && negative === 0);
}

function hasSufficientPrimaryEvidence(evidence: PolicyPassEvidence): boolean {
  if (!allEligibleLanesAuthoritative(evidence)) return false;
  if (evidence.lane === "stateless-bench") {
    return evidence.opportunities.cases >= POLICY_MEASUREMENT_THRESHOLDS.statelessCases &&
      evidence.opportunities.signatures >= POLICY_MEASUREMENT_THRESHOLDS.statelessSignatures &&
      stableStatelessDirection(evidence);
  }
  return evidence.opportunities.cases >= POLICY_MEASUREMENT_THRESHOLDS.statefulSequences &&
    evidence.opportunities.turns >=
      POLICY_MEASUREMENT_THRESHOLDS.statefulSequences *
        POLICY_MEASUREMENT_THRESHOLDS.opportunityTurnsPerSequence;
}

function totalGroundTruthError(evidence: PolicyPassEvidence): number {
  const counts = evidence.truth_effects;
  return counts.ablated.blocking_fp + counts.ablated.blocking_fn -
    counts.baseline.blocking_fp - counts.baseline.blocking_fn;
}

function hasAggregateBenefit(evidence: PolicyPassEvidence): boolean {
  return totalGroundTruthError(evidence) > 0 || evidence.truth_effects.error_reduction > 0;
}

function hasAggregateHarm(evidence: PolicyPassEvidence): boolean {
  return totalGroundTruthError(evidence) < 0 ||
    evidence.truth_effects.baseline.blocking_tp < evidence.truth_effects.ablated.blocking_tp;
}

function factsAreBound(
  evidence: PolicyPassEvidence,
  facts: PolicyPassClassificationFacts,
): boolean {
  const refs = new Set(evidence.raw_evidence_refs);
  return uniqueByIdentity(facts.ground_truth_harms) && uniqueByIdentity(facts.dogfood_dispositions) &&
    uniqueByIdentity(facts.beneficial_effects) && codeUnitSortedByIdentity(facts.ground_truth_harms) &&
    codeUnitSortedByIdentity(facts.dogfood_dispositions) &&
    codeUnitSortedByIdentity(facts.beneficial_effects) &&
    facts.ground_truth_harms.every((fact) => refs.has(fact.evidence_ref)) &&
    facts.dogfood_dispositions.every((fact) => refs.has(fact.evidence_ref)) &&
    facts.beneficial_effects.every((fact) => refs.has(fact.evidence_ref));
}

function dogfoodIsSufficient(facts: PolicyPassClassificationFacts): boolean {
  return facts.dogfood_dispositions.length >= POLICY_MEASUREMENT_THRESHOLDS.dogfoodDispositions &&
    new Set(facts.dogfood_dispositions.map((fact) => `${fact.run_id}\u0000${fact.iter}`)).size >=
      POLICY_MEASUREMENT_THRESHOLDS.dogfoodRuns;
}

function uniqueContributionsAreBound(evidence: PolicyPassEvidence): boolean {
  const refs = new Set(evidence.raw_evidence_refs);
  return evidence.unique_contributions.every((contribution) => refs.has(contribution.evidence.ref));
}

function directVetoes(evidence: PolicyPassEvidence): SafetyVeto[] {
  if (!uniqueContributionsAreBound(evidence)) return [];
  const vetoes: SafetyVeto[] = [];
  for (const contribution of evidence.unique_contributions) {
    const veto = contribution.kind === "prevented-blocking-fp"
      ? "unique-prevented-fp"
      : contribution.kind === "preserved-blocking-tp"
      ? "unique-preserved-tp"
      : "required-backstop";
    if (!vetoes.includes(veto)) vetoes.push(veto);
  }
  return vetoes;
}

type InteractionStatus = "none" | "harm" | "incomplete-authority";

function interactionStatus(
  passId: PolicyPassId,
  evidence: PolicyPassEvidence,
  interactions: readonly PolicyInteractionEvidenceInput[],
): InteractionStatus {
  const refs = new Set(evidence.raw_evidence_refs);
  let harmObserved = false;
  for (const interaction of interactions) {
    if (!interaction.pass_ids.includes(passId)) continue;
    const row = interaction.evidence;
    const authoritative = (!row.eligibility.stateless || row.authority.stateless) &&
      (!row.eligibility.stateful || row.authority.stateful) &&
      (!row.eligibility.dogfood || row.authority.dogfood);
    if (!row.authoritative || !authoritative || !refs.has(interaction.artifact.ref) ||
      !row.raw_evidence_refs.every((ref) => refs.has(ref))) {
      return "incomplete-authority";
    }
    const harm = row.truth_effects.ablated.blocking_fp + row.truth_effects.ablated.blocking_fn <
      row.truth_effects.baseline.blocking_fp + row.truth_effects.baseline.blocking_fn ||
      row.truth_effects.baseline.blocking_tp < row.truth_effects.ablated.blocking_tp;
    harmObserved ||= harm;
  }
  return harmObserved ? "harm" : "none";
}

function orderEvidence(evidence: readonly PolicyPassEvidence[]): PolicyPassEvidence[] {
  return [...evidence].sort(
    (left, right) => POLICY_PASS_IDS.indexOf(left.pass_id) - POLICY_PASS_IDS.indexOf(right.pass_id),
  );
}

/**
 * Classifies only schema-validated evidence. The optional context is identity-level, raw-ref-bound
 * evidence assembled by Task 8; it deliberately never derives identities from aggregate counts.
 */
export function classifyPolicyPasses(
  evidence: readonly PolicyPassEvidenceInput[],
  context: PolicyPassClassificationContext = {},
): PolicyPassClassification[] {
  const suppliedFacts = context.passFacts ?? [];
  const duplicateFactPassIds = new Set<PolicyPassId>();
  const factsByPass = new Map<PolicyPassId, PolicyPassClassificationFacts>();
  for (const facts of suppliedFacts) {
    if (factsByPass.has(facts.pass_id)) duplicateFactPassIds.add(facts.pass_id);
    factsByPass.set(facts.pass_id, facts);
  }
  const retained = new Set<PolicyPassId>();
  const vetoesByPass = new Map<PolicyPassId, SafetyVeto[]>();

  // Phase 1 fixes the retained set solely from direct, pass-identifiable protection/backstop facts.
  for (const row of evidence) {
    const vetoes = directVetoes(row);
    vetoesByPass.set(row.pass_id, vetoes);
    if (vetoes.length > 0) retained.add(row.pass_id);
  }

  return orderEvidence(evidence).map((row) => {
    const facts = factsByPass.get(row.pass_id) ?? { ...EMPTY_FACTS, pass_id: row.pass_id };
    const reasons: PolicyClassificationReason[] = [];
    const vetoes = vetoesByPass.get(row.pass_id) ?? [];
    const factsBound = !duplicateFactPassIds.has(row.pass_id) && factsAreBound(row, facts);
    const aggregateHarm = hasAggregateHarm(row);
    const aggregateBenefit = hasAggregateBenefit(row);
    const harms = facts.ground_truth_harms.length;
    const dogfoodSufficient = dogfoodIsSufficient(facts);
    const suppressedTp = facts.dogfood_dispositions.some(
      (fact) => fact.disposition === "tp" && fact.effect === "suppressed",
    );
    const harmObserved = harms > 0 || (dogfoodSufficient && suppressedTp);

    if (!factsBound || !uniqueContributionsAreBound(row) || (aggregateHarm && harms === 0) || (aggregateBenefit && facts.beneficial_effects.length === 0 && harms === 0)) {
      addReason(reasons, "incomplete-authority");
    }
    if (!allEligibleLanesAuthoritative(row)) addReason(reasons, "incomplete-authority");
    if (!hasSufficientPrimaryEvidence(row)) {
      if (row.lane === "stateless-bench" && !stableStatelessDirection(row)) {
        addReason(reasons, "direction-conflict");
      } else {
        addReason(reasons, "insufficient-opportunities");
      }
    }
    if (row.eligibility.dogfood && !dogfoodSufficient && facts.dogfood_dispositions.length > 0) {
      addReason(reasons, "dogfood-only");
    }
    if (harms === 1 && !(dogfoodSufficient && suppressedTp)) {
      // One identity-level ground-truth harm alone is neither a deletion warrant nor enough for harm.
      addReason(reasons, "incomplete-authority");
    }

    if (retained.has(row.pass_id)) {
      for (const veto of vetoes) addReason(reasons, veto);
      return {
        pass_id: row.pass_id,
        classification: "retain" as PolicyClassification,
        reasons,
        vetoes,
        harm_observed: harmObserved,
        evidence_refs: row.raw_evidence_refs,
        evidence: row,
      };
    }

    if (factsBound && (harms >= 2 || (harms === 1 && dogfoodSufficient && suppressedTp))) {
      addReason(reasons, harms >= 2 ? "two-ground-truth-harms" : "ground-truth-plus-dogfood-harm");
      return {
        pass_id: row.pass_id,
        classification: "harmful-candidate" as PolicyClassification,
        reasons,
        vetoes,
        harm_observed: true,
        evidence_refs: row.raw_evidence_refs,
        evidence: row,
      };
    }

    const coversEveryBenefit = facts.beneficial_effects.every((benefit) =>
      benefit.reproduced_by_pass_ids.some(
        (cover) => retained.has(cover) && POLICY_PASSES.find((pass) => pass.id === row.pass_id)?.overlaps_with.includes(cover),
      ),
    );
    const interaction = interactionStatus(row.pass_id, row, context.interactions ?? []);
    const interactionHarm = interaction === "harm";
    if (interaction === "incomplete-authority") addReason(reasons, "incomplete-authority");
    if (interactionHarm) addReason(reasons, "interaction-removal-harm");
    if (facts.beneficial_effects.length > 0 && !coversEveryBenefit) addReason(reasons, "uncovered-benefit");

    const canDelete = reasons.length === 0 && hasSufficientPrimaryEvidence(row) && coversEveryBenefit && !interactionHarm;
    if (canDelete) addReason(reasons, "sufficient-covered-zero-unique-benefit");
    return {
      pass_id: row.pass_id,
      classification: (canDelete ? "delete-candidate" : "inconclusive") as PolicyClassification,
      reasons,
      vetoes,
      harm_observed: harmObserved,
      evidence_refs: row.raw_evidence_refs,
      evidence: row,
    };
  });
}
