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
    "| Passes | Opportunities | Raw p-value | Adjusted p-value | 95% interval |",
    "| --- | --- | --- | --- |",
    ...parsed.interactions.map(
      (interaction) =>
        `| ${interaction.pass_ids.map((passId) => `\`${passId}\``).join(", ")} | ${opportunities(interaction.evidence.opportunities)} | ${interaction.evidence.statistics.p_value} | ${interaction.evidence.statistics.adjusted_p_value} | [${interaction.evidence.statistics.interval.lo}, ${interaction.evidence.statistics.interval.hi}] |`,
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
      `- Eligibility: stateless=${pass.evidence.eligibility.stateless}; stateful=${pass.evidence.eligibility.stateful}; dogfood=${pass.evidence.eligibility.dogfood}`,
      `- Authority: stateless=${pass.evidence.authority.stateless}; stateful=${pass.evidence.authority.stateful}; dogfood=${pass.evidence.authority.dogfood}`,
      `- Exclusions: ${pass.evidence.exclusions.length === 0 ? "none" : pass.evidence.exclusions.map((row) => `${row.lane}:${row.code}=${row.count}`).join(", ")}`,
      `- Raw evidence: ${pass.evidence.raw_evidence_refs.map((ref) => `\`${cell(ref)}\``).join(", ")}`,
      `- Unique contributions: ${pass.evidence.unique_contributions.length === 0 ? "none" : pass.evidence.unique_contributions.map((row) => `${row.kind} via ${binding(row.evidence.ref, row.evidence.sha256)}`).join("; ")}`,
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
            `benefit identity=${cell(row.identity)} evidence=${cell(row.evidence_ref)} reproduced_by=${row.reproduced_by_pass_ids.map((id) => `\`${id}\``).join(",") || "none"}`,
        );
        return [...harms, ...dogfood, ...benefits].join("; ") || "none";
      })()}`,
      "",
    ]),
    "## Artifact inventory",
    "",
    ...parsed.artifacts.inventory.map((artifact) => `- ${binding(artifact.ref, artifact.sha256)}`),
  ];
  return `${lines.join("\n")}\n`;
}
