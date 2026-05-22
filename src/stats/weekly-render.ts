// src/stats/weekly-render.ts
import type { Delta, WeeklyReport } from "./weekly.ts";

function arrow(abs: number): string {
  if (abs > 0) return "▲";
  if (abs < 0) return "▼";
  return "▬";
}

function deltaCell(d: Delta, fmt: (n: number) => string): string {
  const sign = d.abs > 0 ? "+" : "";
  return `${arrow(d.abs)} ${sign}${fmt(d.abs)}`;
}

const num = (n: number): string => `${n}`;
const usd = (n: number): string => `$${n.toFixed(4)}`;
const pp = (n: number): string => `${(n * 100).toFixed(1)}pp`;
const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;

export function renderWeeklyMarkdown(r: WeeklyReport): string {
  const lines: string[] = [];
  lines.push(`# Reviewgate Weekly Report — ${r.week.iso}`);
  const range = `${r.week.since.slice(0, 10)} → ${new Date(new Date(r.week.until).getTime() - 1).toISOString().slice(0, 10)}`;
  const sub = r.previousWeek ? `${range} · vs ${r.previousWeek.iso}` : `${range} · first report`;
  lines.push(`_${sub}_`);
  lines.push("");

  if (r.meta.status === "partial") {
    lines.push(`> ⚠ in progress — week-to-date through ${r.meta.generatedThrough}`);
    lines.push("");
  }

  if (r.current.window.runCount === 0) {
    lines.push(`no runs in ${r.week.iso}.`);
    lines.push("");
    lines.push("_FP-ledger / brain figures reflect current state, not historical week-state._");
    return `${lines.join("\n")}\n`;
  }

  lines.push("## Summary");
  lines.push("");
  if (r.trend) {
    lines.push("| Metric | This week | Prev week | Δ |");
    lines.push("| --- | --- | --- | --- |");
    lines.push(
      `| Runs | ${r.current.window.runCount} | ${r.trend.runCount.previous} | ${deltaCell(r.trend.runCount, num)} |`,
    );
    lines.push(
      `| Cost | ${usd(r.current.cost.total)} | ${usd(r.trend.cost.previous)} | ${deltaCell(r.trend.cost, usd)} |`,
    );
    lines.push(
      `| Escalation rate | ${pct(r.current.escalationRate)} | ${pct(r.trend.escalationRate.previous)} | ${arrow(r.trend.escalationRate.abs)} ${r.trend.escalationRate.abs > 0 ? "+" : ""}${pp(r.trend.escalationRate.abs)} |`,
    );
  } else {
    lines.push("| Metric | This week |");
    lines.push("| --- | --- |");
    lines.push(`| Runs | ${r.current.window.runCount} |`);
    lines.push(`| Cost | ${usd(r.current.cost.total)} |`);
    lines.push(`| Escalation rate | ${pct(r.current.escalationRate)} |`);
  }
  lines.push("");

  lines.push("## Verdicts");
  lines.push("");
  for (const v of ["PASS", "SOFT-PASS", "FAIL", "ERROR"] as const) {
    const count = r.current.verdicts[v];
    if (count === 0 && !(r.trend && r.trend.verdicts[v].previous > 0)) continue;
    const d = r.trend ? `  (${deltaCell(r.trend.verdicts[v], num)})` : "";
    lines.push(`- ${v}: ${count}${d}`);
  }
  lines.push("");

  lines.push("## Reviewers");
  lines.push("");
  if (r.trend && r.trend.providerErrorRate.length > 0) {
    lines.push("| Provider | Error rate | Δ |");
    lines.push("| --- | --- | --- |");
    const cur = new Map(r.current.providers.map((p) => [p.provider, p.errorRate]));
    for (const { provider, delta } of r.trend.providerErrorRate) {
      lines.push(
        `| ${provider} | ${pct(cur.get(provider) ?? 0)} | ${arrow(delta.abs)} ${delta.abs > 0 ? "+" : ""}${pp(delta.abs)} |`,
      );
    }
  } else {
    for (const p of r.current.providers) {
      lines.push(`- ${p.provider}: error rate ${pct(p.errorRate)}, ${p.runs} run(s)`);
    }
  }
  lines.push("");

  lines.push("## Highlights");
  lines.push("");
  const h = r.highlights;
  if (h.newSignatures.length > 0) {
    lines.push("**New signatures this week:**");
    for (const s of h.newSignatures.slice(0, 10)) lines.push(`- ${s.count}× ${s.signature}`);
    lines.push("");
  }
  if (h.topCostProviders.length > 0) {
    lines.push("**Top cost drivers:**");
    for (const c of h.topCostProviders) lines.push(`- ${c.provider}: ${usd(c.cost)}`);
    lines.push("");
  }
  if (h.newFpSignatures.length > 0) {
    lines.push("**New false-positive entries (first seen this week):**");
    for (const f of h.newFpSignatures)
      lines.push(`- [${f.stage}] ${f.signature} (${f.providers.join(", ")})`);
    lines.push("");
  }
  if (h.newBrainEntries.length > 0) {
    lines.push("**New brain memories (created this week):**");
    for (const b of h.newBrainEntries) lines.push(`- [${b.status}/${b.type}] ${b.id}`);
    lines.push("");
  }

  lines.push("_FP-ledger / brain figures reflect current state, not historical week-state._");
  return `${lines.join("\n")}\n`;
}
