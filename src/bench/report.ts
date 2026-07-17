// reviewgate bench — report renderer (spec §5.2/§6).
//
// Turns a saved BenchResult into (a) a terminal table for eyeballing and (b) a
// paste-ready markdown block for the README / a blog post. It LEADS with the Clean
// FP-rate — the number competitors hide and the one the suppression stack is built
// to win — and reports every rate with its raw num/den and Wilson CI so a smoke-N
// figure is never over-read. A run that isn't trustworthy (dirty corpus, invalid
// cases, or no clean/seeded cases) is flagged non-authoritative and its headline
// framing withheld, mirroring `bench run`'s exit-4 gate. Pure, no I/O.

import type {
  BenchMatrix,
  BenchResult,
  CaseResult,
  Metric,
  SpreadStat,
} from "../schemas/bench-result.ts";

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
  const integrity = result.provenance.integrity;
  if (integrity?.authoritative_requested) {
    if (!/^[0-9a-f]{40}$/i.test(integrity.source_commit)) {
      reasons.push("source commit is not a full Git commit");
    }
    if (integrity.repository_dirty) reasons.push("repository was dirty");
    if (integrity.runner_kind !== "compiled" || !/^[0-9a-f]{64}$/i.test(integrity.runner_sha256)) {
      reasons.push("runner was not a hashed compiled binary");
    }
    if (!integrity.preregistration_sha256) reasons.push("committed preregistration is missing");
    if (integrity.max_provider_calls === null || integrity.max_output_tokens === null) {
      reasons.push("provider-call/output bounds are missing");
    }
    if (
      integrity.max_provider_calls !== null &&
      integrity.provider_calls_used > integrity.max_provider_calls
    ) {
      reasons.push("provider-call ceiling was exceeded");
    }
    for (const provider of result.providers) {
      if (provider.coverage.value !== 1 || !provider.authoritative) {
        reasons.push(`reviewer ${provider.provider} did not reach 100% coverage`);
      }
    }
    if (result.provenance.critic) {
      if (
        !result.critic ||
        result.critic.eligible === 0 ||
        result.critic.ran !== result.critic.eligible ||
        !result.critic.authoritative
      ) {
        reasons.push("critic did not reach 100% eligible-call coverage");
      }
    }
  }
  // The runner-stamped verdict is DEMOTE-ONLY here: a stamped non-authoritative
  // verdict is honored (the runner's gate knows run-time reasons like panel
  // coverage that re-derivation cannot see) and its reasons folded in, but a
  // stamped authoritative:true NEVER bypasses a failing signal above — a forged
  // or buggy stamp cannot elevate trust. Absent verdict → pure re-derivation.
  if (result.verdict && !result.verdict.authoritative) {
    const merged = [...new Set([...reasons, ...result.verdict.reasons])];
    return { ok: false, reasons: merged };
  }
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
  if (p.case_run_count) {
    L.push(
      `Unique cases: ${p.case_count.seeded + p.case_count.clean} · correlated case-runs: ${p.case_run_count.total}`,
    );
  }
  if (result.critic) {
    L.push(
      `Critic coverage: ${result.critic.ran}/${result.critic.eligible} eligible (${result.critic.authoritative ? "complete" : "incomplete"})`,
    );
  }

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
  if (p.integrity) {
    L.push(
      `  source=${p.integrity.source_commit} runner=${p.integrity.runner_sha256.slice(0, 12)} (${p.integrity.runner_kind}) calls=${p.integrity.provider_calls_used}/${p.integrity.max_provider_calls ?? "unbounded"}`,
    );
  }

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
  if (p.case_run_count) {
    M.push("");
    M.push(
      `_${p.case_count.seeded + p.case_count.clean} unique cases; ${p.case_run_count.total} correlated case-runs across ${p.repeat} repeat(s)._`,
    );
  }

  return { table: L.join("\n"), markdown: M.join("\n") };
}

/** `+0.35` / `-0.75` / ` 0.00` — signed 2-decimal delta. */
function fmtDelta(d: number): string {
  const s = d.toFixed(2);
  return d > 0 ? `+${s}` : s;
}

/** Point value of a metric for the compact matrix table (`n/a` when undefined). */
function fmtPoint(m: Metric): string {
  return m.value === null ? "n/a" : m.value.toFixed(2);
}

/**
 * Render the ablation matrix (spec §8): baseline (full suppression) + one row per
 * ablated layer, with the per-layer Δ (baseline − ablated). Positive Δprecision /
 * Δrecall ⇒ the layer HELPS; for clean-FP a NEGATIVE Δ ⇒ the layer REDUCES false
 * positives (baseline is lower). Returns a terminal block + a markdown block.
 */
export function renderBenchMatrix(matrix: BenchMatrix): string {
  const p = matrix.provenance;
  const L: string[] = [];
  L.push("Reviewgate bench matrix — ablation (baseline = full suppression)");
  L.push("================================================================");
  L.push(
    `roster: ${p.providers.map((r) => r.id).join(", ")}  ·  repeat ${p.repeat}  ·  corpus ${p.corpus_commit}${p.corpus_dirty ? " (dirty)" : ""}`,
  );
  L.push("");
  const head = `  ${pad("variant", 16)} ${pad("class", 6)} ${pad("precision", 10)} ${pad("recall", 8)} ${pad("clean-FP", 9)}  ${pad("Δprec", 7)} ${pad("Δrecall", 8)} Δcleanfp`;
  L.push(head);
  for (const v of matrix.variants) {
    const d = v.delta;
    L.push(
      `  ${pad(v.label, 16)} ${pad(v.class === "baseline" ? "—" : v.class, 6)} ${pad(fmtPoint(v.precision), 10)} ${pad(fmtPoint(v.recall), 8)} ${pad(fmtPoint(v.clean_fp_rate), 9)}  ${pad(d ? fmtDelta(d.precision) : "—", 7)} ${pad(d ? fmtDelta(d.recall) : "—", 8)} ${d ? fmtDelta(d.clean_fp_rate) : "—"}`,
    );
  }
  L.push("");
  L.push(
    "Δ = baseline − ablated. precision/recall: + ⇒ the layer helps. clean-FP: − ⇒ the layer reduces false positives.",
  );

  const M: string[] = [];
  M.push("### Reviewgate bench — ablation matrix");
  M.push("");
  M.push("| variant | class | precision | recall | clean-FP | Δprec | Δrecall | Δclean-FP |");
  M.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const v of matrix.variants) {
    const d = v.delta;
    M.push(
      `| ${v.label} | ${v.class === "baseline" ? "—" : v.class} | ${fmtPoint(v.precision)} | ${fmtPoint(v.recall)} | ${fmtPoint(v.clean_fp_rate)} | ${d ? fmtDelta(d.precision) : "—"} | ${d ? fmtDelta(d.recall) : "—"} | ${d ? fmtDelta(d.clean_fp_rate) : "—"} |`,
    );
  }
  M.push("");
  M.push(
    "_Δ = baseline − ablated · precision/recall: + ⇒ layer helps · clean-FP: − ⇒ layer reduces FPs._",
  );

  return `${L.join("\n")}\n\n${M.join("\n")}`;
}
