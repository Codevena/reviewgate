import {
  type PolicyMeasurement,
  PolicyMeasurementSchema,
} from "../../schemas/policy-measurement.ts";

function cell(value: string | number | boolean): string {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function binding(ref: string, sha256: string): string {
  return `\`${cell(ref)}\` (${sha256})`;
}

function opportunities(value: {
  cases: number;
  signatures: number;
  turns: number;
  runs: number;
}): string {
  return `cases=${value.cases}; signatures=${value.signatures}; turns=${value.turns}; runs=${value.runs}`;
}

function classification(value: string, reasons: readonly string[]): string {
  return `${value.toUpperCase()} — ${reasons.join(", ")}`;
}

type PolicyStatistics = PolicyMeasurement["passes"][number]["evidence"]["statistics"];

function display(value: number | null): string {
  return value === null ? "none" : String(value);
}

function delta(value: {
  baseline: number | null;
  ablated: number | null;
  delta: number | null;
}): string {
  return `${display(value.baseline)}/${display(value.ablated)}/${display(value.delta)}`;
}

function caseEffectDossiers(statistics: PolicyStatistics): string {
  return statistics.case_effects.length === 0
    ? "none"
    : statistics.case_effects
        .map(
          (effect) =>
            `case=${cell(effect.case_id)}; repeat=${effect.repeat}; error reduction=${effect.error_reduction}; baseline dossier=${binding(effect.baseline_dossier.ref, effect.baseline_dossier.sha256)}; ablated dossier=${binding(effect.ablated_dossier.ref, effect.ablated_dossier.sha256)}`,
        )
        .join(" | ");
}

function statisticsDossier(statistics: PolicyStatistics): string {
  const repeatDirections =
    statistics.repeat_directions.length === 0
      ? "none"
      : statistics.repeat_directions
          .map(
            (direction) =>
              `repeat ${direction.repeat}=${direction.direction} (mean=${direction.mean_error_reduction})`,
          )
          .join(", ");
  return [
    `raw effects=${statistics.raw_effects.join(",") || "none"}`,
    `mean paired error reduction=${statistics.mean_error_reduction}`,
    `median paired error reduction=${statistics.median_error_reduction}`,
    `repeat directions=${repeatDirections}`,
    `error components FP baseline/ablated/delta=${delta(statistics.error_components.blocking_fp)}; FN baseline/ablated/delta=${delta(statistics.error_components.blocking_fn)}`,
    `precision baseline/ablated/delta=${delta(statistics.precision_delta)}; recall baseline/ablated/delta=${delta(statistics.recall_delta)}`,
    `blocking count baseline/ablated/delta=${delta(statistics.blocking_count_delta)}`,
    `severity deltas critical=${delta(statistics.severity_deltas.critical)}; warn=${delta(statistics.severity_deltas.warn)}; info=${delta(statistics.severity_deltas.info)}`,
    `verdict deltas pass=${delta(statistics.verdict_deltas.pass)}; soft-pass=${delta(statistics.verdict_deltas.soft_pass)}; fail=${delta(statistics.verdict_deltas.fail)}`,
    `case dossiers=${caseEffectDossiers(statistics)}`,
    `interval=[${statistics.interval.lo},${statistics.interval.hi}]`,
    `p=${statistics.p_value}`,
    `adjusted p=${statistics.adjusted_p_value}`,
  ].join("; ");
}

function laneSummaryLine(input: {
  lane: string;
  primary: boolean;
  descriptive: boolean;
  eligible: boolean;
  authoritative: boolean;
  opportunities: { cases: number; signatures: number; turns: number; runs: number };
  truth_effects: {
    baseline: { blocking_fp: number; blocking_fn: number; blocking_tp: number };
    ablated: { blocking_fp: number; blocking_fn: number; blocking_tp: number };
    error_reduction: number;
  };
  trace_totals: {
    applied: number;
    would_apply: number;
    protected: number;
    no_opportunity: number;
  };
  statistics: PolicyStatistics;
  exclusions: Array<{ lane: string; code: string; count: number }>;
  limitations: string[];
  raw_evidence_refs: string[];
}): string {
  return `Lane ${input.lane}: primary=${input.primary}; descriptive=${input.descriptive}; eligible=${input.eligible}; authoritative=${input.authoritative}; opportunities=${opportunities(input.opportunities)}; truth baseline FP/FN/TP=${input.truth_effects.baseline.blocking_fp}/${input.truth_effects.baseline.blocking_fn}/${input.truth_effects.baseline.blocking_tp}; ablated FP/FN/TP=${input.truth_effects.ablated.blocking_fp}/${input.truth_effects.ablated.blocking_fn}/${input.truth_effects.ablated.blocking_tp}; error reduction=${input.truth_effects.error_reduction}; trace applied/would-apply/protected/no-opportunity=${input.trace_totals.applied}/${input.trace_totals.would_apply}/${input.trace_totals.protected}/${input.trace_totals.no_opportunity}; ${statisticsDossier(input.statistics)}; exclusions=${input.exclusions.map((row) => `${row.lane}:${row.code}=${row.count}`).join(",") || "none"}; limitations=${input.limitations.join(",") || "none"}; evidence=${input.raw_evidence_refs.map((ref) => `\`${cell(ref)}\``).join(", ")}`;
}

/** Render the parsed evidence result without adding conclusions beyond its JSON fields. */
export function renderPolicyMeasurement(result: PolicyMeasurement): string {
  const parsed = PolicyMeasurementSchema.parse(result);
  const lines = [
    "# Policy measurement",
    "",
    "## Artifact authority",
    "",
    `- Authoritative: ${parsed.artifacts.authoritative}`,
    `- Preregistration: ${binding(parsed.preregistration.ref, parsed.preregistration.sha256)}`,
    `- Catalog: \`${parsed.catalog_version}\``,
    `- Closed source inventory: ${parsed.artifacts.inventory.length}`,
    "",
    "| Pass | Lane | Opportunities | Classification |",
    "| --- | --- | --- | --- |",
    ...parsed.passes.map(
      (pass) =>
        `| \`${pass.pass_id}\` | ${pass.evidence.lane} | ${opportunities(pass.evidence.opportunities)} | ${classification(pass.classification, pass.reasons)} |`,
    ),
    "",
    "## Interactions",
    "",
    "| Passes | Primary lane | Opportunities | Raw p-value | Adjusted p-value | 95% interval |",
    "| --- | --- | --- | --- | --- |",
    ...parsed.interactions.map(
      (interaction) =>
        `| ${interaction.pass_ids.map((passId) => `\`${passId}\``).join(", ")} | ${interaction.primary_lane} | ${opportunities(interaction.evidence.opportunities)} | ${interaction.evidence.statistics.p_value} | ${interaction.evidence.statistics.adjusted_p_value} | [${interaction.evidence.statistics.interval.lo}, ${interaction.evidence.statistics.interval.hi}] |`,
    ),
    "",
    "## Evidence and veto dossiers",
    "",
    ...parsed.passes.flatMap((pass) => [
      `### \`${pass.pass_id}\``,
      "",
      `- Classification: ${classification(pass.classification, pass.reasons)}`,
      `- Harm observed: ${pass.harm_observed}`,
      `- Vetoes: ${pass.vetoes.length === 0 ? "none" : pass.vetoes.join(", ")}`,
      `- Truth effects: baseline FP/FN/TP = ${pass.evidence.truth_effects.baseline.blocking_fp}/${pass.evidence.truth_effects.baseline.blocking_fn}/${pass.evidence.truth_effects.baseline.blocking_tp}; ablated FP/FN/TP = ${pass.evidence.truth_effects.ablated.blocking_fp}/${pass.evidence.truth_effects.ablated.blocking_fn}/${pass.evidence.truth_effects.ablated.blocking_tp}; error reduction = ${pass.evidence.truth_effects.error_reduction}`,
      `- Trace totals: applied=${pass.evidence.trace_totals.applied}; would-apply=${pass.evidence.trace_totals.would_apply}; protected=${pass.evidence.trace_totals.protected}; no-opportunity=${pass.evidence.trace_totals.no_opportunity}`,
      `- Raw p-value: ${pass.evidence.statistics.p_value}; adjusted p-value: ${pass.evidence.statistics.adjusted_p_value}; 95% interval: [${pass.evidence.statistics.interval.lo}, ${pass.evidence.statistics.interval.hi}]`,
      `- Raw effects: ${pass.evidence.statistics.raw_effects.join(", ") || "none"}`,
      `- Mean paired error reduction: ${pass.evidence.statistics.mean_error_reduction}`,
      `- Median paired error reduction: ${pass.evidence.statistics.median_error_reduction}`,
      `- Repeat directions: ${pass.evidence.statistics.repeat_directions.length === 0 ? "none" : pass.evidence.statistics.repeat_directions.map((direction) => `repeat ${direction.repeat}=${direction.direction} (mean=${direction.mean_error_reduction})`).join(", ")}`,
      `- Error components FP baseline/ablated/delta=${delta(pass.evidence.statistics.error_components.blocking_fp)}; FN baseline/ablated/delta=${delta(pass.evidence.statistics.error_components.blocking_fn)}`,
      `- Precision baseline/ablated/delta=${delta(pass.evidence.statistics.precision_delta)}; recall baseline/ablated/delta=${delta(pass.evidence.statistics.recall_delta)}`,
      `- Blocking count baseline/ablated/delta=${delta(pass.evidence.statistics.blocking_count_delta)}`,
      `- Severity deltas critical=${delta(pass.evidence.statistics.severity_deltas.critical)}; warn=${delta(pass.evidence.statistics.severity_deltas.warn)}; info=${delta(pass.evidence.statistics.severity_deltas.info)}`,
      `- Verdict deltas pass=${delta(pass.evidence.statistics.verdict_deltas.pass)}; soft-pass=${delta(pass.evidence.statistics.verdict_deltas.soft_pass)}; fail=${delta(pass.evidence.statistics.verdict_deltas.fail)}`,
      `- Case dossiers: ${caseEffectDossiers(pass.evidence.statistics)}`,
      `- Eligibility: stateless=${pass.evidence.eligibility.stateless}; stateful=${pass.evidence.eligibility.stateful}; dogfood=${pass.evidence.eligibility.dogfood}`,
      `- Authority: stateless=${pass.evidence.authority.stateless}; stateful=${pass.evidence.authority.stateful}; dogfood=${pass.evidence.authority.dogfood}`,
      `- Exclusions: ${pass.evidence.exclusions.length === 0 ? "none" : pass.evidence.exclusions.map((row) => `${row.lane}:${row.code}=${row.count}`).join(", ")}`,
      `- Limitations: ${pass.evidence.lane_summaries.map((summary) => `${summary.lane}:${summary.limitations.join(",") || "none"}`).join("; ")}`,
      `- Raw evidence: ${pass.evidence.raw_evidence_refs.map((ref) => `\`${cell(ref)}\``).join(", ")}`,
      `- Lane summaries: ${pass.evidence.lane_summaries.map(laneSummaryLine).join(" | ")}`,
      `- Unique contributions: ${pass.evidence.unique_contributions.length === 0 ? "none" : pass.evidence.unique_contributions.map((row) => `${row.kind} identity=${cell(row.identity)} singleton=${binding(row.evidence.ref, row.evidence.sha256)} group=${binding(row.group_comparison.artifact.ref, row.group_comparison.artifact.sha256)} group_raw=${row.group_comparison.raw_evidence.map((entry) => binding(entry.ref, entry.sha256)).join(",")}`).join("; ")}`,
      `- Identity evidence: ${(() => {
        const identity = parsed.identity_evidence.find((row) => row.pass_id === pass.pass_id);
        if (identity === undefined) return "none";
        const harms = identity.ground_truth_harms.map(
          (row) =>
            `harm identity=${cell(row.identity)} kind=ground-truth evidence=${cell(row.evidence_ref)}`,
        );
        const dogfood = identity.dogfood_dispositions.map(
          (row) =>
            `dogfood identity=${cell(row.identity)} run=${cell(row.run_id)} iter=${row.iter} disposition=${row.disposition} effect=${row.effect} evidence=${cell(row.evidence_ref)}`,
        );
        const benefits = identity.beneficial_effects.map(
          (row) =>
            `benefit identity=${cell(row.identity)} evidence=${cell(row.evidence_ref)} singleton=${binding(row.singleton_evidence.ref, row.singleton_evidence.sha256)} group=${row.group_comparison === undefined ? "none" : binding(row.group_comparison.artifact.ref, row.group_comparison.artifact.sha256)} group_raw=${row.group_comparison === undefined ? "none" : row.group_comparison.raw_evidence.map((entry) => binding(entry.ref, entry.sha256)).join(",")} reproduced_by=${row.reproduced_by_pass_ids.map((id) => `\`${id}\``).join(",") || "none"}`,
        );
        return [...harms, ...dogfood, ...benefits].join("; ") || "none";
      })()}`,
      "",
    ]),
    "## Interaction lane summaries",
    "",
    ...parsed.interactions.flatMap((interaction) => [
      `### ${interaction.pass_ids.map((passId) => `\`${passId}\``).join(", ")}`,
      "",
      ...interaction.lane_summaries.map((summary) => `- ${laneSummaryLine(summary)}`),
      "",
    ]),
    "## Artifact inventory",
    "",
    ...parsed.artifacts.inventory.map((artifact) => `- ${binding(artifact.ref, artifact.sha256)}`),
  ];
  return `${lines.join("\n")}\n`;
}
