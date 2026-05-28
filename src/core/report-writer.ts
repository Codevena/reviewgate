// src/core/report-writer.ts
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Finding } from "../schemas/finding.ts";
import type { PendingReport } from "../schemas/pending-report.ts";
import type { EscalationReason } from "../schemas/state.ts";
import {
  escalationMdPath,
  pendingJsonPath,
  pendingMdPath,
  planReviewJsonPath,
  planReviewMdPath,
} from "../utils/paths.ts";

function ensureDir(p: string): void {
  const d = dirname(p);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

// Visual cue for cross-reviewer consensus, next to the severity marker, so an
// agent skims "is this lone or corroborated?" without reading the metadata line:
// ⚪ singleton/minority (weak signal — scrutinize), 🟡 majority (solid),
// 🟢 unanimous (all reviewers agree — highest confidence).
function consensusEmoji(c: Finding["consensus"]): string {
  if (c === "unanimous") return "🟢";
  if (c === "majority") return "🟡";
  return "⚪"; // singleton or minority
}

// System-side demote/suppression badges. Builds a blockquote line ONLY when at
// least one flag applies — so clean findings render no extra noise. Lets the
// agent see at a glance "the system already flagged this as lower-confidence"
// rather than having to read the JSON to discover it.
function demoteBadges(f: Finding): string | null {
  const badges: string[] = [];
  if (f.scope_demoted) badges.push("📍 outside changed lines");
  if (f.critic_verdict === "likely_fp") badges.push("🧠 critic flagged as likely FP");
  if (f.fp_ledger_match?.suppressed) badges.push("📒 matches known-FP pattern");
  if (f.low_confidence) badges.push("🎯 below confidence floor");
  if (f.reputation_demoted) badges.push("📉 reviewer reputation low");
  return badges.length === 0 ? null : `> ${badges.join("  ·  ")}`;
}

function fmtFinding(f: Finding): string {
  const sym = f.severity === "CRITICAL" ? "●" : f.severity === "WARN" ? "▲" : "·";
  const consEmoji = consensusEmoji(f.consensus);
  const confirmed =
    f.confirmed_by && f.confirmed_by.length > 1
      ? ` (confirmed by ${f.confirmed_by.join(", ")})`
      : "";
  // Show a range (line_start-line_end) for multi-line findings, plain line otherwise.
  const loc = f.line_end > f.line_start ? `${f.line_start}-${f.line_end}` : `${f.line_start}`;
  const badges = demoteBadges(f);
  return [
    `### ${f.id}  ${sym} ${f.severity} ${consEmoji}  ·  ${f.file}:${loc}  ·  ${f.rule_id}`,
    `**Category:** ${f.category}  ·  **Consensus:** ${f.consensus}  ·  **Confidence:** ${f.confidence.toFixed(2)}${confirmed}`,
    ...(badges ? [badges] : []),
    "",
    f.message,
    "",
    f.details,
    f.suggested_fix ? `\n**Suggested fix:**\n\`\`\`\n${f.suggested_fix}\n\`\`\`` : "",
    "",
  ].join("\n");
}

function renderMd(r: PendingReport, mode: "gate" | "one-shot"): string {
  // Coverage warning: any reviewer that didn't finish OK (timeout/error/etc.)
  // reduces how many independent reviewers actually saw this diff. Surface it
  // prominently — a silently degraded panel could let a PASS through with less
  // scrutiny than configured.
  const degraded = r.reviewers.filter((x) => x.status !== "ok");
  // Render the captured stderr reason (one line, trimmed) next to each degraded
  // reviewer so a failure is self-explanatory in the report — without it a bare
  // "gemini: error" forces the agent to go spelunking for WHY (quota? auth? a
  // bad model id?). status_detail is persisted in pending.json but was never
  // shown here before.
  const degradedDetail = (x: PendingReport["reviewers"][number]): string => {
    const reason = x.status_detail
      ?.split("\n")
      .find((l) => l.trim().length > 0)
      ?.trim();
    return reason ? `${x.id}: ${x.status} — ${reason.slice(0, 160)}` : `${x.id}: ${x.status}`;
  };
  const coverageBanner =
    degraded.length > 0
      ? [
          `> ⚠ **Reduced coverage:** ${degraded.length} of ${r.reviewers.length} reviewers did not complete (${degraded
            .map(degradedDetail)
            .join(
              "; ",
            )}). This verdict is based on the ${r.reviewers.length - degraded.length} reviewer(s) that finished.`,
          "",
        ]
      : [];
  const actions =
    mode === "one-shot"
      ? []
      : [
          "## Required actions",
          "",
          `For each CRITICAL/WARN finding below, append ONE line to \`.reviewgate/decisions/${r.iter}.jsonl\` (Advisory findings need NO decision):`,
          '- `{"schema":"reviewgate.decision.v1","finding_id":"F-XYZ","verdict":"accepted","action":"fixed","files_touched":[...]}`',
          '- `{"schema":"reviewgate.decision.v1","finding_id":"F-XYZ","verdict":"rejected","reason":"...","reviewer_was_wrong":true}`',
          "",
          "Reviewgate refuses to unblock until every CRITICAL/WARN finding ID has a decision.",
          "",
        ];
  const head = [
    `# Reviewgate Report — iteration ${r.iter} of ${r.max_iter}`,
    "",
    `**Verdict:** ${r.verdict}  ·  ${r.counts.critical} CRITICAL · ${r.counts.warn} WARN · ${r.counts.info} INFO`,
    `**Reviewers:** ${r.reviewers.map((x) => `${x.id} (${x.status})`).join(" · ")}`,
    `**Cost:** $${r.cost_usd_total.toFixed(2)}  ·  **Duration:** ${(r.duration_ms_total / 1000).toFixed(1)}s  ·  **Git:** ${r.git.branch}@${r.git.sha.slice(0, 7)}`,
    "",
    ...coverageBanner,
    ...(r.panel_note ? [`> ⛔ **Panel:** ${r.panel_note}`, ""] : []),
    ...actions,
    "---",
    "",
  ].join("\n");

  // Advisory = INFO, or anything the aggregator demoted (scope_demoted) / the
  // FP-ledger suppressed. These need no decision (the decisions-gate ignores
  // them); render them in a separate section so the agent doesn't re-reject them.
  const isAdvisory = (f: Finding) =>
    f.severity === "INFO" || f.scope_demoted === true || f.fp_ledger_match?.suppressed === true;
  const blocking = r.findings.filter((f) => !isAdvisory(f));
  const advisory = r.findings.filter(isAdvisory);

  const sections: string[] = [];
  const crit = blocking.filter((f) => f.severity === "CRITICAL");
  const warn = blocking.filter((f) => f.severity === "WARN");
  if (crit.length > 0) sections.push("## CRITICAL ●\n", ...crit.map(fmtFinding));
  if (warn.length > 0) sections.push("## WARN ▲\n", ...warn.map(fmtFinding));
  if (advisory.length > 0) {
    sections.push(
      "## Advisory (out of scope / known FP — no decision needed) ·\n",
      ...advisory.map(fmtFinding),
    );
  }

  return head + sections.join("\n");
}

export interface EscalationInput {
  runId: string;
  iter: number;
  maxIter: number;
  reasonCode: EscalationReason;
  summary: string;
  perIter: Array<{
    iter: number;
    verdict: string;
    crit: number;
    warn: number;
    costUsd: number;
    findings: number;
  }>;
  topFindings: Finding[];
  triggeredAt: string;
}

export class ReportWriter {
  constructor(private readonly repoRoot: string) {}

  async write(report: PendingReport, opts?: { mode?: "gate" | "one-shot" }): Promise<void> {
    const mode = opts?.mode ?? "gate";
    // One-shot reviews write to their OWN files so they never clobber the gate's
    // pending.md/json (which the Stop-hook decisions loop reads).
    const md = mode === "one-shot" ? planReviewMdPath(this.repoRoot) : pendingMdPath(this.repoRoot);
    const json =
      mode === "one-shot" ? planReviewJsonPath(this.repoRoot) : pendingJsonPath(this.repoRoot);
    ensureDir(md);
    writeFileSync(md, renderMd(report, mode), { mode: 0o600 });
    writeFileSync(json, JSON.stringify(report, null, 2), { mode: 0o600 });
  }

  async writeEscalation(input: EscalationInput): Promise<void> {
    const p = escalationMdPath(this.repoRoot);
    ensureDir(p);
    const rows = input.perIter
      .map(
        (r) =>
          `| ${r.iter}    | ${r.verdict.padEnd(4)}    | ${r.crit}    | ${r.warn}    | $${r.costUsd.toFixed(2).padStart(5)} | ${r.findings}        |`,
      )
      .join("\n");
    const top = input.topFindings.slice(0, 5).map(fmtFinding).join("\n");
    const out = [
      "# Reviewgate Escalation",
      "",
      `**Session:** ${input.runId}  ·  **Iteration:** ${input.iter}/${input.maxIter}  ·  **Verdict:** ESCALATED`,
      `**Reason code:** ${input.reasonCode}`,
      `**Triggered at:** ${input.triggeredAt}`,
      "",
      "## Summary",
      input.summary,
      "",
      "## Final findings (last iteration)",
      top,
      "",
      "## Per-iteration history",
      "| Iter | Verdict | CRIT | WARN | Cost   | Findings |",
      "|------|---------|------|------|--------|----------|",
      rows,
      "",
      "## Suggested human actions",
      "- Review the listed findings yourself before committing.",
      "- If a finding is genuinely a false positive, run `reviewgate fp pin <signature>`.",
      "- If the panel diverges from your intent systematically, run `reviewgate config edit`.",
    ].join("\n");
    writeFileSync(p, out, { mode: 0o600 });
  }
}
