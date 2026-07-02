// reviewgate bench — report renderer (spec §5.2/§6).
//
// Turns a saved BenchResult into (a) a terminal table for eyeballing and (b) a
// paste-ready markdown block for the README / a blog post. It LEADS with the Clean
// FP-rate — the number competitors hide and the one the suppression stack is built
// to win — and reports every rate with its raw num/den and Wilson CI so a smoke-N
// figure is never over-read. A run that isn't trustworthy (dirty corpus, invalid
// cases, or no clean/seeded cases) is flagged non-authoritative and its headline
// framing withheld, mirroring `bench run`'s exit-4 gate. Pure, no I/O.

import type { BenchResult, CaseResult, Metric, SpreadStat } from "../schemas/bench-result.ts";

/** Re-derive whether a saved run is trustworthy from the stored signals. */
export function isAuthoritative(result: BenchResult): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (result.provenance.corpus_dirty) {
    reasons.push("corpus had uncommitted changes (dirty) — not reproducible");
  }
  const invalid = result.cases.filter((c) => c.status === "invalid").length;
  if (invalid > 0) reasons.push(`${invalid} invalid case(s)`);
  const reviewErrors = result.cases.filter((c) => c.status === "review-error").length;
  if (reviewErrors > 0) reasons.push(`${reviewErrors} case(s) failed to review`);
  if (result.provenance.case_count.clean === 0)
    reasons.push("zero clean cases (FP-rate unmeasured)");
  if (result.provenance.case_count.seeded === 0)
    reasons.push("zero seeded cases (recall unmeasured)");
  return { ok: reasons.length === 0, reasons };
}

/** `0.85 (17/20, 95% CI 0.64–0.95)`; `n/a (0/0)` for an undefined (den=0) rate. */
function fmtMetric(m: Metric): string {
  if (m.value === null || m.ci_lo === null || m.ci_hi === null) {
    return `n/a (${m.num}/${m.den})`;
  }
  return `${m.value.toFixed(2)} (${m.num}/${m.den}, 95% CI ${m.ci_lo.toFixed(2)}–${m.ci_hi.toFixed(2)})`;
}

/** `0.33 ± 0.47 (min 0.00, max 1.00)`; `n/a` when no repeat had a defined value. */
function fmtSpread(s: SpreadStat): string {
  if (s.mean === null || s.stddev === null || s.min === null || s.max === null) return "n/a";
  return `${s.mean.toFixed(2)} ± ${s.stddev.toFixed(2)} (min ${s.min.toFixed(2)}, max ${s.max.toFixed(2)})`;
}

function scored(result: BenchResult): CaseResult[] {
  return result.cases.filter((c) => c.status === "scored");
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

export function renderBenchReport(result: BenchResult): { table: string; markdown: string } {
  const auth = isAuthoritative(result);
  const p = result.provenance;
  const scoredCases = scored(result);
  const seededScored = scoredCases.filter((c) => c.kind === "seeded-bug").length;
  const cleanScored = scoredCases.filter((c) => c.kind === "clean").length;

  // --- terminal table ---
  const L: string[] = [];
  L.push("Reviewgate bench report");
  L.push("=======================");
  if (!auth.ok) {
    L.push("");
    L.push("⚠ NON-AUTHORITATIVE run — headline numbers are indicative only:");
    for (const r of auth.reasons) L.push(`  · ${r}`);
  }
  L.push("");
  L.push("Headline (aggregated panel):");
  L.push(`  Clean FP-rate : ${fmtMetric(result.aggregate.clean_fp_rate)}`);
  L.push(`  Precision     : ${fmtMetric(result.aggregate.precision)}`);
  L.push(`  Recall        : ${fmtMetric(result.aggregate.recall)}`);
  L.push("");
  L.push(
    `Cases: ${scoredCases.length} scored (${seededScored} seeded, ${cleanScored} clean) of ${result.cases.length} total`,
  );

  if (result.stability) {
    const s = result.stability;
    L.push("");
    L.push(`Stability (mean ± sd, min–max over ${s.repeats} repeats — LLM run-to-run variance):`);
    L.push(`  Clean FP-rate : ${fmtSpread(s.clean_fp_rate)}`);
    L.push(`  Precision     : ${fmtSpread(s.precision)}`);
    L.push(`  Recall        : ${fmtSpread(s.recall)}`);
  }

  L.push("");
  L.push("Per-provider (RAW, pre-aggregation):");
  const rows = result.providers.map((pr) => ({
    provider: pr.provider,
    coverage: fmtMetric(pr.coverage),
    precision: fmtMetric(pr.precision),
    recall: fmtMetric(pr.recall),
    auth: pr.authoritative ? "yes" : "no",
  }));
  const wProv = Math.max(8, ...rows.map((r) => r.provider.length));
  L.push(
    `  ${pad("provider", wProv)}  ${pad("coverage", 22)}  ${pad("precision", 22)}  ${pad("recall", 22)}  authoritative`,
  );
  for (const r of rows) {
    L.push(
      `  ${pad(r.provider, wProv)}  ${pad(r.coverage, 22)}  ${pad(r.precision, 22)}  ${pad(r.recall, 22)}  ${r.auth}`,
    );
  }

  L.push("");
  L.push("Provenance:");
  L.push(
    `  reviewgate ${p.reviewgate_version}  ·  corpus ${p.corpus_commit}${p.corpus_dirty ? " (dirty)" : ""}`,
  );
  L.push(
    `  roster: ${p.providers.map((r) => `${r.id}/${r.persona}@${r.cli_version} (${r.model})`).join(", ")}`,
  );
  L.push(
    `  window=${p.window}  cache=${p.cache}  file_context=${p.file_context}  stores=${p.stores}  config_hash=${p.config_hash.slice(0, 12)}`,
  );
  L.push(
    `  phases: critic=${p.phases.critic} reputation=${p.phases.reputation} fp_ledger=${p.phases.fp_ledger} confidence_floor=${p.phases.confidence_floor} scope_to_diff=${p.phases.scope_to_diff}${p.phases.ablations.length ? ` ablations=[${p.phases.ablations.join(",")}]` : ""}`,
  );

  // --- markdown block ---
  const M: string[] = [];
  M.push("### Reviewgate bench — results");
  M.push("");
  if (!auth.ok) {
    M.push(`> ⚠ **Non-authoritative run** — indicative only: ${auth.reasons.join("; ")}.`);
    M.push("");
  }
  M.push("| Metric | Value (num/den, 95% CI) |");
  M.push("| --- | --- |");
  M.push(`| **Clean FP-rate** | ${fmtMetric(result.aggregate.clean_fp_rate)} |`);
  M.push(`| Precision | ${fmtMetric(result.aggregate.precision)} |`);
  M.push(`| Recall | ${fmtMetric(result.aggregate.recall)} |`);
  M.push("");
  if (result.stability) {
    const s = result.stability;
    M.push(`**Stability across ${s.repeats} repeats (mean ± sd, min–max):**`);
    M.push("");
    M.push("| Metric | Across repeats |");
    M.push("| --- | --- |");
    M.push(`| **Clean FP-rate** | ${fmtSpread(s.clean_fp_rate)} |`);
    M.push(`| Precision | ${fmtSpread(s.precision)} |`);
    M.push(`| Recall | ${fmtSpread(s.recall)} |`);
    M.push("");
  }
  M.push("| Provider (RAW) | Coverage | Precision | Recall | Authoritative |");
  M.push("| --- | --- | --- | --- | --- |");
  for (const r of rows) {
    M.push(`| ${r.provider} | ${r.coverage} | ${r.precision} | ${r.recall} | ${r.auth} |`);
  }
  M.push("");
  M.push(
    `_${scoredCases.length} scored cases (${seededScored} seeded, ${cleanScored} clean) · reviewgate ${p.reviewgate_version} · corpus \`${p.corpus_commit}\`${p.corpus_dirty ? " (dirty)" : ""} · window ${p.window} · cache ${p.cache}._`,
  );

  return { table: L.join("\n"), markdown: M.join("\n") };
}
