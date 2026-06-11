// src/stats/render.ts
import type { StatsReport } from "./aggregate.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function pctOrDash(n: number | null): string {
  return n === null ? "—" : pct(n);
}

function cellLine(c: {
  tp: number;
  fp: number;
  declined: number;
  precision: number | null;
}): string {
  return `${pctOrDash(c.precision)}  (${c.tp} real / ${c.fp} FP · ${c.declined} declined)`;
}

function usd(n: number): string {
  return `$${n.toFixed(4)}`;
}

function ms(n: number): string {
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(1)}s`;
}

function section(title: string): string {
  return `\n── ${title} ${"─".repeat(Math.max(0, 52 - title.length))}\n`;
}

function row(label: string, value: string, width = 22): string {
  return `  ${label.padEnd(width)} ${value}\n`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function renderStats(report: StatsReport): string {
  if (report.window.runCount === 0) {
    return "Reviewgate stats: no review history yet — run a review first.\n";
  }

  const {
    window,
    verdicts,
    escalationRate,
    cost,
    providers,
    topSignatures,
    fpLedger,
    brain,
    precision,
  } = report;

  let out = "";

  // ── Header ────────────────────────────────────────────────────────────────
  out += `Reviewgate stats — ${window.runCount} run(s)`;
  if (window.firstTs && window.lastTs) {
    out += `  (${window.firstTs.slice(0, 10)} → ${window.lastTs.slice(0, 10)})`;
  }
  out += "\n";
  out += row(
    "panel / cache / skipped",
    `${window.bySource.panel} / ${window.bySource.cache} / ${window.bySource.skipped}`,
  );

  // ── Verdicts ──────────────────────────────────────────────────────────────
  out += section("Verdicts");
  const total = window.runCount;
  for (const [v, count] of Object.entries(verdicts) as [string, number][]) {
    if (count === 0) continue;
    out += row(v, `${count}  (${pct(count / total)})`);
  }
  out += row("escalation rate", pct(escalationRate));

  // ── Cost ──────────────────────────────────────────────────────────────────
  out += section("Cost");
  out += row("total", usd(cost.total));
  out += row("avg / panel run", usd(cost.avgPerRun));
  const ppEntries = Object.entries(cost.perProvider).sort(([a], [b]) => (a < b ? -1 : 1));
  if (ppEntries.length > 0) {
    out += "  per-provider:\n";
    for (const [provider, c] of ppEntries) {
      out += row(`  ${provider}`, usd(c));
    }
  }

  // ── Reviewers ─────────────────────────────────────────────────────────────
  out += section("Reviewers");
  if (providers.length === 0) {
    out += "  (no panel runs)\n";
  } else {
    for (const p of providers) {
      out += `  ${p.provider}:\n`;
      out += row("    runs", String(p.runs), 20);
      out += row("    findings", String(p.findings), 20);
      out += row("    demote rate", pct(p.demoteRate), 20);
      out += row("    error rate", pct(p.errorRate), 20);
      out += row("    avg duration", ms(p.avgDurationMs), 20);
      out += row("    cost", usd(p.cost), 20);
    }
  }

  // ── Findings ──────────────────────────────────────────────────────────────
  out += section("Findings");
  out += "  FP-ledger:\n";
  out += row("    active", String(fpLedger.active), 20);
  out += row("    sticky", String(fpLedger.sticky), 20);
  out += row("    candidate", String(fpLedger.candidate), 20);

  const confirmedEntries = Object.entries(fpLedger.perProviderConfirmed).sort(([a], [b]) =>
    a < b ? -1 : 1,
  );
  if (confirmedEntries.length > 0) {
    out += "  confirmed by provider:\n";
    for (const [provider, count] of confirmedEntries) {
      out += row(`    ${provider}`, String(count), 20);
    }
  }

  if (topSignatures.length > 0) {
    out += "  top recurring signatures:\n";
    for (const { signature, count } of topSignatures) {
      out += `    ${count}x  ${signature}\n`;
    }
  }

  // ── Brain ─────────────────────────────────────────────────────────────────
  out += section("Brain");
  const statusEntries = Object.entries(brain.byStatus).sort(([a], [b]) => (a < b ? -1 : 1));
  const typeEntries = Object.entries(brain.byType).sort(([a], [b]) => (a < b ? -1 : 1));

  if (statusEntries.length === 0 && typeEntries.length === 0) {
    out += "  (no brain entries)\n";
  } else {
    if (statusEntries.length > 0) {
      out += "  by status:\n";
      for (const [status, count] of statusEntries) {
        out += row(`    ${status}`, String(count), 20);
      }
    }
    if (typeEntries.length > 0) {
      out += "  by type:\n";
      for (const [type, count] of typeEntries) {
        out += row(`    ${type}`, String(count), 20);
      }
    }
  }

  // ── Precision ───────────────────────────────────────────────────────────────
  out += section("Precision");
  out += row("overall", cellLine(precision.overall));
  out += row("CRITICAL", cellLine(precision.bySeverity.CRITICAL));
  out += row("WARN", cellLine(precision.bySeverity.WARN));
  const provEntries = Object.entries(precision.byProvider).sort(([a], [b]) => (a < b ? -1 : 1));
  if (provEntries.length > 0) {
    out += "  by reviewer:\n";
    for (const [provider, cell] of provEntries) {
      out += row(`    ${provider}`, cellLine(cell), 20);
    }
  }
  out += "  (precision = real / (real + FP), windowed by decision time — a rate, not per-run)\n";

  return out;
}
