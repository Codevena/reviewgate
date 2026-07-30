// src/rig/report.ts
// Render a `RigResult` as a terminal table plus a paste-ready markdown block, mirroring
// `bench report` so the two measurement systems read alike.
//
// This file is where the honesty rules stop being a policy in a plan document and become
// something a reader cannot skip. Three of them are structural, not stylistic:
//
//  * **No rate without its raw denominator and CI.** `fmtMetric` is imported from bench
//    rather than reimplemented, so "0.80" can never appear here without "(4/5, 95% CI …)".
//    At this rig's size one turn moves recall by 0.2.
//  * **The M2 slope never appears without its n**, and reads `insufficient data (n=k)` below
//    the floor. It is the headline claim and simultaneously the weakest number at pilot size.
//  * **The limitations travel with the numbers**, in the same block, because the markdown is
//    written to be pasted somewhere else — and whatever is not in it will not be pasted.
import { fmtMetric, fmtSpread } from "../bench/report.ts";
import type { RigResult, RigTurnRecord } from "../schemas/rig-result.ts";

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function padStart(s: string, n: number): string {
  return s.length >= n ? s : " ".repeat(n - s.length) + s;
}

/** `-0.0833/turn (n=7)`, or `insufficient data (n=2)` below the reporting floor. */
function fmtSlope(slope: number | null, n: number): string {
  if (slope === null) return `insufficient data (n=${n})`;
  return `${slope.toFixed(4)}/turn (n=${n})`;
}

/**
 * `null` FP burden renders `n/a`, never `0.00`.
 *
 * A zero-finding turn has no FP burden to measure. Printing `0.00` would read as "no false
 * positives on a turn that had findings" — a different and flattering claim — and a reader
 * averaging the column by eye would fold it in.
 */
function fmtBurden(v: number | null): string {
  return v === null ? "n/a" : v.toFixed(2);
}

/** `yes` / `no` for a seeded turn; `n/a` for a clean one, which has nothing to catch. */
function fmtTriState(v: boolean | null): string {
  if (v === null) return "n/a";
  return v ? "yes" : "no";
}

interface Row {
  turn: string;
  seeded: string;
  iters: string;
  findings: string;
  blocking: string;
  fp: string;
  burden: string;
  caught: string;
  escaped: string;
  cost: string;
}

function toRow(t: RigTurnRecord): Row {
  return {
    turn: String(t.index),
    seeded: t.seededId ?? "—",
    iters: String(t.iterations),
    findings: String(t.findingsTotal),
    blocking: String(t.blockingTotal),
    fp: String(t.rejectedAsFp),
    burden: fmtBurden(t.fpBurden),
    caught: fmtTriState(t.caught),
    escaped: fmtTriState(t.escaped),
    cost: `$${t.costUsd.toFixed(4)}`,
  };
}

/**
 * The limitation paragraph, copied verbatim from the plan's architecture section on purpose.
 * The ablation toggles the AGGREGATION layer against fixed reviewer output; it cannot re-drive
 * the agent, because different verdicts would produce different diffs and no recording of one
 * run can answer what an agent would have done in a run that never happened.
 */
const LIMITATIONS = [
  "Every rate carries its raw numerator/denominator and a Wilson 95% CI. At this size a single turn moves recall substantially — the rig detects SIGNAL, it does not establish effect size.",
  "The M2 slope is ONE run. A slope from one run is a hypothesis, not a result; a second independent run (or `--repeat`) is what would confirm it.",
  "Any ablation over this result is an AGGREGATION-LAYER counterfactual, not a behavioural A/B: it answers what the suppression stack would have emitted from these same findings. It cannot re-drive the agent.",
  "The panel is named below. A different panel is a different system, and the numbers are not comparable across panels.",
];

export function renderRigReport(result: RigResult): { table: string; markdown: string } {
  const p = result.provenance;
  const m = result.metrics;
  const rows = result.turns.map(toRow);
  const scale = `${p.turn_count.harvested} turn(s) harvested of ${p.turn_count.script_total} in script \`${p.script_id}\` · ${p.turn_count.seeded} seeded, ${p.turn_count.clean} clean`;
  const panel = p.panel.map((r) => `${r.provider}/${r.persona} (${r.model})`).join(", ");
  const sup = m.suppression;
  const supLine = `critic ${sup.critic} · reputation ${sup.reputation} · fp-ledger ${sup.fp_ledger} · lore ${sup.lore} (lore = findings EMITTED; lore never demotes)`;

  // --- terminal table ---
  const L: string[] = [];
  L.push("Reviewgate rig report");
  L.push("=====================");
  // Warnings FIRST: a skipped turn or a failed agent changes how every number below must be
  // read, so it cannot sit under them.
  if (result.warnings.length > 0) {
    L.push("");
    L.push(`⚠ ${result.warnings.length} warning(s) — read the numbers below in their light:`);
    for (const w of result.warnings) L.push(`  · ${w}`);
  }
  L.push("");
  L.push(`Scale: ${scale.replace(/`/g, "")}`);
  L.push("");
  L.push("Headline:");
  L.push(`  M3 recall (caught in its own turn) : ${fmtMetric(m.recall)}`);
  L.push(`  M4 escape rate (never flagged)     : ${fmtMetric(m.escapeRate)}`);
  L.push(
    `  M2 FP-burden slope                 : ${fmtSlope(m.fpBurdenSlope.slope, m.fpBurdenSlope.n)}`,
  );
  L.push(
    `  M1 iterations to allow-stop        : median ${m.iterations.median ?? "n/a"} · ${fmtSpread(m.iterations.spread)} over ${m.iterations.spread.samples} reviewed turn(s)`,
  );
  L.push(
    `  M5 cost                            : $${m.cost.totalUsd.toFixed(4)} total · per reviewed turn ${fmtSpread(m.cost.perTurnUsd)} · ${(m.cost.totalDurationMs / 1000).toFixed(1)}s of gate time`,
  );
  L.push(`  M6 suppression provenance          : ${supLine}`);
  L.push("");
  L.push("Per turn:");
  const w = {
    turn: Math.max(4, ...rows.map((r) => r.turn.length)),
    seeded: Math.max(6, ...rows.map((r) => r.seeded.length)),
    iters: 5,
    findings: 8,
    blocking: 8,
    fp: 6,
    burden: 6,
    caught: 6,
    escaped: 7,
    cost: 9,
  };
  L.push(
    `  ${pad("turn", w.turn)}  ${pad("seeded", w.seeded)}  ${padStart("iters", w.iters)}  ${padStart("findings", w.findings)}  ${padStart("blocking", w.blocking)}  ${padStart("fp", w.fp)}  ${padStart("burden", w.burden)}  ${padStart("caught", w.caught)}  ${padStart("escaped", w.escaped)}  ${padStart("cost", w.cost)}`,
  );
  for (const r of rows) {
    L.push(
      `  ${pad(r.turn, w.turn)}  ${pad(r.seeded, w.seeded)}  ${padStart(r.iters, w.iters)}  ${padStart(r.findings, w.findings)}  ${padStart(r.blocking, w.blocking)}  ${padStart(r.fp, w.fp)}  ${padStart(r.burden, w.burden)}  ${padStart(r.caught, w.caught)}  ${padStart(r.escaped, w.escaped)}  ${padStart(r.cost, w.cost)}`,
    );
  }
  L.push("");
  L.push("Provenance:");
  L.push(
    `  reviewgate ${p.reviewgate_version}  ·  run ${p.run_id}  ·  harvested ${p.harvested_at}`,
  );
  L.push(`  panel: ${panel}`);
  L.push(`  script ${p.script_path}  ·  manifest ${p.manifest_path}  ·  host ${p.host_os}`);
  L.push("");
  L.push("Read this with:");
  for (const l of LIMITATIONS) L.push(`  · ${l}`);

  // --- markdown block ---
  const M: string[] = [];
  M.push("### Reviewgate rig — longitudinal result");
  M.push("");
  if (result.warnings.length > 0) {
    M.push(
      `> ⚠ **${result.warnings.length} warning(s)** — the numbers below must be read with these:`,
    );
    M.push(">");
    for (const wn of result.warnings) M.push(`> - ${wn}`);
    M.push("");
  }
  M.push(`**Scale:** ${scale}`);
  M.push("");
  M.push("| Metric | Value |");
  M.push("| --- | --- |");
  M.push(`| **M3 recall** (caught in its own turn) | ${fmtMetric(m.recall)} |`);
  M.push(`| **M4 escape rate** (never flagged) | ${fmtMetric(m.escapeRate)} |`);
  M.push(`| **M2 FP-burden slope** | ${fmtSlope(m.fpBurdenSlope.slope, m.fpBurdenSlope.n)} |`);
  M.push(
    `| M1 iterations to allow-stop | median ${m.iterations.median ?? "n/a"} · ${fmtSpread(m.iterations.spread)} over ${m.iterations.spread.samples} reviewed turn(s) |`,
  );
  M.push(
    `| M5 cost | $${m.cost.totalUsd.toFixed(4)} total · per reviewed turn ${fmtSpread(m.cost.perTurnUsd)} |`,
  );
  M.push(`| M6 suppression provenance | ${supLine} |`);
  M.push("");
  M.push(
    "| Turn | Seeded | Iters | Findings | Blocking | FP rejects | FP burden | Caught | Escaped | Cost |",
  );
  M.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of rows) {
    M.push(
      `| ${r.turn} | ${r.seeded} | ${r.iters} | ${r.findings} | ${r.blocking} | ${r.fp} | ${r.burden} | ${r.caught} | ${r.escaped} | ${r.cost} |`,
    );
  }
  M.push("");
  M.push(`_Panel: ${panel} · reviewgate ${p.reviewgate_version} · run \`${p.run_id}\`._`);
  M.push("");
  M.push("**Read this with:**");
  M.push("");
  for (const l of LIMITATIONS) M.push(`- ${l}`);

  return { table: `${L.join("\n")}\n`, markdown: `${M.join("\n")}\n` };
}
